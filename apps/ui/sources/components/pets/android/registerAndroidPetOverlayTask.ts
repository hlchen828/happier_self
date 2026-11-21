import { AppRegistry } from 'react-native';

import { getAndroidPetOverlayState, subscribeAndroidPetOverlay } from './androidPetOverlay';

let registered = false;

export function registerAndroidPetOverlayTask(): void {
    if (registered) return;
    registered = true;
    AppRegistry.registerHeadlessTask('HappierPetOverlay', () => async () => {
        await new Promise<void>((resolve) => {
            const finished = () => {
                const state = getAndroidPetOverlayState();
                return state.stopping || (!state.running && !state.starting);
            };
            if (finished()) {
                resolve();
                return;
            }
            const unsubscribe = subscribeAndroidPetOverlay(() => {
                if (!finished()) return;
                unsubscribe();
                resolve();
            });
        });
    });
}
