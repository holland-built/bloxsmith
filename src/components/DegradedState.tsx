import './DegradedState.css';

export function DegradedState({ mode }: { mode: 'loading' | 'error' | 'empty' }) {
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
    </div>
  );
}
