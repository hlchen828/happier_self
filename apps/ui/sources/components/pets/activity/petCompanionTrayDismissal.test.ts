import { describe, expect, it } from 'vitest';
import { act } from 'react-test-renderer';
import { renderHook } from '@/dev/testkit';
import { storage } from '@/sync/domains/state/storage';
import { loadLocalSettings } from '@/sync/domains/state/persistence';
import { usePetCompanionTrayDismissals } from './usePetCompanionTrayDismissals';
import type { PetCompanionTrayItem } from './petCompanionActivityTypes';

import {
    PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX,
    appendDismissedPetCompanionTrayItemKey,
    normalizeDismissedPetCompanionTrayItemKeys,
} from './petCompanionTrayDismissal';

describe('pet companion tray dismissal keys', () => {
    it('persists every dismissal in a batch before React rerenders', async () => {
        const previous = storage.getState().localSettings.petsDismissedCompanionTrayItemKeys;
        storage.getState().applyLocalSettings({ petsDismissedCompanionTrayItemKeys: [] });
        const item = (key: string): PetCompanionTrayItem => ({
            id: key, dismissKey: key, sessionId: key, status: 'waiting', priority: 0,
            title: key, subtitle: null, activityAtMs: null, expiresAtMs: null,
            actions: { open: true, dismiss: true, quickReply: true },
        });
        const hook = await renderHook(() => usePetCompanionTrayDismissals());
        let mounted = true;
        try {
            const dismiss = hook.getCurrent().dismissTrayItem;
            await act(async () => {
                dismiss(item('waiting:session-a:live'));
                dismiss(item('waiting:session-b:live'));
            });
            expect(loadLocalSettings().petsDismissedCompanionTrayItemKeys).toEqual([
                'waiting:session-a:live', 'waiting:session-b:live',
            ]);
            await hook.unmount();
            mounted = false;
            const remounted = await renderHook(() => usePetCompanionTrayDismissals());
            try {
                expect([...remounted.getCurrent().dismissedTrayItemKeys]).toEqual([
                    'waiting:session-a:live', 'waiting:session-b:live',
                ]);
            } finally {
                await remounted.unmount();
            }
        } finally {
            if (mounted) await hook.unmount();
            storage.getState().applyLocalSettings({ petsDismissedCompanionTrayItemKeys: previous });
        }
    });

    it('deduplicates dismissed activity-version keys and keeps the most recent bounded set', () => {
        const staleKeys = Array.from(
            { length: PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX + 2 },
            (_, index) => `waiting:session:${index}`,
        );

        const next = appendDismissedPetCompanionTrayItemKey(staleKeys, 'waiting:session:new');

        expect(next).toHaveLength(PET_COMPANION_DISMISSED_TRAY_ITEM_KEYS_MAX);
        expect(next).not.toContain('waiting:session:0');
        expect(next).toContain('waiting:session:new');
        expect(appendDismissedPetCompanionTrayItemKey(next, 'waiting:session:new')).toEqual(next);
    });

    it('ignores malformed persisted dismissal values', () => {
        expect(normalizeDismissedPetCompanionTrayItemKeys([
            'waiting:session:1',
            '',
            '   ',
            42,
            'failed:session:2',
        ])).toEqual(['waiting:session:1', 'failed:session:2']);
    });
});
