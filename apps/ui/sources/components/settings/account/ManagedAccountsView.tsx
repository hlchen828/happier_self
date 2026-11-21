import * as React from 'react';
import { View, useWindowDimensions } from 'react-native';
import { useRouter } from 'expo-router';
import { useFocusEffect, useIsFocused } from '@react-navigation/native';
import { StyleSheet, useUnistyles } from 'react-native-unistyles';
import { useAuth } from '@/auth/context/AuthContext';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { useAllMachines } from '@/sync/domains/state/storage';
import type { Machine } from '@/sync/domains/state/storageTypes';
import { createManagedAccountClient, loadManagedAdminState, type ManagedAdminState } from '@/sync/api/account/apiManagedAccounts';
import { subscribeManagedAccessChanged } from '@/sync/runtime/managedAccessChanged';
import { sync } from '@/sync/sync';
import { HappyError } from '@/utils/errors/errors';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Text, TextInput } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Item } from '@/components/ui/lists/Item';
import { Icon } from '@/components/ui/icons/Icon';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { FlashList } from '@/components/ui/lists/flashListCompat/FlashListCompat';
import { layout } from '@/components/ui/layout/layout';
import { Modal } from '@/modal';
import { t } from '@/text';
import type { ManagedInvite } from '@happier-dev/protocol';
import { confirmRevokeInvite, useManagedInviteCreation } from './managedInviteActions';

const RUNTIME_FEATURE_SCOPE = Object.freeze({ scopeKind: 'runtime' as const });
type Member = ManagedAdminState['members'][number];
type Row = { kind: 'member'; value: Member } | { kind: 'invite'; value: ManagedInvite } | { kind: 'machine'; value: Machine };

export function ManagedAccountsView({ memberId }: Readonly<{ memberId?: string }>) {
    const enabled = useFeatureEnabled('accounts.machineAccess', RUNTIME_FEATURE_SCOPE);
    if (!enabled) return <View style={styles.message}><Text>{t('managedAccounts.adminOnly')}</Text></View>;
    return <ManagedAccountsContent memberId={memberId} />;
}

function ManagedAccountsContent({ memberId }: Readonly<{ memberId?: string }>) {
    const { credentials, credentialsScope } = useAuth();
    const server = useActiveServerSnapshot();
    const [state, setState] = React.useState<ManagedAdminState | null>(null);
    const [error, setError] = React.useState<'denied' | 'failed' | null>(null);
    const [tab, setTab] = React.useState<'member' | 'invite'>('member');
    const reloadRef = React.useRef<(() => void) | null>(null);
    const [loadedAuthority, setLoadedAuthority] = React.useState<Readonly<{ token: string; generation: number }> | null>(null);
    const hasScopedCredentials = credentialsScope?.serverId === server.serverId && credentialsScope.serverUrl === server.serverUrl && credentialsScope.generation === server.generation;
    useFocusEffect(React.useCallback(() => {
        if (!credentials || !credentialsScope || !hasScopedCredentials) return;
        let active = true;
        let controller: AbortController | null = null;
        const reload = () => {
            controller?.abort();
            const run = new AbortController();
            controller = run;
            void loadManagedAdminState(credentials, credentialsScope, { signal: run.signal }).then((value) => {
                if (!active || run.signal.aborted) return;
                setLoadedAuthority((previous) => previous?.token === credentials.token && previous.generation === server.generation
                    ? previous : { token: credentials.token, generation: server.generation });
                setState((previous) => reconcileAdminState(previous, value));
                setError(null);
            }).catch((failure: unknown) => {
                if (!active || run.signal.aborted) return;
                if (failure instanceof HappyError && failure.status === 403) {
                    setState(null);
                    setError('denied');
                } else setError('failed');
            });
        };
        reloadRef.current = reload;
        reload();
        void sync.refreshMachines();
        const unsubscribe = subscribeManagedAccessChanged(server.serverId, reload);
        return () => { active = false; controller?.abort(); reloadRef.current = null; unsubscribe(); };
    }, [credentials, credentialsScope, hasScopedCredentials, server.serverId, server.generation]));
    const reload = React.useCallback(() => { reloadRef.current?.(); }, []);
    if (!credentials || error === 'denied') return <View style={styles.message}><Text>{t('managedAccounts.adminOnly')}</Text></View>;
    if (!state || !credentialsScope || !hasScopedCredentials || loadedAuthority?.token !== credentials.token || loadedAuthority.generation !== server.generation) return <View style={styles.message}>
        <Text>{error ? t('errors.operationFailed') : t('common.loading')}</Text>
        {error ? <RoundButton title={t('common.retry')} onPress={reload} /> : null}
    </View>;
    return <ManagedAccountsList state={state} memberId={memberId} credentials={credentials} scope={credentialsScope} tab={tab} onTabChange={setTab} onChanged={reload} failed={error === 'failed'} />;
}

function ManagedAccountsList(props: Readonly<{
    state: ManagedAdminState; memberId?: string; credentials: AuthCredentials; scope: ActiveServerSnapshot; tab: 'member' | 'invite';
    onTabChange: (tab: 'member' | 'invite') => void; onChanged: () => void; failed: boolean;
}>) {
    const presented = useIsFocused();
    const member = props.memberId ? props.state.members.find((candidate) => candidate.id === props.memberId) : undefined;
    const machineListOptions = React.useMemo(() => ({ includeRetiredIds: member?.machineIds }), [member?.machineIds]);
    const machines = useAllMachines(presented && props.memberId !== undefined, machineListOptions);
    const assignmentEnabled = useFeatureEnabled('accounts.inviteMachineAssignment', RUNTIME_FEATURE_SCOPE);
    const rowContext = React.useMemo(() => ({ member, allowLegacyRegistration: !assignmentEnabled }), [member, assignmentEnabled]);
    const rows = React.useMemo<Row[]>(() => props.memberId
        ? machines.map((value) => ({ kind: 'machine', value }))
        : props.tab === 'member'
            ? props.state.members.map((value) => ({ kind: 'member', value }))
            : props.state.invites.map((value) => ({ kind: 'invite', value })), [machines, props.memberId, props.tab, props.state.members, props.state.invites]);
    const renderItem = React.useCallback(({ item }: { item: Row }) => <ManagedAccountRow row={item} member={rowContext.member} allowLegacyRegistration={rowContext.allowLegacyRegistration} credentials={props.credentials} scope={props.scope} onChanged={props.onChanged} />,
        [rowContext, props.credentials, props.scope, props.onChanged]);
    if (props.memberId && !member) return <View style={styles.message}><Text>{t('managedAccounts.noMembers')}</Text></View>;
    return <View style={styles.screen}>
        <FlashList data={rows} keyExtractor={rowKey} renderItem={renderItem} extraData={rowContext} keyboardShouldPersistTaps="handled"
            ListHeaderComponent={<View>
                {props.failed ? <Item title={t('errors.operationFailed')} onPress={props.onChanged} /> : null}
                {member ? <ItemGroup title={member.name ?? member.id}>
                    <MemberStatus member={member} credentials={props.credentials} scope={props.scope} onChanged={props.onChanged} />
                    <Item title={t('managedAccounts.machineAssignments')} subtitle={t('managedAccounts.sharedTrust')} mode="info" />
                </ItemGroup> : <>
                    <ItemGroup>
                        <Item title={t('managedAccounts.members')} selected={props.tab === 'member'} onPress={() => props.onTabChange('member')} />
                        <Item title={t('managedAccounts.invitations')} selected={props.tab === 'invite'} onPress={() => props.onTabChange('invite')} />
                    </ItemGroup>
                    <InvitationCreation credentials={props.credentials} scope={props.scope} onCreated={props.onChanged} />
                </>}
            </View>}
            ListEmptyComponent={<View style={styles.message}><Text>{t(props.memberId ? 'newSession.noMachinesFound' : props.tab === 'member' ? 'managedAccounts.noMembers' : 'managedAccounts.noInvites')}</Text></View>}
        />
    </View>;
}
const rowKey = (row: Row) => `${row.kind}:${row.value.id}`;

function retainRows<T extends { id: string }>(previous: T[], next: T[]): T[] {
    const byId = new Map(previous.map((entry) => [entry.id, entry]));
    const rows = next.map((entry) => {
        const held = byId.get(entry.id);
        return held && JSON.stringify(held) === JSON.stringify(entry) ? held : entry;
    });
    return previous.length === rows.length && previous.every((entry, index) => entry === rows[index]) ? previous : rows;
}
function reconcileAdminState(previous: ManagedAdminState | null, next: ManagedAdminState): ManagedAdminState {
    if (!previous) return next;
    const previousMembers = new Map(previous.members.map((entry) => [entry.id, entry]));
    const members = retainRows(previous.members, next.members.map((entry) => {
        const held = previousMembers.get(entry.id);
        if (!held) return entry;
        return { ...entry,
            machineIds: JSON.stringify(held.machineIds) === JSON.stringify(entry.machineIds) ? held.machineIds : entry.machineIds,
            machineGrants: JSON.stringify(held.machineGrants) === JSON.stringify(entry.machineGrants) ? held.machineGrants : entry.machineGrants,
        };
    }));
    const invites = retainRows(previous.invites, next.invites);
    const access = JSON.stringify(previous.access) === JSON.stringify(next.access) ? previous.access : next.access;
    return members === previous.members && invites === previous.invites && access === previous.access ? previous : { members, invites, access };
}

function ManagedAccountRow({ row, member, allowLegacyRegistration, credentials, scope, onChanged }: Readonly<{ row: Row; member?: Member; allowLegacyRegistration: boolean; credentials: AuthCredentials; scope: ActiveServerSnapshot; onChanged: () => void }>) {
    const router = useRouter();
    const [busy, setBusy] = React.useState(false);
    if (row.kind === 'member') return <Item testID={`managed-member-${row.value.id}`} title={row.value.name ?? row.value.id} subtitle={row.value.disabled ? t('managedAccounts.disabled') : `${row.value.machineIds.length} · ${t('settings.machines')}`}
        onPress={() => router.push(`/settings/managed-accounts/${encodeURIComponent(row.value.id)}`)} />;
    const change = async () => {
        if (busy) return;
        if (row.kind === 'machine' && (!member || (!member.machineIds.includes(row.value.id)
            && (member.disabled || !isManagedMachineAssignmentEligible(row.value, allowLegacyRegistration))))) return;
        setBusy(true);
        try {
            if (row.kind === 'invite') {
                if (!await confirmRevokeInvite(credentials, scope, row.value.id)) return;
            } else if (member) {
                const client = createManagedAccountClient(credentials, scope);
                if (member.machineIds.includes(row.value.id)) await client.revokeMachine(row.value.id, member.id);
                else {
                    const result = await client.grantMachine(row.value.id, member.id);
                    if (result.status === 'pending') await Modal.alert(t('managedAccounts.machineAssignments'), t('managedAccounts.awaitingKeys'));
                }
            }
            onChanged();
        } catch { await Modal.alert(t('common.error'), t('errors.operationFailed')); }
        finally { setBusy(false); }
    };
    if (row.kind === 'invite') return <Item title={`${t(row.value.kind === 'member' ? 'managedAccounts.memberInvite' : 'managedAccounts.machineInvite')} · ${row.value.name ?? row.value.id}`}
        subtitle={new Date(row.value.expiresAt).toISOString()} detail={t('managedAccounts.revoke')} loading={busy}
        disabled={busy || row.value.consumedAt !== null || row.value.revokedAt !== null} destructive onPress={change} />;
    const assigned = member?.machineIds.includes(row.value.id) === true;
    const status = member?.machineGrants?.find((grant) => grant.machineId === row.value.id)?.status;
    const eligible = isManagedMachineAssignmentEligible(row.value, allowLegacyRegistration);
    return <Item testID={`managed-machine-${row.value.id}`} title={row.value.metadata?.displayName ?? row.value.metadata?.host ?? row.value.id}
        subtitle={assigned && status ? t(status === 'pending' ? 'managedAccounts.awaitingKeys' : 'managedAccounts.ready')
            : !eligible ? t('managedAccounts.inviteMachinesEnrollHelp') : undefined}
        detail={t(assigned ? 'managedAccounts.revoke' : 'managedAccounts.grant')} selected={assigned} loading={busy}
        disabled={busy || !member || (!assigned && (member.disabled || !eligible))} onPress={change} />;
}

function MemberStatus({ member, credentials, scope, onChanged }: Readonly<{ member: Member; credentials: AuthCredentials; scope: ActiveServerSnapshot; onChanged: () => void }>) {
    const [busy, setBusy] = React.useState(false);
    const change = async () => {
        if (busy) return;
        setBusy(true);
        try { await createManagedAccountClient(credentials, scope).setMemberDisabled(member.id, !member.disabled); onChanged(); }
        catch { await Modal.alert(t('common.error'), t('errors.operationFailed')); }
        finally { setBusy(false); }
    };
    return <Item title={t(member.disabled ? 'managedAccounts.enableMember' : 'managedAccounts.disableMember')} disabled={busy} loading={busy} destructive={!member.disabled} onPress={change} />;
}

const EMPTY_MACHINE_IDS: readonly string[] = Object.freeze([]);

function isManagedMachineAssignmentEligible(machine: Machine | undefined, allowLegacyRegistration = false): machine is Machine {
    if (!machine || machine.revokedAt != null || machine.replacedByMachineId || machine.replacedAt != null) return false;
    // Preassignment requires proven enrollment. The deployed predecessor omitted the marker;
    // manual attempts there remain server-validated, but explicit false never qualifies.
    return machine.managed === true || (machine.managed === undefined && allowLegacyRegistration);
}

const InviteMachineRow = React.memo(function InviteMachineRow({ machine, selected, onToggle }: Readonly<{
    machine: Machine; selected: boolean; onToggle: (id: string) => void;
}>) {
    const { theme } = useUnistyles();
    return <Item testID={`managed-invite-machine-${machine.id}`}
        title={machine.metadata?.displayName ?? machine.metadata?.host ?? machine.id}
        selected={selected} accessibilityRole="checkbox" accessibilityState={{ checked: selected }}
        rightElement={<Icon name={selected ? 'check-square' : 'square'} size={20}
            color={selected ? theme.colors.accent.blue : theme.colors.text.secondary} />}
        showChevron={false} onPress={() => onToggle(machine.id)} />;
});
const inviteMachineKey = (machine: Machine) => machine.id;

// Machine inventory is subscribed only while this picker is actually presented. The modal gives
// it one bounded scroll owner instead of nesting a data-sized list in the invitation form.
function InviteMachinePicker({ selectedMachineIds, onSelectionChange, onClose }: Readonly<{
    selectedMachineIds: readonly string[]; onSelectionChange: (ids: readonly string[]) => void; onClose: () => void;
}>) {
    const machines = useAllMachines();
    const eligible = React.useMemo(() => machines.filter((machine) => isManagedMachineAssignmentEligible(machine)), [machines]);
    const [selectedIds, setSelectedIds] = React.useState(selectedMachineIds);
    const selectedRef = React.useRef(selectedIds);
    selectedRef.current = selectedIds;
    const { height } = useWindowDimensions();
    const toggle = React.useCallback((id: string) => {
        const held = selectedRef.current;
        const next = held.includes(id) ? held.filter((candidate) => candidate !== id) : [...held, id];
        selectedRef.current = next;
        setSelectedIds(next);
        onSelectionChange(next);
    }, [onSelectionChange]);
    const renderItem = React.useCallback(({ item }: { item: Machine }) =>
        <InviteMachineRow machine={item} selected={selectedIds.includes(item.id)} onToggle={toggle} />, [selectedIds, toggle]);
    return <View style={[styles.machinePicker, { height: height * 0.6 }]}>
        <Text>{t('managedAccounts.inviteMachinesHelp')}</Text>
        <FlashList testID="managed-invite-machine-list" data={eligible} keyExtractor={inviteMachineKey}
            renderItem={renderItem} extraData={selectedIds} keyboardShouldPersistTaps="handled"
            ListEmptyComponent={<View testID="managed-invite-no-machines" style={styles.message}>
                <Text>{t('managedAccounts.inviteMachinesEmpty')}</Text>
                <Text>{t('managedAccounts.inviteMachinesEnrollHelp')}</Text>
            </View>} />
        <RoundButton testID="managed-invite-machines-done" title={t('common.done')} onPress={onClose} />
    </View>;
}

function InvitationCreation({ credentials, scope, onCreated }: Readonly<{ credentials: AuthCredentials; scope: ActiveServerSnapshot; onCreated: () => void }>) {
    const [name, setName] = React.useState('');
    const [expiry, setExpiry] = React.useState('');
    const [kind, setKind] = React.useState<'member' | 'machine'>('member');
    const [selectedMachineIds, setSelectedMachineIds] = React.useState(EMPTY_MACHINE_IDS);
    const assignmentEnabled = useFeatureEnabled('accounts.inviteMachineAssignment', RUNTIME_FEATURE_SCOPE);
    const pickerId = React.useRef<string | null>(null);
    const closePicker = React.useCallback(() => {
        if (pickerId.current) Modal.hide(pickerId.current);
        pickerId.current = null;
    }, []);
    React.useEffect(() => {
        setSelectedMachineIds(EMPTY_MACHINE_IDS);
        return closePicker;
    }, [scope.serverId, scope.serverUrl, scope.generation, credentials.token, closePicker]);
    React.useEffect(() => {
        if (!assignmentEnabled || kind !== 'member') closePicker();
    }, [assignmentEnabled, kind, closePicker]);
    const openPicker = () => {
        if (!assignmentEnabled || kind !== 'member') return;
        const id = Modal.show({
            component: InviteMachinePicker,
            props: { selectedMachineIds, onSelectionChange: (ids: readonly string[]) => {
                // A closing picker from a previous authority must not mutate a new invitation.
                if (pickerId.current === id) setSelectedMachineIds(ids);
            } },
            onRequestClose: () => { if (pickerId.current === id) pickerId.current = null; },
            chrome: { kind: 'card', title: t('managedAccounts.inviteMachines'), testID: 'managed-invite-machines-modal', bodyScroll: 'none' },
        });
        pickerId.current = id;
    };
    const { busy, create } = useManagedInviteCreation(credentials, scope, onCreated);
    const submit = async () => {
        const expiresAt = Date.parse(expiry);
        if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(expiry) || !Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            await Modal.alert(t('common.error'), t('managedAccounts.invalidExpiry')); return;
        }
        // Preserve the entire chosen intent; the server validates the set atomically.
        if (await create(kind, name, expiresAt, kind === 'member' ? selectedMachineIds : EMPTY_MACHINE_IDS)) {
            setSelectedMachineIds(EMPTY_MACHINE_IDS);
        }
    };
    return <View style={styles.form}>
        <ItemGroup title={t('managedAccounts.createInvite')}>
            <Item testID="managed-invite-kind-member" title={t('managedAccounts.memberInvite')} selected={kind === 'member'} disabled={busy} onPress={() => setKind('member')} />
            <Item testID="managed-invite-kind-machine" title={t('managedAccounts.machineInvite')} selected={kind === 'machine'} disabled={busy} onPress={() => {
                setKind('machine');
                setSelectedMachineIds(EMPTY_MACHINE_IDS);
            }} />
        </ItemGroup>
        <FieldItem label={t('managedAccounts.name')}><TextInput testID="managed-invite-name" style={styles.input} value={name} onChangeText={setName} accessibilityLabel={t('managedAccounts.name')} editable={!busy} /></FieldItem>
        <FieldItem label={t('managedAccounts.expiresAt')} supportingText={t('managedAccounts.expiresHelp')}><TextInput testID="managed-invite-expiry" style={styles.input} value={expiry} onChangeText={setExpiry}
            accessibilityLabel={t('managedAccounts.expiresAt')} autoCapitalize="none" autoCorrect={false} editable={!busy} /></FieldItem>
        {kind === 'member' && assignmentEnabled ? <Item testID="managed-invite-machines" title={t('managedAccounts.inviteMachines')}
            subtitle={selectedMachineIds.length > 0 ? t('managedAccounts.inviteMachinesSelected', { count: selectedMachineIds.length }) : t('managedAccounts.inviteMachinesOptional')}
            disabled={busy} onPress={openPicker} /> : null}
        {kind === 'member' && selectedMachineIds.length > 0 ? <Item testID="managed-invite-clear-machines"
            title={t('managedAccounts.inviteMachinesClear')}
            subtitle={!assignmentEnabled ? t('managedAccounts.inviteMachinesUnavailable') : undefined}
            disabled={busy} showChevron={false} onPress={() => { closePicker(); setSelectedMachineIds(EMPTY_MACHINE_IDS); }} /> : null}
        <RoundButton testID="managed-invite-create" title={t('managedAccounts.createInvite')} loading={busy} disabled={busy} onPress={submit} />
    </View>;
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center', backgroundColor: theme.colors.background.canvas },
    message: { padding: 16, gap: 16 },
    form: { padding: 16, gap: 16 },
    machinePicker: { padding: 16, gap: 16 },
    input: { padding: 12, borderWidth: 1, borderRadius: 8, borderColor: theme.colors.border.default, color: theme.colors.text.primary, backgroundColor: theme.colors.surface.base },
}));
