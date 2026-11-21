import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Server, Socket } from "socket.io";

import { RPC_METHODS } from "@happier-dev/protocol/rpc";
import { SOCKET_RPC_EVENTS } from "@happier-dev/protocol/socketRpc";

import { createSessionPublisherPresence } from "@/app/presence/sessionPublisherPresence";
import { db } from "@/storage/db";
import { createLightSqliteHarness, type LightSqliteHarness } from "@/testkit/lightSqliteHarness";

import { createFakeSocket, triggerSocketHandler } from "../testkit/socketHarness";
import { rpcHandler } from "./rpcHandler";
import { resolveSessionScopedSocketBinding } from "./sessionScopedBinding";

describe("explicit machine stop RPC on SQLite", () => {
    let harness: LightSqliteHarness;

    beforeAll(async () => {
        harness = await createLightSqliteHarness({
            tempDirPrefix: "happier-explicit-stop-rpc-",
            initAuth: false,
            initEncrypt: false,
            initFiles: false,
        });
    });
    beforeEach(() => harness.resetEnv());
    afterAll(async () => await harness.close());

    async function seed() {
        const owner = await db.account.create({
            data: { publicKey: `pk-${randomUUID()}` },
            select: { id: true },
        });
        const machineId = `machine-${randomUUID()}`;
        await db.machine.create({
            data: { id: machineId, accountId: owner.id, metadata: "{}" },
        });
        const session = await db.session.create({
            data: {
                accountId: owner.id,
                tag: `session-${randomUUID()}`,
                metadata: "{}",
                active: false,
                runtimeActivityState: "unknown",
                runtimeActivityActiveCount: 0,
                runtimeActivityRevision: 0n,
            },
            select: { id: true },
        });
        await db.accessKey.create({
            data: { accountId: owner.id, machineId, sessionId: session.id, data: "encrypted" },
        });
        const presence = createSessionPublisherPresence();
        const registered = await presence.registerPublisher({
            socket: {},
            binding: { accountId: owner.id, machineId, sessionId: session.id },
            completeActivitySnapshot: { state: "active", activeCount: 1 },
        });
        if (registered.status !== "registered") throw new Error("expected publisher registration");
        return { owner, machineId, session, presence };
    }

    async function callStop(params: Readonly<{
        targetResponse: unknown;
        beforeResponse?: () => Promise<void>;
        sharedAccess?: "admin" | "edit" | "view" | "revoked";
        method?: "killSession" | "arbitrary-machine-rpc";
        omitAuthorization?: boolean;
        mismatchedMachine?: boolean;
        revokeAfterCapture?: "share" | "machine-binding";
        revokeBeforeCall?: "machine" | "machine-binding";
    }>) {
        const seeded = await seed();
        let callerId = seeded.owner.id;
        if (params.sharedAccess) {
            const recipient = await db.account.create({ data: { publicKey: `recipient-${randomUUID()}` } });
            callerId = recipient.id;
            if (params.sharedAccess !== "revoked") {
                await db.sessionShare.create({ data: { sessionId: seeded.session.id, sharedByUserId: seeded.owner.id,
                    sharedWithUserId: callerId, accessLevel: params.sharedAccess } });
            }
        }
        const requestedMachineId = params.mismatchedMachine ? `machine-${randomUUID()}` : seeded.machineId;
        if (params.mismatchedMachine) await db.machine.create({ data: { id: requestedMachineId, accountId: seeded.owner.id, metadata: "{}" } });
        const method = params.method === "killSession" ? `${seeded.session.id}:${RPC_METHODS.KILL_SESSION}`
            : `${requestedMachineId}:${params.method ?? RPC_METHODS.STOP_SESSION}`;
        const targetEmitWithAck = vi.fn(async () => {
            await params.beforeResponse?.();
            if (params.method === "killSession") return params.targetResponse;
            const isStopped = (
                params.targetResponse
                && typeof params.targetResponse === "object"
                && !Array.isArray(params.targetResponse)
                && (params.targetResponse as { status?: unknown }).status === "stopped"
            );
            return {
                v: 1,
                result: params.targetResponse,
                ...(isStopped
                    ? { acknowledgement: { kind: "session.stop", status: "stopped" } }
                    : {}),
            };
        });
        const binding = await resolveSessionScopedSocketBinding({ userId: seeded.owner.id, sessionId: seeded.session.id, machineId: seeded.machineId });
        if (!binding.ok) throw new Error("expected current runner binding");
        const target = createFakeSocket({
            id: "target-socket",
            data: params.method === "killSession" ? { clientType: "session-scoped", sessionId: seeded.session.id,
                machineId: seeded.machineId, sessionScopedBinding: binding.binding }
                : { clientType: "machine-scoped", machineId: requestedMachineId },
            timeout: vi.fn(() => ({ emitWithAck: targetEmitWithAck })),
        });
        const caller = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();
        const allRpcListeners = new Map<string, Map<string, Socket>>([
            [seeded.owner.id, new Map([[method, target as unknown as Socket]])],
        ]);

        rpcHandler(
            callerId,
            caller as unknown as Socket,
            new Map(),
            allRpcListeners,
            {
                io: { to: vi.fn(() => ({ emit: vi.fn() })) } as unknown as Server,
                redisRegistry: { enabled: false },
                sessionPublisherPresence: seeded.presence,
            },
        );
        if (params.revokeBeforeCall === "machine") {
            await db.machine.update({ where: { id: seeded.machineId }, data: { revokedAt: new Date(), active: false } });
        } else if (params.revokeBeforeCall === "machine-binding") {
            await db.accessKey.delete({ where: { accountId_machineId_sessionId: {
                accountId: seeded.owner.id, machineId: seeded.machineId, sessionId: seeded.session.id,
            } } });
        }
        const realTransaction = db.$transaction.bind(db);
        if (params.revokeAfterCapture) {
            // Delay the real capture transaction's response at the DB boundary, then revoke
            // authority before transport dispatch. Internal access and presence owners stay real.
            const transactionBoundary = vi.fn(realTransaction).mockImplementationOnce(async (transaction, options) => {
                const result = await realTransaction(transaction, options);
                if (params.revokeAfterCapture === "share") {
                    await db.sessionShare.delete({ where: { sessionId_sharedWithUserId: { sessionId: seeded.session.id, sharedWithUserId: callerId } } });
                } else {
                    await db.accessKey.delete({ where: { accountId_machineId_sessionId: { accountId: seeded.owner.id, machineId: seeded.machineId, sessionId: seeded.session.id } } });
                }
                return result;
            });
            // Prisma's overloaded DB adapter loses callback overload inference in the boundary spy.
            db.$transaction = transactionBoundary as unknown as typeof db.$transaction;
        }
        try {
            await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
                method,
                params: "opaque-encrypted-stop-request",
                ...(!params.omitAuthorization ? { authorization: {
                    kind: "session.write",
                    sessionId: seeded.session.id,
                } } : {}),
            }, callback);
        } finally {
            if (params.revokeAfterCapture) db.$transaction = realTransaction;
        }
        return { ...seeded, callback, targetEmitWithAck };
    }

    it("marks the exact session inactive only after the daemon proves it stopped", async () => {
        const result = await callStop({ targetResponse: { status: "stopped" } });

        expect(result.targetEmitWithAck).toHaveBeenCalledOnce();
        expect(result.targetEmitWithAck).toHaveBeenCalledWith(
            SOCKET_RPC_EVENTS.REQUEST,
            {
                method: `${result.machineId}:${RPC_METHODS.STOP_SESSION}`,
                params: "opaque-encrypted-stop-request",
                authorization: {
                    kind: "session.write",
                    sessionId: result.session.id,
                },
                transportResponseEnvelopeVersion: 1,
            },
        );
        expect(result.callback).toHaveBeenCalledWith({
            ok: true,
            result: { status: "stopped" },
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true },
        })).resolves.toEqual({ active: false });
    });

    it("does not dispatch a request cancelled during pre-dispatch authorization", async () => {
        const owner = await db.account.create({ data: { publicKey: `cancel-owner-${randomUUID()}` } });
        const emitWithAck = vi.fn(async () => "encrypted-result");
        const target = createFakeSocket({ id: "cancel-target", data: { clientType: "user-scoped" }, timeout: () => ({ emitWithAck }) });
        const caller = createFakeSocket({ id: "cancel-caller" });
        const callback = vi.fn();
        const listeners = new Map([[owner.id, new Map([["echo", target as unknown as Socket]])]]);
        rpcHandler(owner.id, caller as unknown as Socket, new Map(), listeners, {
            io: { to: () => ({ emit: vi.fn() }) } as unknown as Server,
            redisRegistry: { enabled: false },
        });
        const pending = triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL,
            { method: "echo", params: "opaque", requestId: "cancel-before-dispatch" }, callback);
        await Promise.resolve();
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CANCEL, { requestId: "cancel-before-dispatch" });
        await pending;
        expect(callback).toHaveBeenCalledWith({ ok: false, error: "RPC request cancelled by caller" });
        expect(emitWithAck).not.toHaveBeenCalled();
    });

    it.each(["machine", "machine-binding"] as const)("rejects a shared-admin runner stop after its %s is revoked", async (revokeBeforeCall) => {
        const result = await callStop({ targetResponse: "encrypted-stop-result", sharedAccess: "admin", method: "killSession", revokeBeforeCall });
        expect(result.callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(result.targetEmitWithAck).not.toHaveBeenCalled();
        expect(await db.session.findUniqueOrThrow({ where: { id: result.session.id }, select: { active: true } })).toEqual({ active: true });
    });

    it("routes an ordinary shared admin stop to the exact hosting machine without machine-wide access", async () => {
        const result = await callStop({ targetResponse: { status: "stopped" }, sharedAccess: "admin" });
        expect(result.callback).toHaveBeenCalledWith({ ok: true, result: { status: "stopped" } });
        expect(result.targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: `${result.machineId}:${RPC_METHODS.STOP_SESSION}`,
            authorization: { kind: "session.write", sessionId: result.session.id },
        }));
        expect(await db.machineGrant.count({ where: { machineId: result.machineId } })).toBe(0);
        expect(await db.session.findUniqueOrThrow({ where: { id: result.session.id } })).toMatchObject({ active: false });
    });

    it("routes the session-specific killSession fallback for a shared admin", async () => {
        const result = await callStop({ targetResponse: "encrypted-stop-result", sharedAccess: "admin", method: "killSession" });
        expect(result.callback).toHaveBeenCalledWith({ ok: true, result: "encrypted-stop-result" });
        expect(result.targetEmitWithAck).toHaveBeenCalledWith(SOCKET_RPC_EVENTS.REQUEST, expect.objectContaining({
            method: `${result.session.id}:${RPC_METHODS.KILL_SESSION}`,
        }));
    });

    it.each([
        { sharedAccess: "admin", omitAuthorization: true },
        { sharedAccess: "admin", mismatchedMachine: true },
        { sharedAccess: "admin", method: "arbitrary-machine-rpc" },
        { sharedAccess: "admin", revokeAfterCapture: "share" },
        { sharedAccess: "admin", revokeAfterCapture: "machine-binding" },
        { sharedAccess: "view" },
        { sharedAccess: "revoked" },
        { sharedAccess: "edit" },
    ] as const)("does not dispatch unauthorized shared stop or machine control: %j", async (options) => {
        const result = await callStop({ targetResponse: { status: "stopped" }, ...options });
        expect(result.callback).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
        expect(result.targetEmitWithAck).not.toHaveBeenCalled();
        expect(await db.session.findUniqueOrThrow({ where: { id: result.session.id } })).toMatchObject({ active: true });
    });

    it("keeps the session active when physical termination is only requested", async () => {
        const result = await callStop({ targetResponse: { status: "requested" } });

        expect(result.callback).toHaveBeenCalledWith({
            ok: true,
            result: { status: "requested" },
        });
        await expect(db.session.findUniqueOrThrow({
            where: { id: result.session.id },
            select: { active: true },
        })).resolves.toEqual({ active: true });
    });

    it("does not close a successor publisher that registers while stop is in flight", async () => {
        let successorFence: Date | null = null;
        let seededPresence: ReturnType<typeof createSessionPublisherPresence> | null = null;
        let successorBinding: Readonly<{ accountId: string; machineId: string; sessionId: string }> | null = null;
        const seeded = await seed();
        seededPresence = seeded.presence;
        successorBinding = {
            accountId: seeded.owner.id,
            machineId: seeded.machineId,
            sessionId: seeded.session.id,
        };
        const method = `${seeded.machineId}:${RPC_METHODS.STOP_SESSION}`;
        const target = createFakeSocket({
            id: "target-socket",
            data: { clientType: "machine-scoped", machineId: seeded.machineId },
            timeout: vi.fn(() => ({
                emitWithAck: async () => {
                    const successor = await seededPresence!.registerPublisher({
                        socket: {},
                        binding: successorBinding!,
                        completeActivitySnapshot: { state: "active", activeCount: 1 },
                    });
                    if (successor.status !== "registered") throw new Error("expected successor registration");
                    successorFence = successor.committedFence;
                    return {
                        v: 1,
                        result: { status: "stopped" },
                        acknowledgement: { kind: "session.stop", status: "stopped" },
                    };
                },
            })),
        });
        const caller = createFakeSocket({ id: "caller-socket" });
        const callback = vi.fn();

        rpcHandler(
            seeded.owner.id,
            caller as unknown as Socket,
            new Map(),
            new Map([[seeded.owner.id, new Map([[method, target as unknown as Socket]])]]),
            {
                io: {} as Server,
                redisRegistry: { enabled: false },
                sessionPublisherPresence: seeded.presence,
            },
        );
        await triggerSocketHandler(caller, SOCKET_RPC_EVENTS.CALL, {
            method,
            params: "opaque-encrypted-stop-request",
            authorization: {
                kind: "session.write",
                sessionId: seeded.session.id,
            },
        }, callback);

        expect(callback).toHaveBeenCalledWith({
            ok: false,
            error: "Session resumed while stop was in progress",
        });
        const stored = await db.session.findUniqueOrThrow({
            where: { id: seeded.session.id },
            select: { active: true, lastActiveAt: true },
        });
        expect(stored.active).toBe(true);
        expect(stored.lastActiveAt).toEqual(successorFence);
    });
});
