import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
    return {
        serverFetch: vi.fn(),
    };
});

vi.mock('@/sync/http/client', async (importOriginal) => ({
    ...await importOriginal<typeof import('@/sync/http/client')>(),
    serverFetch: mocks.serverFetch,
}));

import { authGetToken } from './getToken';
import { resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { HappyError } from '@/utils/errors/errors';

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
    });
}

describe('authGetToken key-challenge gate', () => {
    beforeEach(() => {
        resetServerFeaturesClientForTests();
        mocks.serverFetch.mockReset();
    });

    it('fails fast when server disables key-challenge login', async () => {
        mocks.serverFetch.mockResolvedValueOnce(
            jsonResponse({
                features: { auth: { login: { keyChallenge: { enabled: false } } } },
                capabilities: {},
            }),
        );

        await expect(authGetToken(new Uint8Array(32))).rejects.toThrow(/key-challenge/i);
        expect(mocks.serverFetch).toHaveBeenCalledTimes(1);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
    });

    it('does not fail fast when server does not advertise key-challenge gate (legacy server)', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { recovery: { providerReset: { enabled: false } }, ui: { recoveryKeyReminder: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'legacy-token' }));

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('legacy-token');
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v1/auth');
    });

    it('continues when server enables key-challenge login', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ token: 'test-token' }));

        await expect(authGetToken(new Uint8Array(32))).resolves.toBe('test-token');
        expect(mocks.serverFetch).toHaveBeenCalledTimes(2);
        expect(mocks.serverFetch.mock.calls[0]?.[0]).toBe('/v1/features');
        expect(mocks.serverFetch.mock.calls[1]?.[0]).toBe('/v1/auth');
    });

    it('sends an invitation only to a managed-account server and binds the independent content key', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(jsonResponse({
                features: {
                    auth: { login: { keyChallenge: { enabled: true } } },
                    accounts: { machineAccess: { enabled: true } },
                    sharing: { contentKeys: { enabled: true } },
                },
                capabilities: {},
            }))
            .mockResolvedValueOnce(jsonResponse({ token: 'member-token' }));

        const secret = new Uint8Array(32).fill(7);
        await expect(authGetToken(secret, { inviteToken: 'single-use-invite' })).resolves.toBe('member-token');
        const request = mocks.serverFetch.mock.calls.find(([path]) => path === '/v1/auth');
        const body = JSON.parse(String(request?.[1]?.body)) as Record<string, unknown>;
        expect(body.inviteToken).toBe('single-use-invite');
        expect(body.contentPublicKey).toEqual(expect.any(String));
        expect(body.contentPublicKeySig).toEqual(expect.any(String));
        expect(body).not.toHaveProperty('secret');
    });

    it('does not disclose an invitation to an older or feature-disabled server', async () => {
        mocks.serverFetch.mockResolvedValueOnce(jsonResponse({
            features: { auth: { login: { keyChallenge: { enabled: true } } } },
            capabilities: {},
        }));

        await expect(authGetToken(new Uint8Array(32), { inviteToken: 'private-invite' })).rejects.toThrow();
        expect(mocks.serverFetch.mock.calls.some(([path]) => path === '/v1/auth')).toBe(false);
    });

    it('surfaces signup-disabled through the canonical typed auth error', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ error: 'signup-disabled' }, 403));

        const failure = await authGetToken(new Uint8Array(32)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(HappyError);
        expect(failure).toMatchObject({
            canTryAgain: false,
            code: 'signup-disabled',
            kind: 'auth',
            status: 403,
        });
    });

    it('does not promote unknown response codes to typed auth codes', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(jsonResponse({ error: 'future-policy-code' }, 403));

        const unknownCodeFailure = await authGetToken(new Uint8Array(32)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(unknownCodeFailure).toBeInstanceOf(HappyError);
        expect(unknownCodeFailure).toMatchObject({ code: undefined, kind: 'auth', status: 403 });
    });

    it('keeps a non-JSON server failure retryable without inventing an auth code', async () => {
        mocks.serverFetch
            .mockResolvedValueOnce(
                jsonResponse({
                    features: {
                        auth: { login: { keyChallenge: { enabled: true } } },
                        sharing: { contentKeys: { enabled: false } },
                    },
                    capabilities: {},
                }),
            )
            .mockResolvedValueOnce(new Response('Internal Server Error', { status: 500 }));

        const nonJsonFailure = await authGetToken(new Uint8Array(32)).then(
            () => null,
            (error: unknown) => error,
        );

        expect(nonJsonFailure).toBeInstanceOf(HappyError);
        expect(nonJsonFailure).toMatchObject({
            canTryAgain: true,
            code: undefined,
            kind: 'server',
            status: 500,
        });
    });
});
