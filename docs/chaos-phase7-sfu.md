# Chaos Engineering Experiment Report: Phase 7 Drill 7 — SFU Instance Crash & Voice Failover Re-Routing

- **Experiment ID:** `CHAOS-PHASE-7-DRILL-7-SFU-CRASH-FAILOVER`
- **Issue Reference:** Closes part of [#97](https://github.com/moadabdou/Kith/issues/97) (and [#87](https://github.com/moadabdou/Kith/issues/87))
- **Target Tier:** SFU Media Routing Pool & Gateway Channel Actor Placement (`sfu:5000`, `sfu-2:5001`, Go Pion SFU, Elixir Gateway)
- **Execution Date:** September 28, 2026
- **Tooling:** [`scripts/chaos/phase7_sfu.sh`](../scripts/chaos/phase7_sfu.sh), [`sfu/cmd/voice_bench/pool_drills.go`](../sfu/cmd/voice_bench/pool_drills.go)
- **Results Artifact:** [`scripts/chaos/results/phase7_sfu_drill7.json`](../scripts/chaos/results/phase7_sfu_drill7.json)

---

## 1. Executive Summary

Phase 7 Chaos Drill 7 evaluated the fault domain isolation, automated channel failover, and WebRTC media recovery guarantees of Kith's multi-instance SFU pool under active mid-call video streaming:
1. **Pre-Kill Co-Location & Active Media**: A voice video room with 1 publisher (transmitting a 3-layer VP8 simulcast stream) and 2 subscribers was established. Gateway channel hashing deterministically co-located all 3 sessions on `sfu:5000`. Active media delivery was verified (59 RTP packets verified per subscriber).
2. **Abrupt Instance Kill Without Process Restart**: Mid-stream, container `kith-sfu-1` was killed via `SIGKILL`. The victim container was deliberately **held down** (no restart) throughout the recovery window to strictly validate pool-level failover rather than single-process crash loops.
3. **Sub-10ms Socket Loss Detection**: Client WebRTC signaling WebSockets detected the sudden socket termination in **0.01 seconds** post-kill.
4. **Instant Fast-Lane Peer Re-Routing**: Gateway received client Op 4 re-requests; the confirm-probe fast lane detected failure on the corpse and immediately reassigned all 3 sessions (`pub`, `sub0`, `sub1`) to the surviving peer instance `sfu-2:5001` in **0.01 seconds** (0% split-brain, 100% co-location on survivor).
5. **Sub-Second Media RTO**: Rejoin and WebRTC renegotiation on the survivor SFU completed in **0.18 seconds**. The elapsed duration from initial `SIGKILL` to the **first post-kill video keyframe** on the peer SFU across all subscribers was **0.21 seconds** (substantially outperforming the strict $\le 2.0\text{s}$ acceptance gate).
6. **Steady-State Control Resilience**: Post-failover stability was proven through 2 rounds of Op 4 re-requests per member on the healthy pool: all sessions remained anchored on `sfu-2:5001`, and 0 actionable null pushes were emitted across a 3-second quiet window.
7. **Gateway Metrics Delta**: Gateway health tracking recorded the node failure (`gateway_sfu_flips_total{direction="down"}` +1) and registered all 3 voice sessions successfully failed over (`gateway_sfu_failovers_total` +3).

---

## 2. Invariants Under Test

| Invariant | Target Specification | Measured Result | Status |
| :--- | :--- | :---: | :---: |
| **1. Pre-Kill Session Co-Location** | 100% of room members placed on the same initial SFU | **3/3 on `sfu:5000`** | **PASS** |
| **2. Client Socket Drop Detection** | Client observes socket drop in $< 1.0\text{s}$ post-kill | **0.01s** | **PASS** |
| **3. Victim Process Held Down** | Victim container does NOT restart during failover | **No restart (`kith-sfu-1` held down)** | **PASS** |
| **4. Post-Kill Co-Location** | 100% of room members converge on surviving peer SFU | **3/3 on `sfu-2:5001` (0 dead)** | **PASS** |
| **5. Media Recovery (RTO)** | `SIGKILL` $\to$ first post-kill video keyframe $\le 2.0\text{s}$ | **0.21s** (worst sub) | **PASS** |
| **6. Peer SFU Rejoin Duration** | WebRTC signaling & peer connection rebuild $\le 1.0\text{s}$ | **0.18s** | **PASS** |
| **7. Steady-State Control** | Zero actionable nulls & 100% session stability | **0 actionable nulls / stable** | **PASS** |
| **8. Gateway Telemetry Alignment** | Metrics record transitions and failover count | **Flips: +1 down, Failovers: +3** | **PASS** |

---

## 3. Sequence of Events & Latency Breakdown

```
Timestamp (UTC)    Event                                              Elapsed (from Kill)
-----------------------------------------------------------------------------------------
05:08:31.950       Video call established (1 pub, 2 subs on sfu:5000) ---
05:08:34.050       Pre-kill check: 59 packets/sub verified            ---
05:08:34.073       💥 docker kill -s SIGKILL kith-sfu-1               T = 0.000s
05:08:34.083       Client signaling socket dropped                    +0.010s
05:08:34.083       Op 4 confirm-probe fast-lane assigns sfu-2:5001    +0.010s
05:08:34.263       WebRTC connection & ICE renegotiation complete     +0.190s
05:08:34.283       Sub0 receives first post-kill VP8 keyframe         +0.210s
05:08:34.283       Sub1 receives first post-kill VP8 keyframe         +0.210s
05:08:37.283       Steady-state control verified (zero nulls)         +3.210s
```

---

## 4. Architectural Analysis: Fast-Lane Confirm vs. Directed Teardown

Kith implements a dual-path voice failover architecture:

```
                        Gateway Guild Actor (Horde, lease-gated)
                        │  placement = :erlang.phash2(channel_id) over live SFUs
                        │  VOICE_SERVER_UPDATE (endpoint | null)
                        ▼
   Client ──Op 4──▶ Gateway ──push──▶ Client ──join──▶ sfu-1 / sfu-2
     │ media failure        │ background health poller (5s interval)
     │ re-send Op 4         │ flips live list; fast-lane confirms candidate
     └──────────────────────┘
```

1. **Demand-Path Confirm-Probe (Fast Lane)**:
   - When a client experiences a media/socket disconnect, it immediately issues Op 4 (`VOICE_STATE_UPDATE`) for its current voice channel.
   - The Gateway checks the candidate SFU via an instantaneous confirm probe. If the corpse fails to answer (TCP RST / connection refused), the Gateway excludes the dead candidate on the spot, re-hashes onto the live pool, and responds with the new endpoint (`sfu-2:5001`).
   - In this drill, all 3 members took the fast lane in **0.01s**, avoiding any wait for background poller cycles.
2. **Directed Teardown (`endpoint: null`)**:
   - The background health poller audits `GET /healthz` across all pool instances every 5 seconds.
   - Upon detecting a dead instance, it pushes `VOICE_SERVER_UPDATE` with `endpoint: null` to any sessions whose channel was placed on the dead node, parking them safely while reallocation proceeds.
   - The client driver includes a stale-null guard: any late-arriving null specifying an endpoint that the client already departed via the fast lane is safely ignored.

---

## 5. Gate Conclusion

Phase 7 Chaos Drill 7 satisfies all requirements of **Issue #97** and **`plan/09-scalability-failover.md` §4**:
- SFU instance crash mid-call with no restart survived seamlessly.
- First post-kill keyframe achieved in **0.21s** ($\le 2.0\text{s}$ gate satisfied by a factor of 9.5x).
- Pre-kill and post-kill co-location maintained at 100% across all members (zero split-brain).
- Steady-state control passed with zero spurious nulls.
- **Drill 7 Gate Verdict: PASS**.
