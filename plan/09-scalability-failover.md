# 09 — Scalability & Failover

> Phase 7 — the phase your whole project was aimed at. "Handling massive
> users and data" lives here, and it's mostly: sharding math, honest load
> tests, and orchestrated violence against your own system.

## 1. What "scale" means for each tier (different bottlenecks, different fixes)

| Tier | Bottleneck at scale | The fix you'll implement |
|---|---|---|
| Gateway | file descriptors, BEAM schedulers, fan-out CPU, egress | symmetric nodes + LB; per-guild actors already shard work; large-guild subscriber splitting |
| REST API | DB connection pools, CPU on JSON | stateless replicas ×N behind LB (trivial — that's *why* it's stateless); read replicas for GETs |
| Postgres | write IOPS, connection count | read replicas + PgBouncer (learn pool modes); partitioning *theory* (you won't need it — know why) |
| ScyllaDB | per-node throughput, hot partitions | vnodes/sharding is built-in; add nodes, watch rebalance; hot-partition detection via `nodetool tablehistograms` |
| NATS | stream retention disk | retention limits + per-subject TTLs; cluster of 3 |
| SFU | egress bandwidth (the real wall, 07 §4) | per-channel placement; multiple SFU instances; region assignment |
| Redis (if used) | memory, single-thread hot keys | it's a Phase-1 crutch — know which keys survive to Phase 7 (rate limits, resume buffers, idempotency) |

The meta-lesson: **you scale by making tiers independent, then scaling each
by its own dimension.** The bus + stateless-REST discipline from Phase 0 is
what makes this table possible. Draw it again with real numbers after your
load tests.

## 2. Load testing (measure before scaling anything)

Tools: `k6` (REST), a small Go WS-client army (10k conns), `artillery` as
alternative. Scenarios — run against your *single-node* baseline first:

1. **Idle connections**: ramp 0→50k WS conns over 10min. Watch: FDs, BEAM
   memory/conn, scheduler util. Find the knee. (Discord's numbers: ~1M
   conns/node-class eventually; you'll find your laptop's knee at far less —
   that's fine, record *where* and *what resource* bent.)
2. **Fan-out**: 100 msg/s into a 200-subscriber guild = 20k frames/s. Then
   100 msg/s × 10 such guilds. Then one message into a 10k-subscriber guild
   (worst case: single-actor hot spot — this is the Discord "big guild"
   problem; your subscriber-splitting from 01 §8 gets built only if this test
   hurts).
3. **Mixed**: 20k conns + chat traffic + presence churn + typing, sustained
   30min. Memory leaks live here. Grafana screenshots or it didn't happen.
4. **Read path**: pagination storms (a bot opening scrollback of 50 channels).

Output of this section: a **capacity table** ("1 gateway node = X conns at
Y msg/s fan-out at p99 Zms") — the number that turns "massive users" from
vibes into arithmetic. Keep it updated every phase.

## 3. Multi-node topology (Docker network = your "region")

```
            HAProxy (LB, consistent-hash on session_id optional)
        ┌────────┼────────┐
   gateway-1   gateway-2   gateway-3     (Elixir cluster: libcluster,
        │          │          │             Horde registry, shared NATS)
        └──────────┴────┬─────┘
                     NATS (3-node JetStream cluster)
        ┌──────────┬────┴────────┐
    api-1        api-2      scylla ×3 (QUORUM)
                        pgbouncer + PG (+1 read replica)
                        redis ×1 (crutch tier)
                        sfu-1, sfu-2 (channel-assigned)
```

Exercises:
- **Guild actor placement**: with Horde, a guild actor lives on exactly one
  node (global registry). Kill that node → actor restarts elsewhere → members
  RESUME. Verify zero lost events for buffered sessions. Then break it on
  purpose: pause (SIGSTOP, not kill — no DOWN message!) the node holding the
  actor → observe split-brain (another node claims the guild; old node still
  fans out). Now you've met the BEAM-distribution shot-in-the-head problem —
  heartbeat config + leases are the remedies; implement a lease (Redis
  SET NX PX per guild with renewal) and write up why Discord chose "resync
  instead of perfect failover" (01 §6) — compare your answer to theirs.
- **Event ordering across nodes**: messages from api-1 and api-2 interleave in
  the bus. Per-guild ordering: is it guaranteed? (Trick question: snowflakes
  order *within* a channel only because your UI sorts by id — the *event
  stream* can reorder. Does your client care? When does it break? — replay a
  RESUME with shuffled MESSAGE_CREATEs and see.)

## 4. The chaos catalog (each phase already ran one; here they get systematic)

Use `pumba` or `docker kill/pause` + `tc netem` scripted as
`scripts/chaos/*.sh` — chaos you can't re-run from one command didn't happen:

| # | Strike | Expected outcome | Learning target |
|---|---|---|---|
| 1 | SIGKILL a gateway node (20k conns live) | resumable clients back <5s on other nodes, buffered sessions lose zero events | session resume + LB health |
| 2 | SIGSTOP (partition-ish) a gateway node | heartbeat-based detection eventually evicts it; no split-brain fan-out | failure *detection* vs death |
| 3 | Network-partition Scylla node (`iptables DROP`) | writes at QUORUM continue ⅔; partitioned node catches up; explain tombstone/replay | quorum math |
| 4 | Kill NATS leader mid-burst | JetStream failover, consumers re-attach, zero event loss (at-least-once: possible dupes — verify your dedup works!) | broker failover + idempotent consumers |
| 5 | Kill SFU mid-call | media re-routes to peer SFU ≤2s (07 §4) | control/data plane split |
| 6 | PG failover (promote replica via patroni or manual) | REST errors for seconds, then heals; gateway *never* notices (it doesn't talk to PG!) | tier isolation |
| 7 | Netem 500ms latency + 2% loss between ALL nodes | system degrades gracefully; p99 balloons but nothing wedges; timeouts tuned < retry storms | timeouts, backpressure, hedging |
| 8 | Redis death | resume buffers + rate limits degrade *gracefully* (feature-flagged), system stays up | crutch-tier blast radius |
| 9 | Clock skew +2min on one node | snowflakes from that node sort wrongly; discuss NTP discipline + mixed-precision IDs | time is a distributed-systems lie |

Rule for every drill: **predict in writing first, run, then write what
actually happened.** The gap between prediction and reality is the entire
education of this phase. Keep these in `../postmortems/chaos-log.md`.

## 5. SLO thinking (the professional wrapper)

Define SLOs for your system (these ARE the "did it scale" definition):
- Event fan-out p99 (NATS→socket): < 50ms @ target load
- Message send→render p99: < 150ms
- Voice connect: < 1s; mouth-to-ear p95 < 150ms
- Resume success rate after node kill: > 99% within 5s
- Availability: consecutive-30min error-rate windows (sloppy but honest)

Then build one dashboard that answers them at a glance. Alerting (Alertmanager
or Grafana) on burn-rate of the two most important ones. The lesson: **an SLO
is how you decide an incident is over** — "everything green on the dashboard"
is not a criteria.

## 6. Capacity planning arithmetic (the final exercise)

With your Phase 7 capacity table, answer on paper — checked against one real
measurement each:
- "1M concurrent users, avg 10 guilds each, 5% in voice, 1 msg/user/min, avg
  guild size 50" → how many gateway nodes, API pods, Scylla nodes, SFU boxes,
  and what egress? Compare to Discord's public talks (they've cited ~a few
  hundred media servers, millions of concurrent voice users). Same order of
  methodology, smaller constants — you've now done the thing the interview
  question is checking for.

## 7. Phase 7 gate

- [ ] Capacity table exists with real measured knees (not vibes)
- [ ] Chaos drills 1–9 run, predicted-vs-actual written, fixes applied
- [ ] Guild-actor lease (or documented decision + Discord comparison) done
- [ ] 1M-user capacity plan on paper, sanity-checked against one measurement
- [ ] SLO dashboard live, two burn-rate alerts firing (on purpose, once each)

## 8. Reading
- Discord: "Handling Five Million Concurrent Users" (Elixir scaling) — re-read
  now, it's a different post after you've built it
- NATS JetStream docs: clustering + consumer semantics
- Scylla docs: consistency levels + "how does repair work"
- "The Tail at Scale" (Dean & Barroso) — why p99 is the number that matters
