import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import type { AuthCredentials } from '@/auth/storage/tokenStorage';
import { Modal } from '@/modal';
import type { ActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { createManagedAccountClient } from '@/sync/api/account/apiManagedAccounts';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { Text } from '@/components/ui/text/Text';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { setClipboardStringSafe } from '@/utils/ui/clipboard';

type ManagedInviteKind = 'member' | 'machine';
const RUNTIME_FEATURE_SCOPE = Object.freeze({ scopeKind: 'runtime' as const });

function InvitationTokenModal({ token, onClose }: Readonly<{ token: string; onClose: () => void }>) {
    const [copied, setCopied] = React.useState(false);
    const copy = async () => {
        if (!await setClipboardStringSafe(token)) {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
            return;
        }
        setCopied(true);
    };
    return <View style={styles.container}>
        <Text>{t('managedAccounts.invitationOnce')}</Text>
        <Text testID="managed-invitation-token" selectable>{token}</Text>
        <RoundButton title={copied ? t('common.copied') : t('common.copy')} onPress={copy} />
        <RoundButton title={t('common.close')} onPress={onClose} />
    </View>;
}

/** Presents a freshly created managed invite token once, in a modal with copy affordance. */
function presentInvitationToken(token: string): void {
    Modal.show({
        component: InvitationTokenModal,
        props: { token },
        chrome: { kind: 'card', title: t('managedAccounts.invitationCreated'), testID: 'managed-invitation-token-modal' },
    });
}

/** Creates a managed invite and presents its one-time token; tracks busy state. */
export function useManagedInviteCreation(credentials: AuthCredentials, scope: ActiveServerSnapshot, onCreated: () => void): Readonly<{
    busy: boolean;
    create: (kind: ManagedInviteKind, name: string, expiresAt: number, machineIds?: readonly string[]) => Promise<boolean>;
}> {
    const [busy, setBusy] = React.useState(false);
    const assignmentEnabled = useFeatureEnabled('accounts.inviteMachineAssignment', RUNTIME_FEATURE_SCOPE);
    const create = async (kind: ManagedInviteKind, name: string, expiresAt: number, machineIds?: readonly string[]): Promise<boolean> => {
        if (busy) return false;
        if (kind === 'member' && machineIds?.length && !assignmentEnabled) {
            await Modal.alert(t('common.error'), t('managedAccounts.inviteMachinesUnavailable'));
            return false;
        }
        setBusy(true);
        try {
            const result = await createManagedAccountClient(credentials, scope).createInvite({
                kind,
                expiresAt,
                ...(name.trim() ? { name: name.trim() } : {}),
                ...(kind === 'member' && assignmentEnabled && machineIds?.length ? { machineIds: [...machineIds] } : {}),
            });
            presentInvitationToken(result.token);
            onCreated();
            return true;
        } catch {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
            return false;
        } finally {
            setBusy(false);
        }
    };
    return { busy, create };
}

/** Asks for confirmation before revoking an invite; returns true only when it was revoked. */
export async function confirmRevokeInvite(credentials: AuthCredentials, scope: ActiveServerSnapshot, inviteId: string): Promise<boolean> {
    const confirmed = await Modal.confirm(
        t('managedAccounts.revokeInviteTitle'),
        t('managedAccounts.revokeInviteMessage'),
        { confirmText: t('managedAccounts.revoke'), cancelText: t('common.cancel'), destructive: true },
    );
    if (!confirmed) return false;
    await createManagedAccountClient(credentials, scope).revokeInvite(inviteId);
    return true;
}

const styles = StyleSheet.create((theme) => ({
    container: { padding: 16, gap: 16 },
}));
