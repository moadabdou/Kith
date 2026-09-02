# 10 — Deployment (Local → Oracle Cloud)

> Deployment isn't a phase; it's a ratchet that tightens every phase. Start
> with one Compose file in Phase 0 and never let "it only runs on my machine"
> survive a week.

## 1. Environments (three, from day one)

| Env | Where | Purpose |
|---|---|---|
| `dev` | laptop, `docker compose up` | hot loop, one of everything |
| `staging` | laptop, `compose -f compose.multinode.yml` | the chaos/multi-node topology from 09 §3 |
| `prod` | Oracle Cloud VMs | real network, real latency, public TLS, friends can join |

Config via env vars only (12-factor): one `.env.example` per service, real
secrets never committed (age/sops or at minimum `.gitignore` discipline).

## 2. Compose evolution (the ratchet)

```yaml
# Phase 0 — compose.yml
postgres, api (go), gateway (elixir), client (vite dev), caddy (reverse proxy)

# Phase 1 — + redis (bus v0), + nats (bus v1: swap when you do the NATS
#            exercise — keep the redis profile around for comparison)
# Phase 3 — + scylla (1 node → profile: 3 nodes), + meilisearch, + indexer
# Phase 5 — + coturn, + sfu, UDP port range 40000-40100 exposed
# Phase 7 — compose.multinode.yml: the full 09 §3 topology (several gateway
#            containers, nats cluster, haproxy) — still on one laptop, but
#            the *topology* is real. (Alternative: k3s. See §5.)
# Phase 8 — + minio, + media-worker, cdn (caddy cache profile)
```

Observability ships in Phase 0 and never leaves:
`prometheus`, `grafana` (provisioned dashboards via `provisioning/` —
committed, so dashboards are code), `loki` for logs (Phase 1+). This stack
costs ~1GB RAM and saves you from flying blind in every later phase.

## 3. Oracle Cloud topology (Phase 9 / ongoing)

Oracle free tier realistically gets you ~4 ARM A1 VMs (4 OCPU/24GB split,
e.g. 1×24GB or 2×12GB) + AMD micros. Plan for what you can get:

```
VM-1 (12GB ARM): gateway, api ×2, caddy (edge: TLS + LB), grafana stack
VM-2 (12GB ARM): scylla ×? no — scylla needs ≥3 separate failure domains;
                 either 3 small scylla nodes across VMs 2/3/4 (capped memory)
                 or single-node scylla + honest doc that QUORUM is pretend here
VM-3: sfu + coturn (public UDP!), nats ×1, minio
VM-4: staging-chaos box (pumba/k6 driver) + backup target
```

Networking — the parts that WILL bite you (learn them by hitting them):
- Security lists: only 80/443 + SSH public; WS rides 443 via Caddy
- **UDP range for SFU/TURN** (40000-40100) must be open in the security list
  *and* in the host firewall (`iptables`/`firewalld` on Oracle images — the
  double-firewall gotcha; document the afternoon it costs you)
- WebRTC on cloud: NAT-type of Oracle VMs is fine (1:1 NAT, STUN works),
  but *clients* behind symmetric NAT exercise your TURN — coturn on the same
  VM, `external-ip` set correctly
- Egress: oracle bills egress after 10TB — your CDN exercise (08 §3) now has
  a real cost dimension. Nice.

TLS from day one on prod: Caddy does ACME automatically (need a domain —
any cheap one, or a free `duckdns`/Cloudflare-managed zone for the first year).

## 4. Ops practices (the curriculum hidden in "deployment")

- **Deploys**: `make deploy-<svc>` = build image → push to registry (ghcr) →
  `ssh vm 'docker compose pull && up -d --no-deps <svc>'`. Blue/green-lite for
  the gateway: scale to 2, wait healthy, kill old. This IS your Phase 7
  failover test, run weekly without ceremony.
- **DB migrations**: manual apply step in deploy script, backwards-compatible
  migrations only (expand/contract pattern — learn it before your first
  "oops" migration).
- **Backups**: nightly `pg_dump` + Scylla snapshot cron → other VM, restore
  drill once (untested backup = no backup).
- **Secrets**: `.env` on VMs via `scp`, or `sops` if you want the good habit.
- **Logs**: Loki, but also learn `docker logs`-hunting at least once when
  Loki itself is down (meta-lesson: your observability stack needs an
  observability plan).
- Runbook: `docs/runbook.md` — one page per failure mode from the chaos
  catalog (09 §4): symptom → check → fix. Written *during* the drills, not after.

## 5. Kubernetes: consciously skipped (with an escape hatch)

Everything above is Docker Compose on VMs. That's deliberate: K8s would teach
you *Kubernetes*, while hiding BEAM clustering, UDP networking, quorum, and
node failure behind abstractions that *simulate* what you're trying to *feel*.

Escape hatch: if you want the K8s competence later (legit career skill),
Phase 9+: k3s on the same VMs, port compose→helm by hand, and specifically
learn `PodDisruptionBudget`, `topologySpreadConstraints`, and why StatefulSet
+ Scylla is a story of its own. But finish the compose version first —
you'll *understand* what those objects are FOR instead of cargo-culting them.

## 6. Gate (continuous)

- [ ] Every phase's compose file runs from clean clone in one command
- [ ] Dashboards provisioned as code (not clicked into existence)
- [ ] prod has: TLS, backups + one verified restore, runbook, zero committed secrets
- [ ] A friend (or your phone on LTE) has joined a guild and a voice channel
      over the public internet — the moment the project becomes real
