import { useNetworkData } from '../hooks/useNetworkData';
import { DegradedState } from './DegradedState';
import { SubnetsTable } from './SubnetsTable';
import { LeaseSummary } from './LeaseSummary';
import { ZonesTable } from './ZonesTable';

export function NetworkVertical() {
  const { data, loading, error, refetch } = useNetworkData();

  if (loading) {
    return <DegradedState mode="loading" />;
  }

  if (error) {
    return <DegradedState mode="error" onRetry={refetch} />;
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
      <div id="section-subnets" style={{ display: 'contents' }}>
        <SubnetsTable subnets={data!.subnets} />
      </div>
      <div id="section-leases" style={{ display: 'contents' }}>
        <LeaseSummary leases={data!.leases} />
      </div>
      <div id="section-zones" style={{ display: 'contents' }}>
        <ZonesTable zones={data!.zones} />
      </div>
    </div>
  );
}
