import { useEffect } from 'react';
import { checkForUpdate, startUpdate, useUpdate } from '../lib/updateState.js';

// Ported from src/96.chrome-topbar.jsx (useSelfUpdate + UpdatePill).
// The answer and the install flow live in lib/updateState.js, shared with
// UpdateCheck.jsx — see the comment there for why they are not kept here.
export default function UpdateButton() {
  const { info, phase, error } = useUpdate();

  useEffect(() => {
    // older/file-mode server — stay silent
    const recheck = () => checkForUpdate().catch(() => {});
    recheck();
    const id = setInterval(recheck, 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const current = (info && info.current) || '';
  const isDev = current.startsWith('dev-') || (info && info.checkDisabled);

  // Idle version text lives in Settings now (topbar declutter v1) — the topbar
  // only shows this component when there's something actionable to say.
  if (isDev || !info) return null;

  // Everything this component draws in the bar is for 768px and up. Below that
  // there is no room beside the tenant chip, so each of these states reaches the
  // reader through Settings instead (App.jsx puts a dot on the button), where
  // UpdateCheck.jsx says the same thing in full: installing, restarting, the
  // install error, and a check that failed. The error is a whole sentence, so
  // even where it shows it is cut to one line; its full text is the title.
  if (phase === 'error') {
    return (
      <span className="hidden md:flex items-center gap-2 text-note">
        <span className="text-muted">v{current.replace(/^v/, '')}</span>
        <span className="text-crit truncate max-w-[150px]" title={error}>{error}</span>
      </span>
    );
  }

  if (phase === 'applying' || phase === 'restarting') {
    return (
      <span className="hidden md:inline text-note text-muted">
        {phase === 'restarting' ? 'Restarting…' : 'Updating…'}
      </span>
    );
  }

  // The check itself failed (rate-limited, GitHub hiccup, bad response) — say
  // so, muted, instead of silently rendering as "up to date". Not a phase
  // error (that's the apply-flow branch above) and not an alarming banner.
  if (info.error) {
    return (
      <span className="hidden md:inline text-note text-muted" title={info.error}>
        v{current.replace(/^v/, '')} · update check failed
      </span>
    );
  }

  if (info.available) {
    const latest = String(info.latest || '').replace(/^v/, '');
    return (
      <button
        type="button"
        onClick={startUpdate}
        title={phase === 'waiting' ? error : undefined}
        className="hidden md:inline-block px-2 py-1 rounded-control bg-accent text-on-accent text-note"
      >
        {phase === 'waiting' ? 'Update waiting. Try again' : `Update v${latest}`}
      </button>
    );
  }

  return null // up to date — version shown in Settings
}
