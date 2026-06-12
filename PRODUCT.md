# Product

## Register

product

## Users

Network operations engineers and Infoblox sales engineers. Two contexts:

- **NOC operator**: monitoring an Infoblox Portal/CSP tenant across a shift, often on a wall display or a side monitor in a dim room. Scans for anomalies (lease spikes, threat events, unhealthy hosts), drills into one entity, moves on.
- **Demo presenter**: an SE walking a prospect through live tenant data on a projector. Needs the dashboard to look credible and read from across a room, with zero awkward waits.

Job to be done: answer "is anything wrong in this tenant, and where?" in under ten seconds, then drill down without leaving the page.

## Product Purpose

A local, single-page NOC dashboard for the Infoblox Portal/CSP.  A Python bridge speaks MCP to csp.infoblox.com, normalizes the data, and serves a React dashboard: subnets, DHCP leases, DNS zones, hosts, security policies, threat feeds, audit logs, plus an optional natural-language query box (LLM tool-calling) and in-dashboard CSP account switching. Success: an operator or presenter trusts the numbers at a glance and never has to open the CSP portal mid-session.

## Brand Personality

Operator-grade, calm, dense. The dashboard should feel like a well-run terminal room: dark, quiet, information-forward. Confidence comes from data density and consistency, not decoration.

## Anti-references

- Neon "cyber" SOC dashboards (glowing globes, matrix-green gradients, animated radar sweeps).
- SaaS marketing gloss: hero metrics with gradient accents, oversized empty whitespace, onboarding confetti.
- Grafana-default sprawl: dozens of unaligned panels with mismatched fonts and rainbow series colors.

## Design Principles

1. **Glanceable severity first.** Red/amber/green status must be readable from across a room; everything else is secondary.
2. **Density is a feature.** Operators want more rows, not bigger cards. Never trade data for whitespace.
3. **One vocabulary everywhere.** Same badge, same table, same drill-down pattern on every page; a new page should require zero learning.
4. **Never block the scan.** Loading, errors, and empty states keep the layout stable; async work never shifts or hides what's already on screen.
5. **Live data is the hero.** Color and motion only ever encode state (severity, freshness, loading); never decoration.

## Accessibility & Inclusion

- WCAG AA contrast on the dark theme (text vs. surface, badge text vs. badge tint).
- Severity never encoded by color alone (pair with label or icon shape).
- Keyboard: global search, account switcher, and drill-downs operable without a mouse; visible focus states.
- Respect `prefers-reduced-motion` (pulse, bounce, spinners get static alternatives).
