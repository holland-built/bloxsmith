import { useHubData } from '../hooks/useHubData';
import { DegradedState } from './DegradedState';
import { HubTickerStrip } from './HubTickerStrip';
import { HubBento } from './HubBento';
import './HubView.css';

export function HubView() {
  const { metrics, loading, error, refetch } = useHubData();

  if (loading) {
    return (
      <div className="hub-view">
        <DegradedState mode="loading" />
      </div>
    );
  }

  if (error || !metrics) {
    return (
      <div className="hub-view">
        <DegradedState mode="error" onRetry={refetch} />
      </div>
    );
  }

  return (
    <div className="hub-view">
      <HubTickerStrip metrics={metrics} />
      <HubBento metrics={metrics} />
    </div>
  );
}
