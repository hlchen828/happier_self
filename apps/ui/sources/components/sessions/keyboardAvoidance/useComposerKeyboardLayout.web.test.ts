import { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderHook, standardCleanup } from '@/dev/testkit';

const webHookState = vi.hoisted(() => ({
    windowHeight: 800,
}));

vi.mock('react-native', async () => {
    const { createReactNativeWebMock } = await import('@/dev/testkit/mocks/reactNative');
    return createReactNativeWebMock({
        useWindowDimensions: () => ({
            width: 1024,
            height: webHookState.windowHeight,
            scale: 1,
            fontScale: 1,
        }),
    });
});

vi.mock('react-native-reanimated', async () => {
    const React = await import('react');
    return {
        useSharedValue: <T,>(value: T) => React.useRef({ value }).current,
    };
});

type FakeVisualViewport = Readonly<{ width: number; height: number; offsetTop: number }>;

/** The hook reads browser globals directly; the vitest env here is `node`, so install fakes. */
function installWebGlobals(options: Readonly<{
    visualViewport: FakeVisualViewport;
    coarsePointer: boolean;
    innerHeight?: number;
    focusedEditable?: boolean;
}>): () => void {
    const {
        visualViewport,
        coarsePointer,
        innerHeight = 800,
        focusedEditable = true,
    } = options;
    const win = {
        innerHeight,
        visualViewport: {
            ...visualViewport,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
        },
        matchMedia: (query: string) => ({ matches: coarsePointer && query === '(any-pointer: coarse)' }),
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
    };
    const doc = { activeElement: focusedEditable ? { tagName: 'INPUT' } : { tagName: 'BODY' } };
    (globalThis as { window?: unknown }).window = win;
    (globalThis as { document?: unknown }).document = doc;
    return () => {
        delete (globalThis as { window?: unknown }).window;
        delete (globalThis as { document?: unknown }).document;
    };
}

describe('useComposerKeyboardLayout web', () => {
    beforeEach(() => {
        standardCleanup();
        webHookState.windowHeight = 800;
    });

    afterEach(() => {
        // The per-test fake globals are removed by each test's own restore call.
    });

    it('does not reserve the measured composer height inside the transcript inset', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        act(() => {
            hook.getCurrent().setComposerMeasuredHeight(127);
        });

        expect(hook.getCurrent().composerHeight.value).toBe(127);
        expect(hook.getCurrent().listBottomInset.value).toBe(0);
    });

    it('caps available panel height to the measured scaffold container', async () => {
        const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
        const hook = await renderHook(() => useComposerKeyboardLayout({
            availablePanelMaxHeight: 420,
            headerHeight: 100,
            safeAreaBottom: 0,
        }));

        expect(hook.getCurrent().availablePanelHeight.value).toBe(420);
    });

    it('lifts the composer above a software keyboard on a wide touchscreen (unfolded foldable)', async () => {
        // A wide viewport (>= 768) that width alone would classify as a desktop host,
        // but the device is touch-primary and the focused input is covered by a
        // software keyboard (visual viewport is much shorter than the layout viewport).
        const restore = installWebGlobals({
            visualViewport: { width: 1024, height: 480, offsetTop: 0 },
            coarsePointer: true,
            innerHeight: 800,
            focusedEditable: true,
        });
        try {
            const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
            const hook = await renderHook(() => useComposerKeyboardLayout({
                headerHeight: 100,
                safeAreaBottom: 0,
            }));

            // 800 (layout) - 480 (visual) - 0 (offset) = 320px of keyboard, >= the 80px floor.
            expect(hook.getCurrent().bottomInset.value).toBe(320);
        } finally {
            restore();
        }
    });

    it('keeps the composer unlifted on a wide desktop host even when the visual viewport is smaller', async () => {
        // A fine-pointer desktop (e.g. pinch zoom) also shrinks the visual viewport; the
        // composer must not lift as if a software keyboard covered it.
        const restore = installWebGlobals({
            visualViewport: { width: 1440, height: 480, offsetTop: 0 },
            coarsePointer: false,
            innerHeight: 800,
            focusedEditable: true,
        });
        try {
            const { useComposerKeyboardLayout } = await import('./useComposerKeyboardLayout.web');
            const hook = await renderHook(() => useComposerKeyboardLayout({
                headerHeight: 100,
                safeAreaBottom: 0,
            }));

            expect(hook.getCurrent().bottomInset.value).toBe(0);
        } finally {
            restore();
        }
    });
});
