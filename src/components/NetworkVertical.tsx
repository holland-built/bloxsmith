import { useNetworkData } from '../hooks/useNetworkData';
import { DegradedState } from './DegradedState';
import { SubnetsTable } from './SubnetsTable';
import { LeaseSummary } from './LeaseSummary';
import { ZonesTable } from './ZonesTable';

export function NetworkVertical() {
  const { data, loading, error } = useNetworkData();

  if (loading) {
    return <DegradedState mode="loading" />;
  }

  if (error) {
    return <DegradedState mode="error" />;
  }

  const isEmpty =
    data === null ||
    (data.subnets.length === 0 &&
      data.leases.length === 0 &&
      data.zones.length === 0 &&
      data.views.length === 0);

  if (isEmpty) {
    return <DegradedState mode="empty" />;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem' }}>
      <SubnetsTable subnets={data!.subnets} />
      <LeaseSummary leases={data!.leases} />
      <ZonesTable zones={data!.zones} />
    </div>
  );
}
