import type { HubMetrics, Health } from '../types/hub';
import './HubBento.css';

function sdClass(status: Health): string {
  return status === 'crit' ? 'red' : status === 'warn' ? 'amber' : 'green';
}

function pctClass(severity: 'crit' | 'warn' | 'ok'): string {
  return severity === 'crit' ? 'red' : severity === 'warn' ? 'amber' : 'green';
}

function sparkPoints(values: number[]): string {
  const n = values.length;
  if (n === 0) return '';
  const max = Math.max(1, ...values);
  const stepX = n > 1 ? 320 / (n - 1) : 0;
  return values
    .map((v, i) => {
      const x = Math.round(i * stepX);
      const y = +(30 - (v / max) * 28).toFixed(1);
      return `${x},${y}`;
    })
    .join(' ');
}

export function HubBento({ metrics }: { metrics: HubMetrics }) {
  const {
    critIncidents,
    oversubscribed,
    critCount,
    anomaliesPerHr,
    anomaliesPrevHr,
    anomalyMultiplier,
    newIncidents,
    warnBacklog,
    openOver48h,
    services,
    security,
    securityBlocked,
    securityLogged,
    securityReal,
    sparkline,
  } = metrics;

  const downServices = services.filter((s) => s.status === 'crit').length;
  const points = sparkPoints(sparkline);
  const lastPoint = points.split(' ').filter(Boolean).pop()?.split(',') ?? ['320', '2'];

  return (
    <div className="hub-bento">
      {/* Q1: what's on fire — dominant 2×2 */}
      <section className="tile fire">
        <div className="lbl2">
          On Fire <span className="n red">{critCount} CRITICAL</span>
        </div>
        <div className="cols">
          <div className="zone">
            <div className="ztitle">Critical incidents</div>
            {critIncidents.length > 0 ? (
              <table className="dense">
                <thead>
                  <tr>
                    <th>Sev</th>
                    <th>Event</th>
                    <th>Target</th>
                    <th className="num">Age</th>
                  </tr>
                </thead>
                <tbody>
                  {critIncidents.map((i, idx) => (
                    <tr key={idx}>
                      <td>
                        <span className="sev c">CRIT</span>
                      </td>
                      <td className="name">{i.title}</td>
                      <td className="mono">{i.target}</td>
                      <td className="num age">{i.age}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <span className="hub-empty">no critical incidents</span>
            )}
          </div>
          <div className="zone b">
            <div className="ztitle">Oversubscribed subnets</div>
            {oversubscribed.length > 0 ? (
              oversubscribed.map((s, idx) => (
                <div className="subnet" key={idx}>
                  <div className="r">
                    <span className="cidr">{s.cidr}</span>
                    <span className={`pct ${pctClass(s.severity)}`}>{s.util}%</span>
                  </div>
                  <div className="bar">
                    <i className={pctClass(s.severity)} style={{ width: `${s.util}%` }} />
                  </div>
                </div>
              ))
            ) : (
              <span className="hub-empty">no oversubscribed subnets</span>
            )}
          </div>
        </div>
      </section>

      {/* Q4: overall health — tall rollup */}
      <section className="tile health">
        <div className="lbl2">
          Service Health <span className="n red">{downServices} DOWN</span>
        </div>
        <div className="svc">
          {services.map((s, idx) => (
            <div className={`r ${idx % 2 === 1 ? 'alt' : ''}`} key={s.name}>
              <div className={`sd ${sdClass(s.status)}`} />
              <div className="name">{s.name}</div>
              <div className="meta">{s.meta}</div>
              <div className={`stat ${sdClass(s.status)}`}>{s.statusLabel}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Q2: what's new / trending */}
      <section className="tile trending">
        <div className="lbl2">
          Trending <span className="n red">{anomalyMultiplier}× / HR</span>
        </div>
        <div className="trend-hero">
          <div className="big">{anomaliesPerHr}</div>
          <div className="unit">
            anomalies
            <br />/ hr
          </div>
          <div className="mult">↑ from {anomaliesPrevHr}</div>
        </div>
        <svg
          className="spark"
          width="100%"
          height="34"
          viewBox="0 0 320 34"
          preserveAspectRatio="none"
        >
          <polyline fill="none" stroke="var(--red)" strokeWidth="2.2" points={points} />
          <circle cx={lastPoint[0]} cy={lastPoint[1]} r="3.2" fill="var(--red)" />
        </svg>
        <div className="trend-sub">
          <b>
            {newIncidents} new incident{newIncidents === 1 ? '' : 's'}
          </b>{' '}
          opened in last 20 min
        </div>
      </section>

      {/* Q3: needs follow-up */}
      <section className="tile followup">
        <div className="lbl2">Follow-up</div>
        <div className="fu">
          <div className="k amber">{warnBacklog}</div>
          <div className="t">
            <b>warn-severity</b> incidents in backlog
          </div>
        </div>
        <div className="fu">
          <div className="k ink">{openOver48h}</div>
          <div className="t">
            <b>open &gt; 48h</b> awaiting owner
          </div>
        </div>
      </section>

      {/* security action queue */}
      <section className="tile security">
        <div className="lbl2">
          {securityReal ? 'DNS Threat Events' : 'Security Actions'}
          {securityReal && <span className="sec-live">· live</span>}
        </div>
        <div className="sec-grid">
          <div className={`sec ${security.critical === 0 ? 'zero' : ''}`}>
            <div className="num">{security.critical}</div>
            <div className="cls">Critical</div>
          </div>
          <div className={`sec ${security.high > 0 ? 'high' : 'zero'}`}>
            <div className="num">{security.high}</div>
            <div className="cls">High</div>
          </div>
          <div className="sec">
            <div className="num">{security.medium}</div>
            <div className="cls">Medium</div>
          </div>
          <div className="sec">
            <div className="num">{security.low}</div>
            <div className="cls">Low</div>
          </div>
        </div>
        {securityReal && (
          <div className="sec-foot">
            <b>{securityBlocked}</b> blocked · <b>{securityLogged}</b> logged · last hr
          </div>
        )}
      </section>
    </div>
  );
}
