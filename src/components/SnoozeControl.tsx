import { useState } from 'react';
import './SnoozeControl.css';

const DURATIONS: { minutes: number; label: string }[] = [
  { minutes: 15, label: '15m' },
  { minutes: 60, label: '1h' },
  { minutes: 240, label: '4h' },
];

export function SnoozeControl({
  category,
  onSnoozed,
}: {
  category: string;
  onSnoozed: () => void;
}) {
  const [minutes, setMinutes] = useState(DURATIONS[0].minutes);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState(false);

  async function handleSnooze() {
    setPending(true);
    setError(false);

    try {
      const res = await fetch('/api/alerts/snooze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, minutes }),
      });

      if (res.ok) {
        onSnoozed();
      } else {
        setError(true);
      }
    } catch {
      setError(true);
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="snooze-control">
      <select
        className="snooze-control-select"
        value={minutes}
        disabled={pending}
        aria-label="Snooze duration"
        onChange={(e) => setMinutes(Number(e.target.value))}
      >
        {DURATIONS.map((d) => (
          <option key={d.minutes} value={d.minutes}>
            {d.label}
          </option>
        ))}
      </select>
      <button
        type="button"
        className="snooze-control-button"
        disabled={pending}
        onClick={handleSnooze}
      >
        {pending ? 'Snoozing…' : 'Snooze'}
      </button>
      {error && <span className="snooze-control-error">Snooze failed</span>}
    </div>
  );
}
