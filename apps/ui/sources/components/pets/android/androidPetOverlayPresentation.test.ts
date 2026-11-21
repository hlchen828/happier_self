import { describe, expect, it } from 'vitest';

import { buildPetCompanionActivityModel } from '@/components/pets/activity/buildPetCompanionActivityModel';
import { createSessionFixture } from '@/dev/testkit/fixtures/sessionFixtures';
import { lightTheme, darkTheme } from '@/theme';

import { buildAndroidPetOverlayPresentation } from './androidPetOverlayPresentation';

describe('Android pet native presentation payload', () => {
    it.each([lightTheme, darkTheme])('serializes canonical activity with macOS semantic status colors', (theme) => {
        const activity = buildPetCompanionActivityModel({
            nowMs: 2_000,
            sessions: [
                createSessionFixture({ id: 'failed', latestTurnStatus: 'failed', latestTurnStatusObservedAt: 1_000 }),
                createSessionFixture({ id: 'running', active: true, thinking: true, thinkingAt: 1_000 }),
                createSessionFixture({ id: 'unread' }),
            ],
            signalsBySessionId: {
                unread: {
                    hasFailure: false,
                    hasUnreadMessages: true,
                    latestThinkingActivityAtMs: null,
                    latestMeaningfulActivityAtMs: 1_000,
                    lastMessageSubtitle: '请检查完整的工具结果',
                    pendingMessageCount: 0,
                },
            },
        });
        expect(activity.trayItems.map((item) => item.status).sort()).toEqual(['failed', 'running', 'waiting']);
        const submitted = JSON.parse(JSON.stringify(buildAndroidPetOverlayPresentation(activity, theme)));
        expect(submitted.colors).toMatchObject({
            statuses: {
                waiting: theme.colors.status.actionRequired,
                failed: theme.colors.status.error,
                review: theme.colors.state.success.foreground,
                running: theme.colors.status.connected,
            },
        });
        expect(submitted.items).toEqual(activity.trayItems.map((item) => ({
            sessionId: item.sessionId,
            dismissKey: item.dismissKey,
            title: item.title,
            status: item.status,
            subtitle: item.subtitle,
        })));
    });
});
