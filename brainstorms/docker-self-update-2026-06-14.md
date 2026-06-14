# docker-self-update — 2026-06-14

## Decisions
- Docker interaction: Docker Python SDK (`pip install docker`) — streaming pull events, clean inspect/stop/run API

## Open flags
- none yet

## Q&A log
**Q:** Docker SDK vs subprocess CLI for pull progress and container recreate?
**A:** Docker SDK (recommendation accepted)

**Q:** Pre-pull trigger — automatic on `available=true` or only on user click?
**A:** Automatic — kick background pull thread as soon as check finds update available

**Q:** Self-discovery for container recreate — `HOSTNAME` env var (Docker container ID) or explicit `CONTAINER_NAME` env var?
**A:** `HOSTNAME` — Docker sets it to short container ID automatically, no run-image.sh change needed

**Q:** Pull progress API — new `GET /api/update/status` or extend existing `/api/update/check`?
**A:** New endpoint — keeps check clean (TTL-cached, version detection only); status returns live `{phase, pct, stalled, error}`

**Q:** Pull step progress display — numeric `%`, layer counter, or both?
**A:** Both — `67% · layer 4/6`

**Q:** Container recreate env vars — copy all from `docker inspect` or whitelist?
**A:** Copy all from inspect — simpler, nothing drops, no new exposure vs what inspect already shows

**Q:** Keep `NO_SELF_UPDATE` escape hatch in run-image.sh?
**A:** Yes — rename to `NO_DOCKER_SOCKET=1`; skips socket mount + disables self-update for security-conscious deployments

---
