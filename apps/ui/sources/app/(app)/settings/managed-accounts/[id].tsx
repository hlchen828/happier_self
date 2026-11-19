import { useLocalSearchParams } from 'expo-router';
import { ManagedAccountsView } from '@/components/settings/account/ManagedAccountsView';
export default function MemberMachineAssignments() {
    const { id } = useLocalSearchParams<{ id: string }>();
    return <ManagedAccountsView memberId={id} />;
}
