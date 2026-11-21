import type { useUnistyles } from 'react-native-unistyles';

import type { PetCompanionActivityModel, PetCompanionTrayItem } from '@/components/pets/activity/petCompanionActivityTypes';

export function buildAndroidPetOverlayPresentation(
    activity: PetCompanionActivityModel,
    theme: ReturnType<typeof useUnistyles>['theme'],
) {
    return {
        items: activity.trayItems.map((item) => ({
            sessionId: item.sessionId,
            dismissKey: item.dismissKey,
            title: item.title,
            status: item.status,
            subtitle: item.subtitle,
        })),
        colors: {
            background: theme.colors.surface.base,
            text: theme.colors.text.primary,
            secondary: theme.colors.text.secondary,
            accent: theme.colors.accent.blue,
            // Same semantic roles as the macOS activity tray; classification stays with the activity model.
            statuses: {
                waiting: theme.colors.status.actionRequired,
                failed: theme.colors.status.error,
                review: theme.colors.state.success.foreground,
                running: theme.colors.status.connected,
            } satisfies Record<PetCompanionTrayItem['status'], string>,
        },
    };
}
