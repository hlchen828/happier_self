import * as React from 'react';
import { View } from 'react-native';
import { useRouter } from 'expo-router';
import { StyleSheet } from 'react-native-unistyles';
import { useAuth } from '@/auth/context/AuthContext';
import { completeManagedAccountEnrollment, enrollManagedAccount } from '@/auth/flows/enrollManagedAccount';
import { getActiveServerSnapshot } from '@/sync/domains/server/serverRuntime';
import { FieldItem } from '@/components/ui/forms/FieldItem';
import { Text, TextInput } from '@/components/ui/text/Text';
import { RoundButton } from '@/components/ui/buttons/RoundButton';
import { ItemList } from '@/components/ui/lists/ItemList';
import { layout } from '@/components/ui/layout/layout';
import { UnauthenticatedSplitShell } from '@/components/onboarding/unauthShell';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useFeatureEnabled } from '@/hooks/server/useFeatureEnabled';

const ignoreBrandHeroGetStarted = () => {};

export function ManagedInviteEntry() {
    const enabled = useFeatureEnabled('accounts.machineAccess');
    const router = useRouter();
    return enabled ? <RoundButton title={t('managedAccounts.join')} onPress={() => router.push('/join')} /> : null;
}

export function InviteEnrollmentForm() {
    const auth = useAuth();
    const router = useRouter();
    const [inviteToken, setInviteToken] = React.useState('');
    const [busy, setBusy] = React.useState(false);
    const join = async () => {
        if (busy || !inviteToken.trim()) return;
        const scope = getActiveServerSnapshot();
        setBusy(true);
        try {
            const enrollment = await enrollManagedAccount(inviteToken);
            const current = getActiveServerSnapshot();
            if (current.serverId !== scope.serverId || current.generation !== scope.generation) return;
            await auth.loginWithCredentials(enrollment.credentials);
            await completeManagedAccountEnrollment(enrollment);
            setInviteToken('');
            router.dismissTo('/');
        } catch {
            await Modal.alert(t('common.error'), t('errors.operationFailed'));
        } finally {
            setBusy(false);
        }
    };
    return (
        <UnauthenticatedSplitShell stepId="invite" isWelcomeStep={false} allowMobileBrandHero={false}
            onOpenRelayCustomFlow={() => router.push('/setup')} onBrandHeroGetStarted={ignoreBrandHeroGetStarted}
            onBack={() => router.back()} testID="managed-invite-enrollment">
            <ItemList keyboardAware containerStyle={styles.content}>
                <View style={styles.form}>
                    <Text>{t('managedAccounts.invitationHelp')}</Text>
                    <FieldItem label={t('managedAccounts.inviteToken')}>
                        <TextInput testID="managed-invite-code" style={styles.input} accessibilityLabel={t('managedAccounts.inviteToken')}
                            value={inviteToken} onChangeText={setInviteToken} secureTextEntry autoCapitalize="none" autoCorrect={false} editable={!busy} />
                    </FieldItem>
                    <RoundButton testID="managed-invite-submit" title={t('managedAccounts.joinAction')} loading={busy} disabled={busy || !inviteToken.trim()} onPress={join} />
                </View>
            </ItemList>
        </UnauthenticatedSplitShell>
    );
}
const styles = StyleSheet.create((theme) => ({
    content: { width: '100%', maxWidth: layout.maxWidth, alignSelf: 'center' },
    form: { padding: 16, gap: 16 },
    input: { padding: 12, borderWidth: 1, borderRadius: 8, borderColor: theme.colors.border.default, color: theme.colors.text.primary, backgroundColor: theme.colors.surface.base },
}));
