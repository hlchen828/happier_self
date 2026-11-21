import * as React from 'react';
import { Platform } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';

import { Item } from '@/components/ui/lists/Item';
import { ItemGroup } from '@/components/ui/lists/ItemGroup';
import { Switch } from '@/components/ui/forms/Switch';
import { Icon } from '@/components/ui/icons/Icon';
import { Modal } from '@/modal';
import { t } from '@/text';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import {
    getAndroidPetOverlayState,
    requestAndroidPetOverlayStart,
    stopAndroidPetOverlay,
    subscribeAndroidPetOverlay,
} from '@/components/pets/android/androidPetOverlay';

export function PetsAndroidOverlaySettingsSection(): React.ReactElement | null {
    if (Platform.OS !== 'android') return null;
    return <AndroidOverlaySettings />;
}

function AndroidOverlaySettings(): React.ReactElement {
    const { theme } = useUnistyles();
    const selectedPet = useSelectedPetPackage();
    const state = React.useSyncExternalStore(subscribeAndroidPetOverlay, getAndroidPetOverlayState);
    const toggle = React.useCallback(async (enabled: boolean) => {
        try {
            if (enabled) await requestAndroidPetOverlayStart();
            else await stopAndroidPetOverlay();
        } catch (error) {
            Modal.alert(t('common.error'), error instanceof Error ? error.message : String(error));
        }
    }, []);
    return (
        <ItemGroup title={t('settingsPets.androidOverlayTitle')} footer={t('settingsPets.androidOverlayFooter')}>
            <Item
                title={t('settingsPets.androidOverlayTitle')}
                subtitle={!state.available ? t('settingsPets.androidOverlayUnavailable') : !selectedPet.enabled ? t('settingsPets.enabledTitle') : state.error ?? t('settingsPets.androidOverlaySubtitle')}
                icon={<Icon name="device-mobile" size={24} color={theme.colors.accent.blue} />}
                rightElement={(
                    <Switch
                        testID="settings-pets-android-overlay-enabled"
                        value={state.running || state.starting || state.checking}
                        disabled={!state.available || (!selectedPet.enabled && !state.running) || state.checking || state.starting || state.stopping}
                        onValueChange={toggle}
                    />
                )}
                showChevron={false}
            />
        </ItemGroup>
    );
}
