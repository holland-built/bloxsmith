import type { HubMetrics, Health } from '../types/hub';
import './HubTickerStrip.css';

function dotClass(status: Health): string {
  return status === 'crit' ? 'r' : status === 'warn' ? 'a' : 'g';
}

export function HubTickerStrip({ metrics }: { metrics: HubMetrics }) {
  const {
    critCount,
    oversubscribed,
    anomaliesPerHr,
    anomaliesPrevHr,
    anomalyMultiplier,
    newIncidents,
    warnBacklog,
    openOver48h,
    services,
  } = metrics;

  const red = services.filter((s) => s.status === 'crit').length;
  const amber = services.filter((s) => s.status === 'warn').length;
  const green = services.filter((s) => s.status === 'ok').length;
  const minOversub =
    oversubscribed.length > 0 ? Math.min(...oversubscribed.map((o) => o.util)) : 0;

  return (
    <div className="hub-tickers">
      <div className="tick fire">
        <div>
          <div className="lbl">On Fire Now</div>
          <div className="q">Crit incidents + oversub</div>
        </div>
        <div className="row">
          <div className="big">{critCount}</div>
          <div className="delta up">▲ {newIncidents} /20m</div>
        </div>
        <div className="sub">
          {oversubscribed.length} subnet{oversubscribed.length === 1 ? '' : 's'} oversubscribed
          {minOversub ? ` ≥${minOversub}%` : ''}
        </div>
      </div>

      <div className="tick trend">
        <div>
          <div className="lbl">New / Trending</div>
          <div className="q">Anomaly rate + new incidents</div>
        </div>
        <div className="row">
          <div className="big">{anomaliesPerHr}</div>
          <div className="delta up">▲ {anomalyMultiplier}× ev/hr</div>
        </div>
        <div className="sub">
          was {anomaliesPrevHr}/hr · {newIncidents} new incident{newIncidents === 1 ? '' : 's'} /20m
        </div>
      </div>

      <div className="tick follow">
        <div>
          <div className="lbl">Needs Follow-up</div>
          <div className="q">Warn backlog + stale</div>
        </div>
        <div className="row">
          <div className="big">{warnBacklog}</div>
          <div className="delta down">▼ open</div>
        </div>
        <div className="sub">{openOver48h} open &gt;48h</div>
      </div>

      <div className="tick health">
        <div>
          <div className="lbl">Overall Health</div>
          <div className="q">Per-service status</div>
        </div>
        <div className="healthdots">
          {services.map((s) => (
            <div className="hd" key={s.name}>
              <span className={`d ${dotClass(s.status)}`} />
              {s.name === 'Security' ? 'SEC' : s.name.toUpperCase()}
            </div>
          ))}
        </div>
        <div className="sub">
          {red} red · {amber} amber · {green} green
        </div>
      </div>
    </div>
  );
}
