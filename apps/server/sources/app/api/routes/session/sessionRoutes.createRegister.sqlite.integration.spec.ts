import { randomUUID } from "node:crypto";

import Fastify from "fastify";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { serializerCompiler, validatorCompiler, ZodTypeProvider } from "fastify-type-provider-zod";

import { auth } from "@/app/auth/auth";
import { enableAuthentication } from "@/app/api/utils/enableAuthentication";
import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { authorizeSessionScopedMachineBinding } from "../../socket/sessionRelayAuthCache";
import { createAppCloseTracker } from "../../testkit/appLifecycle";
import { sessionRoutes } from "./sessionRoutes";

const { trackApp, closeTrackedApps } = createAppCloseTracker();

function createTestApp() {
    const app = Fastify({ logger: false });
    app.setValidatorCompiler(validatorCompiler);
    app.setSerializerCompiler(serializerCompiler);
    // Test-boundary bridge: route helpers use the app-local Fastify alias with auth decorations.
    const typed = app.withTypeProvider<ZodTypeProvider>() as any;
    enableAuthentication(typed);
    sessionRoutes(typed);
    return trackApp(typed);
}

describe("session create/load before publisher registration (SQLite integration)", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-session-create-register-sqlite-",
            initAuth: true,
            initEncrypt: true,
        });
    }, 120_000);

    afterEach(async () => {
        await closeTrackedApps();
        harness.resetEnv();
        await db.accessKey.deleteMany();
        await db.machine.deleteMany();
        await db.session.deleteMany();
        await db.account.deleteMany();
    });

    afterAll(async () => {
        await harness.close();
    });

    it("keeps a created row inactive through a rejected socket and makes exact registration the sole positive transition", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `create-register-${randomUUID()}`;

        const createdResponse = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { tag, metadata: "{}", encryptionMode: "e2ee" },
        });

        expect(createdResponse.statusCode).toBe(200);
        const created = createdResponse.json();
        expect(created).toMatchObject({
            resolution: "created",
            session: {
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0,
            },
        });
        const sessionId = created.session.id as string;

        const beforeRegistration = await db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        });
        expect(beforeRegistration).toMatchObject({
            active: false,
            runtimeActivityState: "unknown",
            runtimeActivityActiveCount: 0,
            runtimeActivityRevision: 0n,
        });

        const listBeforeRegistration = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(listBeforeRegistration.statusCode).toBe(200);
        expect(listBeforeRegistration.json()).toMatchObject({
            sessions: [expect.objectContaining({
                id: sessionId,
                active: false,
                runtimeActivityState: "unknown",
            })],
        });

        const presence = createSessionPublisherPresence();
        const socket = {};
        await expect(presence.resolveCurrentPublisher({
            socket,
            binding: { accountId: account.id, machineId: `unregistered-${randomUUID()}`, sessionId },
        })).resolves.toEqual({ status: "unregistered" });
        await expect(presence.registerPublisher({
            socket,
            binding: { accountId: account.id, machineId: `missing-${randomUUID()}`, sessionId },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        })).resolves.toEqual({ status: "rejected", reason: "unauthorized" });
        await expect(db.session.findUniqueOrThrow({
            where: { id: sessionId },
            select: {
                active: true,
                lastActiveAt: true,
                runtimeActivityState: true,
                runtimeActivityActiveCount: true,
                runtimeActivityRevision: true,
            },
        })).resolves.toEqual(beforeRegistration);

        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({ data: { id: machineId, accountId: account.id, metadata: "{}" } });
        await db.accessKey.create({
            data: { accountId: account.id, machineId, sessionId, data: "encrypted" },
        });
        const registered = await presence.registerPublisher({
            socket,
            binding: { accountId: account.id, machineId, sessionId },
            completeActivitySnapshot: { state: "idle", activeCount: 0 },
        });
        expect(registered.status).toBe("registered");
        if (registered.status !== "registered") throw new Error("expected exact publisher registration");
        expect(registered.committedFence.getTime()).toBeGreaterThan(beforeRegistration.lastActiveAt.getTime());
        await expect(presence.resolveCurrentPublisher({
            socket,
            binding: { accountId: account.id, machineId, sessionId },
        })).resolves.toMatchObject({ status: "current" });

        const listAfterRegistration = await app.inject({
            method: "GET",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
        });
        expect(listAfterRegistration.statusCode).toBe(200);
        expect(listAfterRegistration.json()).toMatchObject({
            sessions: [expect.objectContaining({
                id: sessionId,
                active: true,
                activeAt: registered.committedFence.getTime(),
                runtimeActivityState: "idle",
            })],
        });
    }, 120_000);

    it("authorizes shared admins for archive and HTTP deletion without widening view, edit or revoked access", async () => {
        const app = createTestApp();
        const accounts = await Promise.all(["owner", "admin", "view", "edit", "revoked", "outsider"].map(async (role) => {
            const account = await db.account.create({ data: { publicKey: `${role}-${randomUUID()}` } });
            return { ...account, headers: { authorization: `Bearer ${await auth.createToken(account.id)}` } };
        }));
        const [owner, admin, viewer, editor, revoked, outsider] = accounts;
        const created = await app.inject({ method: "POST", url: "/v1/sessions", headers: owner.headers,
            payload: { tag: randomUUID(), metadata: "{}", encryptionMode: "e2ee" } });
        expect(created.statusCode).toBe(200);
        const createdBody: { session: { id: string } } = created.json();
        const sessionId = createdBody.session.id;
        for (const [recipient, accessLevel] of [[admin, "admin"], [viewer, "view"], [editor, "edit"], [revoked, "admin"]] as const) {
            await db.sessionShare.create({ data: { sessionId, sharedByUserId: owner.id, sharedWithUserId: recipient.id, accessLevel } });
        }
        await db.sessionShare.delete({ where: { sessionId_sharedWithUserId: { sessionId, sharedWithUserId: revoked.id } } });
        const beforeDenials = await db.accountChange.findMany();
        for (const recipient of [viewer, editor, revoked, outsider]) {
            expect((await app.inject({ method: "POST", url: `/v2/sessions/${sessionId}/archive`, headers: recipient.headers })).statusCode).toBe(403);
            expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}`, headers: recipient.headers })).statusCode).toBe(404);
        }
        expect((await app.inject({ method: "DELETE", url: `/v1/sessions/missing-${randomUUID()}`, headers: admin.headers })).statusCode).toBe(404);
        expect(await db.accountChange.findMany()).toEqual(beforeDenials);
        expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ archivedAt: null });

        const machineId = randomUUID();
        await db.machine.create({ data: { id: machineId, accountId: owner.id, metadata: "{}" } });
        await db.accessKey.create({ data: { accountId: owner.id, machineId, sessionId, data: "encrypted-binding" } });
        const binding = { accountId: owner.id, machineId, sessionId };
        expect((await authorizeSessionScopedMachineBinding(binding))?.slice().sort()).toEqual([owner.id, admin.id, viewer.id, editor.id].sort());
        const archived = await app.inject({ method: "POST", url: `/v2/sessions/${sessionId}/archive`, headers: admin.headers });
        expect(archived.statusCode).toBe(200);
        expect(await db.session.findUniqueOrThrow({ where: { id: sessionId } })).toMatchObject({ archivedAt: expect.any(Date) });
        expect((await app.inject({ method: "POST", url: `/v2/sessions/${sessionId}/unarchive`, headers: admin.headers })).statusCode).toBe(200);
        const beforeDelete = await db.accountChange.findMany({ where: { kind: "session", entityId: sessionId } });
        const deleted = await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}`, headers: admin.headers });
        expect(deleted.statusCode, deleted.body).toBe(200);
        expect(deleted.json()).toEqual({ success: true });
        expect(await db.session.findUnique({ where: { id: sessionId } })).toBeNull();
        expect(await db.sessionShare.count({ where: { sessionId } })).toBe(0);
        expect(await db.accessKey.count({ where: { sessionId } })).toBe(0);
        expect(await authorizeSessionScopedMachineBinding(binding)).toBeNull();
        const changes = await db.accountChange.findMany({ where: { kind: "session", entityId: sessionId } });
        expect(changes.map((change) => change.accountId).sort()).toEqual([owner.id, admin.id, viewer.id, editor.id].sort());
        for (const change of changes) {
            expect(change.cursor).toBeGreaterThan(beforeDelete.find((previous) => previous.accountId === change.accountId)!.cursor);
        }
        expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${sessionId}`, headers: admin.headers })).statusCode).toBe(404);
        const owned = await db.session.create({ data: { accountId: owner.id, tag: randomUUID(), metadata: "{}" } });
        expect((await app.inject({ method: "DELETE", url: `/v1/sessions/${owned.id}`, headers: owner.headers })).statusCode).toBe(200);
    });

    it("clears archive intent on load without asserting reachability or replacing the publisher fence", async () => {
        const app = createTestApp();
        const account = await db.account.create({ data: { publicKey: `pk-${randomUUID()}` } });
        const token = await auth.createToken(account.id);
        const tag = `archived-load-${randomUUID()}`;
        const publisherFence = new Date("2026-07-15T08:00:00.000Z");
        const archivedAt = new Date("2026-07-15T09:00:00.000Z");
        const previousMeaningfulActivityAt = new Date("2026-07-15T07:00:00.000Z");
        const session = await db.session.create({
            data: {
                accountId: account.id,
                tag,
                metadata: "{}",
                active: false,
                lastActiveAt: publisherFence,
                archivedAt,
                meaningfulActivityAt: previousMeaningfulActivityAt,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 4n,
            },
        });

        const loadedResponse = await app.inject({
            method: "POST",
            url: "/v1/sessions",
            headers: { authorization: `Bearer ${token}` },
            payload: { tag, metadata: "ignored-for-existing", encryptionMode: "e2ee" },
        });

        expect(loadedResponse.statusCode).toBe(200);
        expect(loadedResponse.json()).toMatchObject({
            resolution: "existing",
            session: {
                id: session.id,
                active: false,
                activeAt: publisherFence.getTime(),
                runtimeActivityState: "unknown",
                runtimeActivityRevision: 4,
            },
        });
        const stored = await db.session.findUniqueOrThrow({
            where: { id: session.id },
            select: {
                active: true,
                archivedAt: true,
                lastActiveAt: true,
                meaningfulActivityAt: true,
                runtimeActivityState: true,
                runtimeActivityRevision: true,
            },
        });
        expect(stored).toMatchObject({
            active: false,
            archivedAt: null,
            lastActiveAt: publisherFence,
            runtimeActivityState: "unknown",
            runtimeActivityRevision: 4n,
        });
        if (stored.meaningfulActivityAt === null) {
            throw new Error("expected load to retain a meaningful activity timestamp");
        }
        expect(stored.meaningfulActivityAt.getTime()).toBeGreaterThan(previousMeaningfulActivityAt.getTime());
    }, 120_000);
});
