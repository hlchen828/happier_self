import type { FeaturesPayloadDelta } from './types';
import { configuredAdministratorPublicKey } from '@/app/account/managedAccounts/policy';

export function resolveManagedMachineAccessFeature(env: NodeJS.ProcessEnv): FeaturesPayloadDelta {
    const enabled = configuredAdministratorPublicKey(env) !== null;
    return { features: { accounts: { machineAccess: { enabled }, inviteMachineAssignment: { enabled } } } };
}
