import { useEffect, useState } from 'react';
import { loadOvernight, overnightResult, overnightSaveBody, saveOvernight } from '../lib/overnight.js';
import { MACHINE_TEXT } from '../lib/machineText.js';

// Overnight updates: off until an admin turns them on. The server decides
// whether this install can use them and checks every rule; this only shows
// its answer. Someone who is not an admin sees nothing here. fieldCls comes in
// as a prop because importing ui.jsx here splits it out of the main bundle.
export default function OvernightUpdates({ fieldCls }) {
  const [cfg, setCfg] = useState(null);
  const [time, setTime] = useState('03:00');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');

  useEffect(() => {
    let alive = true;
    loadOvernight()
      .then((c) => {
        if (!alive || !c) return;
        setCfg(c);
        if (c.time) setTime(c.time);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  if (!cfg) return null;

  const zone = cfg.zone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const result = overnightResult(cfg.last);

  const save = async (enabled) => {
    setBusy(true);
    setProblem('');
    try {
      const res = await saveOvernight(overnightSaveBody(enabled, time, zone, cfg.needsPassphrase));
      if (res.ok) setCfg(res);
      else setProblem(res.error || 'Could not save the setting.');
    } catch {
      setProblem('Could not save the setting. This app could not be reached.');
    }
    setBusy(false);
  };

  return (
    <div className="pt-4 border-t border-border">
      <h4 className="m-0 text-copy font-medium">Overnight updates</h4>
      {!cfg.available ? (
        <p className="m-0 mt-1.5 text-note leading-relaxed text-dim">{cfg.unavailableReason}</p>
      ) : (
        <>
          <p className="m-0 mt-1 text-note leading-relaxed text-dim">
            {cfg.enabled
              ? `On. Installs new versions at ${cfg.time} each night, unless work is running.`
              : 'Off. New versions install only when you press the button above.'}
          </p>
          <label htmlFor="overnight-time" className="block mt-3 mb-1 text-note text-dim">
            Time ({zone})
          </label>
          <input
            id="overnight-time"
            type="time"
            value={time}
            onChange={(e) => setTime(e.target.value)}
            disabled={busy}
            {...MACHINE_TEXT}
            className={`${fieldCls} w-full disabled:opacity-50`}
          />
          {cfg.needsPassphrase && (
            <p className="m-0 mt-2 text-note leading-relaxed text-warn">
              {cfg.passphraseWarning}
            </p>
          )}
          {cfg.enabled ? (
            <div className="flex gap-2 mt-2">
              <button
                type="button"
                onClick={() => save(true)}
                disabled={busy || !time || time === cfg.time}
                className="flex-1 px-2.5 py-1.5 rounded-control bg-accent text-on-accent text-copy font-medium disabled:opacity-50"
              >
                Save time
              </button>
              <button
                type="button"
                onClick={() => save(false)}
                disabled={busy}
                className="flex-1 px-2.5 py-1.5 rounded-control border border-border text-copy text-field-txt hover:border-border-hover disabled:opacity-50"
              >
                Turn off
              </button>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => save(true)}
              disabled={busy || !time}
              className="w-full mt-2 px-2.5 py-1.5 rounded-control bg-accent text-on-accent text-copy font-medium disabled:opacity-50"
            >
              Turn on overnight updates
            </button>
          )}
        </>
      )}
      <p aria-live="polite" className="m-0 mt-1.5 text-note leading-relaxed text-crit">
        {problem}
      </p>
      {result && (
        <p className={`m-0 mt-1.5 text-note leading-relaxed ${result.tone}`}>
          Last result: {result.text}
        </p>
      )}
    </div>
  );
}
