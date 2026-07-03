import { useHubDomains } from '../hooks/useHubDomains';
import { DegradedState } from './DegradedState';
import type { Sev } from '../types/domains';
import './HubDomains.css';

function sevClass(s: Sev): string {
  return s === 'crit' ? 'dsev-crit' : s === 'warn' ? 'dsev-warn' : 'dsev-ok';
}

function StatusChips({ counts }: { counts: Record<string, number> }) {
  const order = (k: string) =>
    /error|offline|unprotected/.test(k) ? 0 : /pending|await|degraded|disabled|unknown|inactive|stopped/.test(k) ? 1 : 2;
  const tone = (k: string) =>
    /error|offline|unprotected/.test(k) ? 'dsev-crit' : /pending|await|degraded|disabled|unknown|inactive|stopped/.test(k) ? 'dsev-warn' : 'dsev-ok';
  return (
    <div className="dchips">
      {Object.entries(counts)
        .sort((a, b) => order(a[0]) - order(b[0]))
        .map(([k, v]) => (
          <span key={k} className={`dchip ${tone(k)}`}>
            <b>{v}</b> {k}
          </span>
        ))}
    </div>
  );
}

export function HubDomains() {
  const { data, loading, error, refetch } = useHubDomains();

  if (loading) return <div className="hub-domains"><DegradedState mode="loading" /></div>;
  if (error || !data) return <div className="hub-domains"><DegradedState mode="error" onRetry={refetch} /></div>;

  const feedCrit = data.threat_feeds.filter((f) => f.severity === 'crit').length;
  const listItems = data.named_lists.reduce((n, l) => n + (l.items || 0), 0);
  const anycastUp = data.anycast_ha.filter((a) => a.severity === 'ok').length;

  return (
    <div className="hub-domains">
      <div className="domains-head">
        <h2>Platform Domains</h2>
        <span className="domains-sub">live from Infoblox REST · {data.threat_feeds.length + data.named_lists.length + data.security_policies.length + data.dfp_services.length + data.anycast_ha.length} objects</span>
        <button className="domains-refresh" onClick={refetch} aria-label="Refresh domains">↻</button>
      </div>

      <div className="domains-grid">
        {/* Threat feeds */}
        <section className="dpanel">
          <div className="dpanel-h"><span>Threat Feeds</span><span className="dcount">{data.threat_feeds.length}</span></div>
          <div className="dpanel-sub">{feedCrit} high-severity active</div>
          <ul className="drows">
            {data.threat_feeds.slice(0, 6).map((f, i) => (
              <li key={i}>
                <span className={`ddot ${sevClass(f.severity)}`} />
                <span className="dname">{f.name}</span>
                <span className="dmeta">{f.source}</span>
                <span className={`dtag ${sevClass(f.severity)}`}>{f.threat_level}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Named lists */}
        <section className="dpanel">
          <div className="dpanel-h"><span>Custom Lists</span><span className="dcount">{data.named_lists.length}</span></div>
          <div className="dpanel-sub">{listItems.toLocaleString()} items across lists</div>
          <ul className="drows">
            {data.named_lists.slice(0, 6).map((l, i) => (
              <li key={i}>
                <span className={`ddot ${sevClass(l.severity)}`} />
                <span className="dname">{l.name}</span>
                <span className="dmeta">{l.items} items</span>
                <span className="dtag">{l.policies}p</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Security policies */}
        <section className="dpanel">
          <div className="dpanel-h"><span>Security Policies</span><span className="dcount">{data.security_policies.length}</span></div>
          <div className="dpanel-sub">DNS threat-defense rulesets</div>
          <ul className="drows">
            {data.security_policies.slice(0, 6).map((p, i) => (
              <li key={i}>
                <span className={`ddot ${p.default_action.includes('block') ? 'dsev-crit' : 'dsev-ok'}`} />
                <span className="dname">{p.name}</span>
                <span className="dmeta">{p.rules} rules</span>
                <span className="dtag">{p.default_action.replace('action_', '')}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Host inventory */}
        <section className="dpanel">
          <div className="dpanel-h"><span>Host Inventory</span><span className="dcount">{data.host_inventory.total}</span></div>
          <StatusChips counts={data.host_inventory.by_status} />
          <ul className="drows">
            {data.host_inventory.hosts.slice(0, 6).map((h, i) => (
              <li key={i}>
                <span className={`ddot ${h.status === 'online' ? 'dsev-ok' : h.status === 'error' || h.status === 'offline' ? 'dsev-crit' : 'dsev-warn'}`} />
                <span className="dname">{h.name}</span>
                <span className="dmeta">{h.ip}</span>
                <span className="dtag">{h.qps ? `${h.qps} qps` : h.version}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Roaming endpoints */}
        <section className="dpanel">
          <div className="dpanel-h"><span>Roaming Endpoints</span><span className="dcount">{data.roaming_endpoints.total}</span></div>
          <StatusChips counts={data.roaming_endpoints.by_status} />
          <ul className="drows">
            {data.roaming_endpoints.top_countries.map(([c, n], i) => (
              <li key={i}>
                <span className="dname">{c}</span>
                <span className="dmeta" />
                <span className="dtag">{n}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* Anycast HA */}
        <section className="dpanel">
          <div className="dpanel-h"><span>Anycast HA</span><span className="dcount">{data.anycast_ha.length}</span></div>
          <div className="dpanel-sub">{anycastUp}/{data.anycast_ha.length} active</div>
          <ul className="drows">
            {data.anycast_ha.slice(0, 6).map((a, i) => (
              <li key={i}>
                <span className={`ddot ${sevClass(a.severity)}`} />
                <span className="dname">{a.name}</span>
                <span className="dmeta">{a.service} · {a.ip}</span>
                <span className={`dtag ${sevClass(a.severity)}`}>{a.state}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* DFP services */}
        <section className="dpanel">
          <div className="dpanel-h"><span>DNS Forwarding Proxy</span><span className="dcount">{data.dfp_services.length}</span></div>
          <div className="dpanel-sub">cloud DFP services deployed</div>
          <ul className="drows">
            {data.dfp_services.slice(0, 6).map((d, i) => (
              <li key={i}>
                <span className="ddot dsev-ok" />
                <span className="dname">{d.name}</span>
                <span className="dmeta">{d.host}</span>
                <span className="dtag">{d.mode}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </div>
  );
}
