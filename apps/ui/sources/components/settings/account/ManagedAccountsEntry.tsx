import * as React from 'react';
import { useRouter } from 'expo-router';
import { useFocusEffect } from '@react-navigation/native';
import { useAuth } from '@/auth/context/AuthContext';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { createManagedAccountClient } from '@/sync/api/account/apiManagedAccounts';
import { subscribeManagedAccessChanged } from '@/sync/runtime/managedAccessChanged';
import { Item } from '@/components/ui/lists/Item';
import { t } from '@/text';

export function ManagedAccountsEntry() {
    const enabled = useFeatureEnabled('accounts.machineAccess');
    return enabled ? <ManagedAdminEntry /> : null;
}
function ManagedAdminEntry() {
    const { credentials, credentialsScope } = useAuth();
    const server = useActiveServerSnapshot();
    const router = useRouter();
    const [access, setAccess] = React.useState<Readonly<{ admin: boolean; generation: number; token: string }> | null>(null);
    const scoped = credentialsScope?.serverId === server.serverId && credentialsScope.serverUrl === server.serverUrl && credentialsScope.generation === server.generation;
    useFocusEffect(React.useCallback(() => {
        if (!credentials || !credentialsScope || !scoped) return;
        const controller = new AbortController();
        const refresh = () => {
            void createManagedAccountClient(credentials, credentialsScope, { signal: controller.signal }).getAccess().then((value) => {
                if (!controller.signal.aborted) setAccess({ admin: value.managed && value.role === 'admin', generation: server.generation, token: credentials.token });
            }).catch(() => { if (!controller.signal.aborted) setAccess(null); });
        };
        refresh();
        const unsubscribe = subscribeManagedAccessChanged(server.serverId, refresh);
        return () => { controller.abort(); unsubscribe(); };
    }, [credentials, credentialsScope, scoped, server.serverId, server.generation]));
    if (!scoped || !access?.admin || access.generation !== server.generation || access.token !== credentials?.token) return null;
    return <Item testID="settings-managed-accounts" title={t('managedAccounts.title')} subtitle={t('managedAccounts.members')}
        onPress={() => router.push('/settings/managed-accounts')} />;
}
