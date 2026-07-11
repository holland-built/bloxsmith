import './DegradedState.css';

interface DegradedStateProps {
  mode: 'loading' | 'error' | 'empty';
  onRetry?: () => void;
}

export function DegradedState({ mode, onRetry }: DegradedStateProps) {
  if (mode === 'loading') {
    return (
      <div className="degraded-state" data-mode={mode}>
        <div className="degraded-spinner" aria-hidden="true" />
        <p>Loading…</p>
      </div>
    );
  }

  return (
    <div className="degraded-state" data-mode={mode}>
      <p>No data — check connection</p>
      {mode === 'error' && onRetry && (
        <button type="button" className="degraded-retry" onClick={onRetry}>
          Retry
        </button>
      )}
    </div>
  );
}
