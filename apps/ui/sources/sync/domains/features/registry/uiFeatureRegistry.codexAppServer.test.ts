import { describe, expect, it } from 'vitest';

import {
    getUiFeatureDefinition,
    shouldTrackUiFeatureEffective,
    shouldTrackUiFeaturePreference,
} from './uiFeatureRegistry';
import { listUiFeatureToggleDefinitions } from './uiFeatureToggles';

const CODEX_APP_SERVER_FEATURE_IDS = [
    'providers.codex.appServer.goals',
    'providers.codex.appServer.plugins',
    'providers.codex.appServer.structuredInput',
    'providers.codex.appServer.permissionProfiles',
] as const;

describe('runtime-only UI feature registry', () => {
    it('does not expose deployment-managed account policy as a user preference', () => {
        expect(shouldTrackUiFeaturePreference('accounts.machineAccess')).toBe(false);
        expect(getUiFeatureDefinition('accounts.machineAccess').settingsToggle).toBeUndefined();
        expect(listUiFeatureToggleDefinitions().some((definition) => definition.featureId === 'accounts.machineAccess')).toBe(false);
    });
    it('registers Codex app-server feature ids as runtime-only UI features', () => {
        for (const featureId of CODEX_APP_SERVER_FEATURE_IDS) {
            expect(getUiFeatureDefinition(featureId).settingsToggle).toBeUndefined();
        }
    });

    it('does not expose Codex app-server capability feature ids as independent settings toggles', () => {
        const toggleIds = new Set(listUiFeatureToggleDefinitions().map((definition) => definition.featureId));

        for (const featureId of CODEX_APP_SERVER_FEATURE_IDS) {
            expect(toggleIds.has(featureId)).toBe(false);
            expect(shouldTrackUiFeaturePreference(featureId)).toBe(false);
            expect(shouldTrackUiFeatureEffective(featureId)).toBe(true);
        }
    });
});
