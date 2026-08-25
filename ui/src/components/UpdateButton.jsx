import { useEffect, useRef, useState } from 'react';

// Ported from src/96.chrome-topbar.jsx (useSelfUpdate + UpdatePill).
// Endpoints: GET /api/update/check -> {current,latest,available,url,selfUpdate}
//            POST /api/update/apply -> starts the swap+restart
//            GET /api/update/status -> {phase,pct,error} poll target
const fetchT = (url, opts, ms) => {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms || 8000);
  return fetch(url, { ...(opts || {}), signal: ac.signal, cache: 'no-store' }).finally(() =>
    clearTimeout(t)
  );
};

export default function UpdateButton() {
  const [info, setInfo] = useState(null);
  const [phase, setPhase] = useState('idle'); // idle | applying | restarting | error
  const [error, setError] = useState('');
  const applying = useRef(false);

  const recheck = async () => {
    try {
      const r = await fetch('/api/update/check', { cache: 'no-store' });
      setInfo(await r.json());
    } catch {
      // older/file-mode server — stay silent
    }
  };

  useEffect(() => {
    recheck();
    const id = setInterval(recheck, 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, []);

  const runApply = async () => {
    if (applying.current) return;
    applying.current = true;
    setError('');
    setPhase('applying');
    const oldVer = (info && info.current) || '';
    let done = false;
    const fail = (m) => {
      if (done) return;
      done = true;
      applying.current = false;
      setPhase('error');
      setError(m || 'update failed');
    };
    const confirmThenReload = () => {
      if (done) return;
      setPhase('restarting');
      const deadline = Date.now() + 20000;
      const probe = async () => {
        if (done) return;
        try {
          const c = await fetchT('/api/update/check', null, 6000).then((x) => x.json());
          if (c && c.current && c.current !== oldVer) {
            done = true;
            applying.current = false;
            window.location.reload();
            return;
          }
        } catch {
          // mid-restart — keep probing
        }
        if (Date.now() > deadline) {
          fail('update applied but could not confirm — refresh to verify the version');
          return;
        }
        setTimeout(probe, 1500);
      };
      probe();
    };
    try {
      const r = await fetchT('/api/update/apply', { method: 'POST' }, 12000);
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        fail(j.error || 'HTTP ' + r.status);
        return;
      }
      let lastPhase = 'starting';
      let lastChange = Date.now();
      const tick = async () => {
        if (done) return;
        let s;
        try {
          s = await fetchT('/api/update/status', null, 8000).then((x) => x.json());
        } catch {
          confirmThenReload();
          return;
        }
        if (done) return;
        if (s.phase === 'error') {
          fail(s.error);
          return;
        }
        if (s.phase === 'done' || s.pct >= 100) {
          confirmThenReload();
          return;
        }
        if (s.running === false && (!s.phase || s.phase === 'idle')) {
          confirmThenReload();
          return;
        }
        if (s.phase !== lastPhase) {
          lastPhase = s.phase;
          lastChange = Date.now();
        } else if (Date.now() - lastChange > 180000) {
          fail('update stalled — refresh to check the version');
          return;
        }
        setTimeout(tick, 1200);
      };
      setTimeout(tick, 1200);
    } catch {
      confirmThenReload();
    }
  };

  const current = (info && info.current) || '';
  const isDev = current.startsWith('dev-') || (info && info.checkDisabled);

  // Idle version text lives in Settings now (topbar declutter v1) — the topbar
  // only shows this component when there's something actionable to say.
  if (isDev || !info) return null;

  if (phase === 'error') {
    return (
      <span className="flex items-center gap-2 text-note">
        <span className="text-muted">v{current.replace(/^v/, '')}</span>
        <span className="text-crit">{error}</span>
      </span>
    );
  }

  if (phase === 'applying' || phase === 'restarting') {
    return (
      <span className="text-note text-muted">
        {phase === 'restarting' ? 'Restarting…' : 'Updating…'}
      </span>
    );
  }

  // The check itself failed (rate-limited, GitHub hiccup, bad response) — say
  // so, muted, instead of silently rendering as "up to date". Not a phase
  // error (that's the apply-flow branch above) and not an alarming banner.
  if (info.error) {
    return (
      <span className="text-note text-muted" title={info.error}>
        v{current.replace(/^v/, '')} · update check failed
      </span>
    );
  }

  if (info.available) {
    const latest = String(info.latest || '').replace(/^v/, '');
    return (
      <button
        type="button"
        onClick={() => {
          if (info.selfUpdate) runApply();
          else if (info.url) window.open(info.url, '_blank', 'noopener,noreferrer');
        }}
        className="px-2 py-1 rounded-control bg-accent text-on-accent text-note"
      >
        Update v{latest}
      </button>
    );
  }

  return null // up to date — version shown in Settings
}

// ---------------------------------------------------------------------------
// UpdateCheck — the settings sheet's Updates section.
//
// WHY IT EXISTS. The pill above is the only thing in the app that ever asked
// GitHub anything, and it asks on mount and then every six hours. The server
// remembers its answer for thirty minutes on top of that. Observed live on
// 2026-08-07: v3.56.0 was published at 12:37, the answer had been remembered at
// 12:21, and the app said nothing was available until the operator restarted
// the service. There was no button anywhere that meant "look again".
//
// This is that button, and it is deliberately NOT a second apply flow. When
// there is something to install, the pill in the header is what installs it,
// and this section says so — two buttons that both claim to update the app is
// how one of them ends up being the stale one.
// ---------------------------------------------------------------------------

// The floor the server puts under forced checks (forcedCheckMinInterval in
// go/update.go). Mirrored here so the button goes quiet for exactly as long as
// a second press would be answered from memory — a press that cannot produce a
// new answer should not look like one that can.
const FORCED_MIN_MS = 5000;

// How long the answer's age can drift on screen while the sheet sits open.
const AGE_TICK_MS = 30000;

/**
 * "3 minutes ago", in the words someone would actually say. Returns '' for a
 * missing or unparseable stamp — an answer with no time on it is not given a
 * guessed one, because the whole failure this closes was a stale answer that
 * looked current.
 */
function agoText(iso, now) {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return '';
  const secs = Math.max(0, Math.round((now - t) / 1000));
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return mins === 1 ? '1 minute ago' : `${mins} minutes ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return hours === 1 ? '1 hour ago' : `${hours} hours ago`;
  const days = Math.round(hours / 24);
  return days === 1 ? '1 day ago' : `${days} days ago`;
}

export function UpdateCheck({ version }) {
  const [info, setInfo] = useState(null);
  const [state, setState] = useState('idle'); // idle | checking | resting
  // True when the request itself never landed — a different fact from
  // info.error, which is the server telling us ITS request never landed.
  const [unreachable, setUnreachable] = useState(false);
  const [fromMemory, setFromMemory] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const restTimer = useRef(null);

  // One unforced read when the sheet opens, so the section can say when GitHub
  // was last asked without spending a request to find out. Forcing here would
  // make merely opening Settings cost a request out of the shared 60/hour.
  useEffect(() => {
    let alive = true;
    fetch('/api/update/check', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d) => {
        if (alive) setInfo(d);
      })
      .catch(() => {
        if (alive) setUnreachable(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Keeps "Last checked 3 minutes ago" true for as long as the sheet is open.
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), AGE_TICK_MS);
    return () => clearInterval(id);
  }, []);

  useEffect(() => () => clearTimeout(restTimer.current), []);

  const check = async () => {
    if (state !== 'idle') return;
    setState('checking');
    setUnreachable(false);
    setFromMemory(false);
    try {
      const d = await fetchT('/api/update/check?force=1', null, 15000).then((r) => r.json());
      setInfo(d);
      // The server answered from memory anyway (a second press inside its own
      // five-second floor). Say so rather than presenting it as a fresh look.
      setFromMemory(!!d.cached);
      setNow(Date.now());
    } catch {
      setUnreachable(true);
    }
    setState('resting');
    restTimer.current = setTimeout(() => setState('idle'), FORCED_MIN_MS);
  };

  const disabled = info && info.checkDisabled;
  const running = String((info && info.current) || version || '').replace(/^v/, '');
  const latest = String((info && info.latest) || '').replace(/^v/, '');
  const checkedAgo = agoText(info && info.checkedAt, now);

  let said = '';
  let tone = 'text-dim';
  if (state === 'checking') {
    said = 'Checking…';
  } else if (unreachable) {
    said = 'Could not check just now — this app could not be reached. Try again in a moment.';
    tone = 'text-crit';
  } else if (!info) {
    said = '';
  } else if (info.checkDisabled) {
    said = 'Checking for new versions is switched off on this server, so nothing was looked up.';
  } else if (info.error) {
    said = 'Could not check just now — the update service could not be reached. Nothing on this machine has changed.';
    tone = 'text-crit';
  } else if (info.available) {
    said = `Version ${latest} is ready to install. Use the update button at the top of the screen — this is only a check.`;
    tone = 'text-txt';
  } else {
    said = "You're on the latest version.";
  }
  if (said && fromMemory && state !== 'checking') {
    said = `Just checked a moment ago, so this is the same answer. ${said}`;
  }

  return (
    <>
      <div className="text-note uppercase tracking-wide text-dim mb-2">Updates</div>
      <div className="mb-4">
        <div className="text-note text-dim">
          {running ? `Bloxsmith v${running}` : 'Bloxsmith — version unknown'}
          {checkedAgo ? ` · Last checked ${checkedAgo}` : ''}
        </div>
        {!disabled && (
          <button
            type="button"
            onClick={check}
            disabled={state !== 'idle'}
            className="w-full mt-2 px-2.5 py-1.5 rounded-control border border-border text-copy text-field-txt hover:border-border-hover disabled:opacity-50"
          >
            Check for updates
          </button>
        )}
        {/* In the tree from the first render, empty rather than absent: a live
            region added at the same moment as its text is not announced. Same
            pattern as DossierPage.jsx's. */}
        <p role="status" aria-live="polite" className={`m-0 mt-1.5 text-note leading-relaxed ${tone}`}>
          {said}
        </p>
        {/* What the header's Update pill is FOR used to be printed here as a
            second paragraph, word for word out of CONTROL_HELP. It was the
            same sentence the control-help dialog already shows, and a settings
            section is not where a feature explains itself — the sheet's
            "What these controls do →" link is. Removed 2026-08-09; the
            sentence still exists, once, in lib/controlHelp.js.
            What stays is the live region above: that is not an explanation of
            a feature, it is the result of the button beside it. */}
      </div>
    </>
  );
}
