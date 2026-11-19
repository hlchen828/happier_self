import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react-test-renderer';
import { renderSettingsView } from '@/dev/testkit/harness/settingsViewHarness';
import { ManagedAccountsView } from './ManagedAccountsView';
import { createMachineFixture, createRootLayoutFeaturesResponse } from '@/dev/testkit';
import { getServerFeaturesSnapshot, resetServerFeaturesClientForTests } from '@/sync/api/capabilities/serverFeaturesClient';
import { getStorage } from '@/sync/domains/state/storage';
import { Encryption } from '@/sync/encryption/encryption';
import { encodeBase64 } from '@/encryption/base64';
import { fetchAndApplyMachines } from '@/sync/engine/machines/syncMachines';
import type { IModal } from '@/modal';
import type { ManagedMembersResponse } from '@happier-dev/protocol';
import type { SettingsViewHarness } from '@/dev/testkit/harness/settingsViewHarness';

type ReactActEnvironmentGlobal = typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean };
(globalThis as ReactActEnvironmentGlobal).IS_REACT_ACT_ENVIRONMENT = true;

const network = vi.hoisted(() => ({ fetch: vi.fn(), failCreate: false }));
const authority = vi.hoisted(() => ({ credentials: { token: 'admin-token', secret: 'test-secret' }, assignmentEnabled: true }));
const modal = vi.hoisted(() => ({
    show: vi.fn<IModal['show']>(() => 'modal-id'),
    confirm: vi.fn(async () => false),
    alert: vi.fn(),
    hide: vi.fn(),
}));
const clipboard = vi.hoisted(() => ({ setClipboardStringSafe: vi.fn(async () => true) }));
const syncSpy = vi.hoisted(() => ({ refreshMachines: vi.fn() }));
const invites = vi.hoisted(() => ({ list: [] as Array<Record<string, unknown>>, members: [] as ManagedMembersResponse['members'] }));
const snapshot = vi.hoisted(() => ({
    serverId: 'server-1',
    serverUrl: 'http://relay.test',
    activeShareableServerUrl: null,
    activeLocalRelayUrl: null,
    generation: 1,
}));

vi.mock('react-native-reanimated', () => ({}));
vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock();
});
vi.mock('react-native-unistyles', async () => {
    const { createUnistylesMock } = await import('@/dev/testkit/mocks/unistyles');
    return createUnistylesMock();
});
vi.mock('expo-router', async () => {
    const { createExpoRouterMock } = await import('@/dev/testkit/mocks/router');
    return createExpoRouterMock().module;
});
vi.mock('@/text', async () => {
    const { createTextModuleMock } = await import('@/dev/testkit/mocks/text');
    return createTextModuleMock({ translate: (key: string) => key });
});
vi.mock('@/modal', async () => {
    const { createModalModuleMock } = await import('@/dev/testkit/mocks/modal');
    return createModalModuleMock({ spies: modal }).module;
});

// Thin UI-primitive stubs keep the tree shallow and avoid the storage/layout hook chain.
vi.mock('@/components/ui/text/Text', () => ({ Text: 'Text', TextInput: 'TextInput' }));
vi.mock('@/components/ui/buttons/RoundButton', () => ({
    RoundButton: ({ title, onPress, testID, ...rest }: { title?: unknown; onPress?: () => unknown; testID?: string }) =>
        React.createElement('RoundButton', { ...rest, title, onPress, testID }),
}));
vi.mock('@/components/ui/lists/Item', () => ({
    Item: ({ title, subtitle, detail, onPress, testID, ...rest }: Record<string, unknown>) =>
        React.createElement('Item', { ...rest, title, subtitle, detail, onPress, testID }),
}));
vi.mock('@/components/ui/lists/ItemGroup', () => ({
    ItemGroup: ({ title, children, ...rest }: { title?: unknown; children?: React.ReactNode }) =>
        React.createElement('ItemGroup', { ...rest, title }, children),
}));
vi.mock('@/components/ui/forms/FieldItem', () => ({
    FieldItem: ({ label, supportingText, children, ...rest }: { label?: unknown; supportingText?: unknown; children?: React.ReactNode }) =>
        React.createElement('FieldItem', { ...rest, label, supportingText }, children),
}));

vi.mock('@/sync/http/client', async (importOriginal) => {
    const original = await importOriginal<typeof import('@/sync/http/client')>();
    return { ...original, serverFetch: network.fetch };
});
vi.mock('@/auth/context/AuthContext', () => ({
    useAuth: () => ({ credentials: authority.credentials, credentialsScope: snapshot }),
}));
vi.mock('@/sync/domains/server/serverRuntime', () => ({
    useActiveServerSnapshot: () => snapshot,
    getActiveServerSnapshot: () => snapshot,
    subscribeActiveServer: () => () => {},
}));
vi.mock('@/sync/runtime/managedAccessChanged', () => ({
    subscribeManagedAccessChanged: () => () => {},
}));
vi.mock('@/sync/sync', () => ({
    sync: { refreshMachines: syncSpy.refreshMachines },
}));
vi.mock('@/utils/ui/clipboard', () => ({
    setClipboardStringSafe: clipboard.setClipboardStringSafe,
    getClipboardStringTrimmedSafe: async () => '',
}));
vi.mock('@shopify/flash-list', async () => {
    const { createCapturingFlashListMock } = await import('@/dev/testkit/mocks/flashList');
    return createCapturingFlashListMock().module;
});
vi.mock('@react-navigation/native', async () => {
    const { createReactNavigationNativeMock } = await import('@/dev/testkit/mocks/reactNavigation');
    return createReactNavigationNativeMock();
});

function reply(data: unknown): Response {
    return new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } });
}

function installFetchHandler(): void {
    network.fetch.mockImplementation(async (
        path: string, init: RequestInit | undefined, _options: unknown,
        consume?: (response: Response) => Promise<unknown>,
    ) => {
        const url = String(path);
        const method = (init?.method ?? 'GET').toUpperCase();
        if (url.endsWith('/v1/features')) return reply(createRootLayoutFeaturesResponse({ features: {
            accounts: { machineAccess: { enabled: true }, inviteMachineAssignment: { enabled: authority.assignmentEnabled } },
        } }));
        if (!consume) throw new Error(`Unexpected non-consuming fetch: ${method} ${url}`);
        if (url.endsWith('/v1/account/access')) {
            return consume(reply({ managed: true, role: 'admin', adminAccountId: 'admin-1', machineId: null }));
        }
        if (url.endsWith('/v1/account/members')) return consume(reply({ members: invites.members }));
        if (url.includes('/grants/')) return consume(reply(method === 'DELETE' ? { success: true } : { machineId: 'legacy', accountId: 'member', status: 'pending' }));
        if (url.endsWith('/v1/account/invites')) {
            if (method === 'POST') {
                if (network.failCreate) return consume(new Response(null, { status: 500 }));
                return consume(reply({ id: 'inv-2', kind: 'member', name: 'alice', expiresAt: Date.now() + 86400000, createdAt: Date.now(), token: 'token-123' }));
            }
            return consume(reply({ invites: invites.list }));
        }
        if (method === 'DELETE' && url.includes('/v1/account/invites/')) return consume(reply({ success: true }));
        throw new Error(`unexpected fetch: ${method} ${url}`);
    });
}

async function waitFor(condition: () => boolean): Promise<void> {
    for (let i = 0; i < 100; i += 1) {
        if (condition()) return;
        await act(async () => { await Promise.resolve(); });
    }
    throw new Error('waitFor: condition not met within budget');
}

async function openMachinePicker(screen: SettingsViewHarness) {
    await screen.pressByTestIdAsync('managed-invite-machines');
    const request = modal.show.mock.calls.at(-1)?.[0] as Parameters<IModal['show']>[0] | undefined;
    if (!request || !('component' in request)) throw new Error('Machine picker modal was not presented');
    return renderSettingsView(React.createElement(request.component, { ...request.props, onClose: () => {} }));
}

function createdBody(): Record<string, unknown> {
    const call = network.fetch.mock.calls.filter(([path, init]) => String(path).endsWith('/v1/account/invites') && init?.method === 'POST').at(-1);
    return JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
}

async function fillExpiry(screen: SettingsViewHarness) {
    await act(async () => { screen.changeTextByTestId('managed-invite-expiry', '2026-12-30T18:00:00+08:00'); });
}

describe('managed account invite flows', () => {
    beforeEach(() => {
        invites.list = [];
        invites.members = [];
        authority.credentials = { token: 'admin-token', secret: 'test-secret' };
        authority.assignmentEnabled = true;
        resetServerFeaturesClientForTests();
        vi.stubGlobal('fetch', vi.fn(async () => reply(createRootLayoutFeaturesResponse({ features: {
            accounts: { machineAccess: { enabled: true }, inviteMachineAssignment: { enabled: authority.assignmentEnabled } },
        } }))));
        snapshot.serverId = 'server-1';
        snapshot.serverUrl = 'http://relay.test';
        snapshot.generation = 1;
        network.failCreate = false;
        modal.hide.mockClear();
        getStorage().getState().applyMachines([], true);
        network.fetch.mockReset();
        modal.show.mockClear();
        modal.confirm.mockClear();
        modal.alert.mockClear();
        clipboard.setClipboardStringSafe.mockClear();
        syncSpy.refreshMachines.mockClear();
        modal.confirm.mockImplementation(async () => false);
        installFetchHandler();
    });

    it('keeps the invite when the administrator declines the revocation confirmation', async () => {
        invites.list = [{ id: 'inv-1', kind: 'member', name: 'bob', expiresAt: Date.now() + 86400000, createdAt: 1, consumedAt: null, revokedAt: null }];
        modal.confirm.mockImplementation(async () => false);

        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findRowByTitle('managedAccounts.invitations') !== null);
        await act(async () => { screen.pressRowByTitle('managedAccounts.invitations'); });
        await waitFor(() => screen.findRowByTitle('managedAccounts.memberInvite · bob') !== null);

        const row = screen.findRowByTitle('managedAccounts.memberInvite · bob');
        await act(async () => { await (row?.props.onPress as () => Promise<void>)(); });

        expect(modal.confirm).toHaveBeenCalled();
        const deleteCalls = network.fetch.mock.calls.filter(([path, init]) =>
            String(path).includes('/v1/account/invites/inv-1') && (init as RequestInit | undefined)?.method === 'DELETE');
        expect(deleteCalls).toHaveLength(0);
    });

    it('revokes the invite only after the administrator confirms', async () => {
        invites.list = [{ id: 'inv-1', kind: 'member', name: 'bob', expiresAt: Date.now() + 86400000, createdAt: 1, consumedAt: null, revokedAt: null }];
        modal.confirm.mockImplementation(async () => true);

        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findRowByTitle('managedAccounts.invitations') !== null);
        await act(async () => { screen.pressRowByTitle('managedAccounts.invitations'); });
        await waitFor(() => screen.findRowByTitle('managedAccounts.memberInvite · bob') !== null);

        const row = screen.findRowByTitle('managedAccounts.memberInvite · bob');
        await act(async () => { await (row?.props.onPress as () => Promise<void>)(); });

        const deleteCalls = network.fetch.mock.calls.filter(([path, init]) =>
            String(path).includes('/v1/account/invites/inv-1') && (init as RequestInit | undefined)?.method === 'DELETE');
        expect(deleteCalls).toHaveLength(1);
    });

    it('selects and deselects only genuinely managed, non-revoked, non-replaced machines', async () => {
        getStorage().getState().applyMachines([
            createMachineFixture({ id: 'eligible', managed: true }),
            createMachineFixture({ id: 'second', managed: true }),
            createMachineFixture({ id: 'legacy', managedAccessStatus: 'ready' }),
            createMachineFixture({ id: 'ordinary', managed: false }),
            createMachineFixture({ id: 'revoked', managed: true, revokedAt: 1 }),
            createMachineFixture({ id: 'replaced', managed: true, replacedByMachineId: 'eligible' }),
        ], true);
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const picker = await openMachinePicker(screen);
        for (const id of ['legacy', 'ordinary', 'revoked', 'replaced']) expect(picker.findByTestId(`managed-invite-machine-${id}`)).toBeNull();
        await picker.pressByTestIdAsync('managed-invite-machine-eligible');
        await picker.pressByTestIdAsync('managed-invite-machine-second');
        await picker.pressByTestIdAsync('managed-invite-machine-second');
        expect(picker.findByTestId('managed-invite-machine-eligible')?.props.selected).toBe(true);
        expect(picker.findByTestId('managed-invite-machine-second')?.props.selected).toBe(false);
        await picker.unmount();
        await fillExpiry(screen);
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody().machineIds).toEqual(['eligible']);
        const reset = await openMachinePicker(screen);
        expect(reset.findByTestId('managed-invite-machine-eligible')?.props.selected).toBe(false);
    });

    it('hides unsupported selection and keeps the no-selection request compatible with older relays', async () => {
        authority.assignmentEnabled = false;
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        expect(screen.findByTestId('managed-invite-machines')).toBeNull();
        await fillExpiry(screen);
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody()).not.toHaveProperty('machineIds');
    });

    it('clears selection when switching invitation kind and sends none for machine enrollment', async () => {
        getStorage().getState().applyMachines([createMachineFixture({ id: 'eligible', managed: true })], true);
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const picker = await openMachinePicker(screen);
        await picker.pressByTestIdAsync('managed-invite-machine-eligible');
        await picker.unmount();
        await screen.pressByTestIdAsync('managed-invite-kind-machine');
        expect(screen.findByTestId('managed-invite-machines')).toBeNull();
        await fillExpiry(screen);
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody()).toMatchObject({ kind: 'machine' });
        expect(createdBody()).not.toHaveProperty('machineIds');
        await screen.pressByTestIdAsync('managed-invite-kind-member');
        const reset = await openMachinePicker(screen);
        expect(reset.findByTestId('managed-invite-machine-eligible')?.props.selected).toBe(false);
    });

    it('retains selection after failed creation but never sends it after the feature is disabled', async () => {
        getStorage().getState().applyMachines([createMachineFixture({ id: 'eligible', managed: true })], true);
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const picker = await openMachinePicker(screen);
        await picker.pressByTestIdAsync('managed-invite-machine-eligible');
        await picker.unmount();
        await fillExpiry(screen);
        network.failCreate = true;
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody().machineIds).toEqual(['eligible']);
        const retry = await openMachinePicker(screen);
        expect(retry.findByTestId('managed-invite-machine-eligible')?.props.selected).toBe(true);
        await retry.unmount();
        authority.assignmentEnabled = false;
        await act(async () => { await getServerFeaturesSnapshot({ force: true }); });
        await screen.update(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-machines') === null);
        network.failCreate = false;
        const attempts = network.fetch.mock.calls.filter(([, init]) => init?.method === 'POST').length;
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(network.fetch.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(attempts);
        expect(modal.alert).toHaveBeenCalled();
        expect(screen.findByTestId('managed-invite-clear-machines')).not.toBeNull();
        await screen.pressByTestIdAsync('managed-invite-clear-machines');
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody()).not.toHaveProperty('machineIds');
    });

    it('preserves the entire selected intent if eligibility changes before submission', async () => {
        const machine = createMachineFixture({ id: 'eligible', managed: true });
        getStorage().getState().applyMachines([machine], true);
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const picker = await openMachinePicker(screen);
        await picker.pressByTestIdAsync('managed-invite-machine-eligible');
        await picker.unmount();
        await act(async () => { getStorage().getState().applyMachines([{ ...machine, revokedAt: 1 }], true); });
        network.failCreate = true;
        await fillExpiry(screen);
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody().machineIds).toEqual(['eligible']);
        expect(modal.alert).toHaveBeenCalled();
        expect(screen.findByTestId('managed-invite-machines')?.props.subtitle).toBe('managedAccounts.inviteMachinesSelected');
    });

    it.each([
        { marker: false, assignment: true, disabled: true },
        { marker: undefined, assignment: true, disabled: true },
        { marker: false, assignment: false, disabled: true },
    ])('keeps manual grant compatibility while blocking known legacy enrollment ($marker / new feature: $assignment)', async ({ marker, assignment, disabled }) => {
        authority.assignmentEnabled = assignment;
        invites.members = [{ id: 'member', name: null, publicKey: null, contentPublicKey: null, contentPublicKeySig: null, disabled: false, createdAt: 1, machineIds: [] }];
        getStorage().getState().applyMachines([createMachineFixture({ id: 'legacy', managed: marker })], true);
        const screen = await renderSettingsView(<ManagedAccountsView memberId="member" />);
        await waitFor(() => screen.findByTestId('managed-machine-legacy') !== null);
        expect(screen.findByTestId('managed-machine-legacy')?.props.disabled).toBe(disabled);
        await screen.pressByTestIdAsync('managed-machine-legacy');
        const grants = network.fetch.mock.calls.filter(([path, init]) => String(path).includes('/grants/') && init?.method === 'PUT');
        expect(grants).toHaveLength(disabled ? 0 : 1);
    });

    it('preserves predecessor manual attempts from old REST omission through real sync into the UI', async () => {
        authority.assignmentEnabled = false;
        invites.members = [{ id: 'member', name: null, publicKey: null, contentPublicKey: null, contentPublicKeySig: null, disabled: false, createdAt: 1, machineIds: [] }];
        const encryption = await Encryption.create(new Uint8Array(32).fill(1));
        const dataKey = new Uint8Array(32).fill(2);
        await encryption.initializeMachines(new Map([['legacy', dataKey]]));
        const metadata = createMachineFixture().metadata!;
        const machineEncryption = encryption.getMachineEncryption('legacy')!;
        // The deployed predecessor /v1/machines projection had grant status but no managed marker.
        const oldRelayRow = { id: 'legacy', seq: 1, createdAt: 1, updatedAt: 1, active: true, activeAt: 1,
            metadata: await machineEncryption.encryptMetadata(metadata), metadataVersion: 1,
            daemonState: null, daemonStateVersion: 0,
            dataEncryptionKey: encodeBase64(await encryption.encryptEncryptionKey(dataKey), 'base64'), managedAccessStatus: 'ready' };
        await fetchAndApplyMachines({ credentials: authority.credentials, encryption, machineDataKeys: new Map(),
            request: async () => reply([oldRelayRow]), applyMachines: getStorage().getState().applyMachines, replace: true,
            getExistingMachine: (id) => getStorage().getState().machines[id],
            applyMachineDisplayEntries: (rows) => getStorage().getState().replaceMachineDisplays(rows, { sourceServerId: snapshot.serverId }),
        });
        expect(getStorage().getState().machineDisplayById.legacy).toMatchObject({ id: 'legacy', managedAccessStatus: 'ready' });
        expect(getStorage().getState().machineDisplayById.legacy?.managed).toBeUndefined();
        // Display-first snapshots return before background decryption finishes; observe that real hydration too.
        await vi.waitFor(() => expect(getStorage().getState().machines.legacy).toMatchObject({ id: 'legacy', metadata }));
        expect(getStorage().getState().machines.legacy).toMatchObject({ id: 'legacy', metadata });
        expect(getStorage().getState().machines.legacy?.managed).toBeUndefined();
        const screen = await renderSettingsView(<ManagedAccountsView memberId="member" />);
        await waitFor(() => screen.findByTestId('managed-machine-legacy') !== null);
        expect(screen.findByTestId('managed-machine-legacy')?.props.title).toBe(metadata.displayName ?? metadata.host);
        expect(screen.findByTestId('managed-machine-legacy')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('managed-machine-legacy');
        expect(network.fetch.mock.calls.some(([path, init]) => String(path).includes('/grants/') && init?.method === 'PUT')).toBe(true);
    });

    it('still revokes an existing grant on a machine that is no longer eligible', async () => {
        invites.members = [{ id: 'member', name: null, publicKey: null, contentPublicKey: null, contentPublicKeySig: null, disabled: false, createdAt: 1, machineIds: ['legacy'] }];
        getStorage().getState().applyMachines([createMachineFixture({ id: 'legacy', managed: false, revokedAt: 1 })], true);
        const screen = await renderSettingsView(<ManagedAccountsView memberId="member" />);
        await waitFor(() => screen.findByTestId('managed-machine-legacy') !== null);
        expect(screen.findByTestId('managed-machine-legacy')?.props.disabled).toBe(false);
        await screen.pressByTestIdAsync('managed-machine-legacy');
        expect(network.fetch.mock.calls.some(([path, init]) => String(path).includes('/grants/') && init?.method === 'DELETE')).toBe(true);
    });

    it.each(['server', 'account'] as const)('does not carry selected machines across a %s authority switch', async (change) => {
        getStorage().getState().applyMachines([createMachineFixture({ id: 'eligible', managed: true })], true);
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const picker = await openMachinePicker(screen);
        await picker.pressByTestIdAsync('managed-invite-machine-eligible');
        await picker.unmount();
        if (change === 'server') {
            snapshot.serverId = 'server-2';
            snapshot.serverUrl = 'http://other-relay.test';
            snapshot.generation += 1;
        } else authority.credentials = { token: 'other-admin-token', secret: 'other-secret' };
        await screen.update(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const reset = await openMachinePicker(screen);
        expect(reset.findByTestId('managed-invite-machine-eligible')?.props.selected).toBe(false);
        expect(modal.hide).toHaveBeenCalled();
        await reset.unmount();
        await fillExpiry(screen);
        await screen.pressByTestIdAsync('managed-invite-create');
        expect(createdBody()).not.toHaveProperty('machineIds');
    });

    it('offers truthful enrollment guidance when no eligible managed machines exist', async () => {
        getStorage().getState().applyMachines([createMachineFixture({ id: 'legacy', managedAccessStatus: 'ready' })], true);
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);
        const picker = await openMachinePicker(screen);
        expect(picker.findByTestId('managed-invite-no-machines')).not.toBeNull();
        expect(picker.getTextContent()).toContain('managedAccounts.inviteMachinesEnrollHelp');
    });

    it('presents the freshly created invite token once in a modal instead of inline state', async () => {
        const screen = await renderSettingsView(<ManagedAccountsView />);
        await waitFor(() => screen.findByTestId('managed-invite-create') !== null);

        await act(async () => {
            screen.changeTextByTestId('managed-invite-name', 'alice');
            screen.changeTextByTestId('managed-invite-expiry', '2026-12-30T18:00:00+08:00');
        });
        await screen.pressByTestIdAsync('managed-invite-create');

        const createCalls = network.fetch.mock.calls.filter(([path, init]) =>
            String(path).endsWith('/v1/account/invites') && (init as RequestInit | undefined)?.method === 'POST');
        expect(createCalls).toHaveLength(1);
        expect(modal.alert).not.toHaveBeenCalled();
        expect(modal.show).toHaveBeenCalledWith(expect.objectContaining({
            props: expect.objectContaining({ token: 'token-123' }),
        }));
    });
});
