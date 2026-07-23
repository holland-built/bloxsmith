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
      <span className="flex items-center gap-2 text-[11px]">
        <span className="text-muted">v{current.replace(/^v/, '')}</span>
        <span className="text-red-500">{error}</span>
      </span>
    );
  }

  if (phase === 'applying' || phase === 'restarting') {
    return (
      <span className="text-[11px] text-muted">
        {phase === 'restarting' ? 'Restarting…' : 'Updating…'}
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
        className="px-2 py-1 rounded-lg bg-accent text-white text-xs"
      >
        Update v{latest}
      </button>
    );
  }

  return null // up to date — version shown in Settings
}
