import * as React from 'react';
import { AppState, Platform } from 'react-native';
import { Asset } from 'expo-asset';
import { PET_ANIMATION_ROWS_V1, PET_ATLAS_V1 } from '@happier-dev/protocol';
import { useUnistyles } from 'react-native-unistyles';

import { usePetCompanionActivityModel } from '@/components/pets/activity';
import { usePetCompanionTrayDismissals } from '@/components/pets/activity/usePetCompanionTrayDismissals';
import { usePetSpritesheetSource } from '@/components/pets/render/usePetSpritesheetSource';
import { useSelectedPetPackage } from '@/components/pets/source/useSelectedPetPackage';
import type { SelectedPetPackageSource } from '@/components/pets/source/resolveSelectedPetPackage';
import { useReducedMotionPreference } from '@/hooks/ui/useReducedMotionPreference';
import { useActiveServerSnapshot } from '@/hooks/server/useActiveServerSnapshot';
import { storage, useLocalSetting } from '@/sync/domains/state/storage';
import { createDefaultActionExecutor } from '@/sync/ops/actions/defaultActionExecutor';
import { t } from '@/text';
import { fireAndForget } from '@/utils/system/fireAndForget';

import {
    failAndroidPetOverlayStart,
    getAndroidPetOverlayState,
    initializeAndroidPetOverlay,
    refreshAndroidPetOverlayState,
    stopAndroidPetOverlay,
    subscribeAndroidPetOverlay,
    syncAndroidPetOverlay,
    type AndroidPetOverlayAction,
} from './androidPetOverlay';
import { registerAndroidPetOverlayTask } from './registerAndroidPetOverlayTask';
import { buildAndroidPetOverlayPresentation } from './androidPetOverlayPresentation';

export function AndroidPetOverlayRuntimeMount(): React.ReactElement | null {
    if (Platform.OS !== 'android') return null;
    return <AndroidPetOverlayRuntime />;
}

function AndroidPetOverlayRuntime(): React.ReactElement | null {
    const state = React.useSyncExternalStore(subscribeAndroidPetOverlay, getAndroidPetOverlayState);
    const selectedPet = useSelectedPetPackage();
    const server = useActiveServerSnapshot();
    const actionRef = React.useRef<((action: AndroidPetOverlayAction) => void) | null>(null);
    const pendingActions = React.useRef<AndroidPetOverlayAction[]>([]);
    React.useEffect(() => {
        registerAndroidPetOverlayTask();
        const dispose = initializeAndroidPetOverlay((action) => {
            if (actionRef.current) actionRef.current(action);
            else pendingActions.current.push(action);
        });
        return () => {
            pendingActions.current = [];
            dispose();
        };
    }, []);
    React.useEffect(() => {
        const subscription = AppState.addEventListener('change', (next) => {
            if (next === 'active') fireAndForget(refreshAndroidPetOverlayState(), { tag: 'PetOverlay.refresh' });
        });
        return () => subscription.remove();
    }, []);
    React.useEffect(() => () => {
        pendingActions.current = [];
        fireAndForget(stopAndroidPetOverlay(), { tag: 'PetOverlay.serverChanged' });
    }, [server.serverId]);
    React.useEffect(() => {
        if (!state.running && !state.starting && !state.checking) pendingActions.current = [];
    }, [state.running, state.starting, state.checking]);
    React.useEffect(() => {
        if (!selectedPet.enabled && (state.running || state.starting || state.checking)) {
            fireAndForget(stopAndroidPetOverlay(), { tag: 'PetOverlay.disabled' });
        }
    }, [selectedPet.enabled, state.running, state.starting, state.checking]);
    if ((!state.running && !state.starting) || !selectedPet.enabled || !selectedPet.source) return null;
    return <AndroidPetOverlayActivityRuntime source={selectedPet.source} actionRef={actionRef} pendingActions={pendingActions} />;
}

function AndroidPetOverlayActivityRuntime(props: Readonly<{
    source: SelectedPetPackageSource;
    actionRef: React.MutableRefObject<((action: AndroidPetOverlayAction) => void) | null>;
    pendingActions: React.MutableRefObject<AndroidPetOverlayAction[]>;
}>): null {
    const { theme } = useUnistyles();
    const { dismissedTrayItemKeys, dismissTrayItem } = usePetCompanionTrayDismissals();
    const activity = usePetCompanionActivityModel({ dismissedTrayItemKeys });
    const spritesheet = usePetSpritesheetSource(props.source);
    const [spriteUri, setSpriteUri] = React.useState<string | null>(null);
    const sizeScale = useLocalSetting('petsCompanionSizeScale');
    const reducedMotion = useReducedMotionPreference();
    const connected = storage((current) => current.socketStatus === 'connected');
    const executor = React.useMemo(() => createDefaultActionExecutor(), []);
    const overlayState = React.useSyncExternalStore(subscribeAndroidPetOverlay, getAndroidPetOverlayState);

    React.useEffect(() => {
        let active = true;
        setSpriteUri(null);
        void (async () => {
            if (typeof spritesheet === 'number') {
                const asset = Asset.fromModule(spritesheet);
                await asset.downloadAsync();
                if (active) setSpriteUri(asset.localUri ?? asset.uri);
            } else {
                const source = Array.isArray(spritesheet) ? spritesheet[0] : spritesheet;
                const uri = typeof source === 'string' ? source : source && 'uri' in source ? source.uri : null;
                if (!uri) throw new Error('Pet spritesheet unavailable');
                if (active) setSpriteUri(uri);
            }
        })().catch((error) => {
            if (active) {
                failAndroidPetOverlayStart(error);
                fireAndForget(stopAndroidPetOverlay(), { tag: 'PetOverlay.assetFailed' });
            }
        });
        return () => { active = false; };
    }, [spritesheet]);

    React.useEffect(() => {
        const handler = (action: AndroidPetOverlayAction) => {
            const item = activity.trayItems.find((entry) => entry.sessionId === action.sessionId && entry.dismissKey === action.dismissKey);
            if (action.type === 'dismiss' && item) dismissTrayItem(item);
            if (action.type === 'openSession' && activity.trayItems.some((entry) => entry.sessionId === action.sessionId)) {
                fireAndForget(executor.execute('session.open', { sessionId: action.sessionId }, { defaultSessionId: action.sessionId }), {
                    tag: 'PetOverlay.openSession',
                });
            }
        };
        props.actionRef.current = handler;
        const pending = props.pendingActions.current;
        props.pendingActions.current = [];
        for (const action of pending) handler(action);
        return () => {
            if (props.actionRef.current === handler) props.actionRef.current = null;
        };
    }, [activity.trayItems, dismissTrayItem, executor, props.actionRef, props.pendingActions]);

    const payload = React.useMemo(() => JSON.stringify({
        state: activity.state,
        connected,
        spriteUri,
        sprite: {
            ...PET_ATLAS_V1,
            animations: Object.fromEntries(PET_ANIMATION_ROWS_V1.map((row) => [row.state, row])),
        },
        reducedMotion,
        sizeScale,
        ...buildAndroidPetOverlayPresentation(activity, theme),
        labels: {
            title: t('settingsPets.androidOverlayTitle'),
            stop: t('settingsPets.overlayClosePetAction'),
            activity: t('settingsPets.overlayTrayTitle'),
            disconnected: t('settingsPets.androidOverlayDisconnected'),
            open: t('common.open'),
            close: t('common.close'),
            statuses: {
                waiting: t('settingsPets.overlayStatusWaiting'),
                failed: t('settingsPets.overlayStatusFailed'),
                review: t('settingsPets.overlayStatusReview'),
                running: t('settingsPets.overlayStatusRunning'),
                idle: t('settingsPets.androidOverlayIdle'),
            },
        },
    }), [activity, connected, reducedMotion, sizeScale, spriteUri, theme]);

    React.useEffect(() => {
        if (spriteUri) fireAndForget(syncAndroidPetOverlay(payload), { tag: 'PetOverlay.sync' });
    }, [payload, spriteUri, overlayState.running]);
    return null;
}
