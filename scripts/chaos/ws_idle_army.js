#!/usr/bin/env node
/**
 * WS idle army, Step 3 (Issue #88).
 *
 * Batched idle-connection ramp against the gateway: N clients IDENTIFY,
 * heartbeat, hold. No chat. Per-rung: gateway BEAM gauges scraped from
 * /metrics, driver heap/FD/event-loop lag tracked, bend criteria checked.
 * A resume-probe client at each rung verifies RESUME still works under load.
 *
 * Design notes (from the Step 3 inspection):
 * - Batched connects (not serial): phase7_gateway.js awaits each client,
 *   far too slow at 10k+ scale. Batches of BATCH with Promise.all.
 * - Single TOKEN for all clients: IDENTIFY warm_member hits PG once per
 *   distinct user; reusing one user warms once and multiplies sessions.
 *   Correct for idle (no writes, no rate limits to trip).
 * - Driver bend voids the rung: batch failures, lag blowup, heap runaway
 *   stop the ladder AT the bend (record it) rather than past it.
 * - Gateway knee is whatever bends first: memory/conn, FDs, scheduler
 *   (via docker stats CPU%), heartbeat ACK loss, resume-probe failure.
 *
 * Env:
 *   WS_URLS       comma-separated gateway ws urls, round-robined
 *   TOKEN         JWT for IDENTIFY (member of GUILD_ID)
 *   GUILD_ID      guild under test
 *   RUNG_TARGETS  comma-separated client totals, e.g. "1000,2000,5000,10000,20000"
 *   BATCH         connects per batch (default 500)
 *   RATE          arrival rate (connects/sec); when set, overrides BATCH
 *                 pacing: token-bucket paced births instead of parallel
 *                 blasts. Separates birth-concurrency from holding count.
 *   HOLD_S        hold seconds per rung (default 20)
 *   METRICS_URLS  comma-separated gateway /metrics urls, aligned with WS_URLS
 *   TAG           run label
 *   OUT           results JSON path (default scripts/bench/results/ws_idle_<tag>.json)
 */
const WS_URLS = (process.env.WS_URLS || 'ws://127.0.0.1:4000/ws').split(',');
const TOKEN = process.env.TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '99900000000000000';
if (process.env.DRIVER_IDX) {
  console.error(`[driver ${process.env.DRIVER_IDX}] guild=${GUILD_ID} token_set=${TOKEN ? 'yes' : 'no'}`);
}
const RUNG_TARGETS = (process.env.RUNG_TARGETS || '1000,2000,5000,10000,20000').split(',').map((s) => parseInt(s, 10));
const BATCH = parseInt(process.env.BATCH || '500', 10);
const RATE = parseFloat(process.env.RATE || '0');
const HOLD_S = parseInt(process.env.HOLD_S || '20', 10);
const METRICS_URLS = (process.env.METRICS_URLS || 'http://127.0.0.1:4000/metrics').split(',');
const TAG = process.env.TAG || 'idle';
const OUT = process.env.OUT || `${__dirname}/results/ws_idle_${TAG}.json`;

const HB_MS = 8000;

function mintHeaders() {
  return {};
}

async function scrapeGwMetrics() {
  // Sum gauges across gateway nodes (each /metrics is per-node).
  const out = { connections: 0, sessions: 0, guild_actors: 0, procs: 0, mem_bytes: 0, nodes: 0 };
  for (const base of METRICS_URLS) {
    try {
      const res = await fetch(base);
      if (!res.ok) continue;
      const text = await res.text();
      const get = (name) => {
        const m = text.match(new RegExp(`^${name} (.+)$`, 'm'));
        return m ? parseFloat(m[1]) : 0;
      };
      out.connections += get('gateway_connections_active');
      out.sessions += get('gateway_sessions_active');
      out.guild_actors += get('gateway_guild_actors_active');
      out.procs += get('gateway_erlang_processes');
      out.mem_bytes += get('gateway_erlang_memory_bytes\\{kind="total"\\}');
      out.nodes += 1;
    } catch { /* node unreachable: skip */ }
  }
  return out;
}

function connectIdle(url, token, idx, hbTrack) {
  return new Promise((resolve, reject) => {
    const rec = { idx, url, session_id: null, hbAck: 0, hbSent: 0, closed: false, ready: false, lastSeq: null, bornAt: Date.now(), readyAt: null };
    const ws = new WebSocket(url);
    const hb = setInterval(() => {
      if (ws.readyState === 1) {
        ws.send(JSON.stringify({ op: 1, d: null }));
        rec.hbSent++;
      }
    }, HB_MS);
    const timer = setTimeout(() => reject(new Error(`client ${idx}: no READY in 15s`)), 15000);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: { token } }));
      } else if (msg.t === 'READY') {
        rec.session_id = msg.d.session_id;
        rec.ready = true;
        rec.readyAt = Date.now();
        clearTimeout(timer);
        resolve({ ws, rec, hb });
      } else if (msg.op === 11) {
        rec.hbAck++;
      } else if (msg.op === 0 && typeof msg.s === 'number') {
        rec.lastSeq = msg.s;
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`client ${idx} ws error`)); };
    ws.onclose = (ev) => {
      rec.closed = true;
      rec.closeCode = ev && ev.code !== undefined ? ev.code : -1;
      rec.closeReason = ev && ev.reason ? String(ev.reason).slice(0, 80) : '';
      rec.closedAt = Date.now();
      clearInterval(hb);
    };
    if (hbTrack) hbTrack.push(rec);
  });
}

async function eventLoopLagMs(samples = 20) {
  const lags = [];
  for (let i = 0; i < samples; i++) {
    const t0 = process.hrtime.bigint();
    await new Promise((r) => setImmediate(r));
    lags.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  lags.sort((a, b) => a - b);
  return lags[Math.floor(lags.length / 2)];
}

function driverFds() {
  try {
    return require('fs').readdirSync('/proc/self/fd').length;
  } catch { return -1; }
}

// Resume probe: open a second socket for a LIVE session and RESUME it.
// Server replays missed frames only (no RESUMED marker); success =
// resumed socket stays alive and heartbeats get ACKed afterwards.
// lastSeq null (no dispatches yet) probes with seq 0.
async function resumeProbe(url, token, sessionId, lastSeq) {
  return new Promise((resolve) => {
    const result = { ok: false, detail: 'timeout' };
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve(result); }, 12000);
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) { clearTimeout(timer); result.detail = 'dial'; resolve(result); return; }
    let resumed = false;
    let acked = false;
    const hb = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: null }));
    }, 2000);
    const done = (ok, detail) => {
      result.ok = ok;
      result.detail = detail;
      clearTimeout(timer); clearInterval(hb);
      try { ws.close(); } catch {}
      resolve(result);
    };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.op === 10) {
        ws.send(JSON.stringify({ op: 6, d: { token, session_id: sessionId, seq: lastSeq === null ? 0 : lastSeq } }));
      } else if (msg.op === 11) {
        acked = true;
        resumed = true;
        done(true, 'hb_ack_after_resume');
      } else if (msg.op === 0 && msg.s !== undefined) {
        resumed = true;
        // Replay/live frame on the resumed socket: keep waiting for the
        // heartbeat ACK as the liveness proof, but don't time out silently.
        clearTimeout(timer);
        setTimeout(() => done(acked, acked ? 'hb_ack_after_resume' : 'frames_no_hb_ack'), 6000);
      } else if (msg.op === 9) {
        done(false, 'invalid_session');
      }
    };
    ws.onclose = () => {
      if (!resumed) done(false, 'closed_before_resume');
      else done(acked, acked ? 'hb_ack_after_resume' : 'closed_after_resume_no_ack');
    };
    ws.onerror = () => { result.detail = 'ws_error'; };
  });
}

async function main() {
  if (!TOKEN) throw new Error('TOKEN env required (mint via HS256 over JWT_SECRET for a guild member)');
  const clients = [];
  const hbTrack = [];
  const rungs = [];
  let totalFailed = 0;

  for (const target of RUNG_TARGETS) {
    const need = target - clients.length;
    if (need <= 0) continue;
    console.error(`[${TAG}] rung ${target}: connecting ${need} ${RATE > 0 ? `paced @${RATE}/s` : `in batches of ${BATCH}`}...`);

    const memBefore = process.memoryUsage();
    const t0 = Date.now();
    let batchFail = 0;

    if (RATE > 0) {
      // Paced arrival: token-bucket births at RATE/sec. Separates
      // birth-concurrency from holding count (Phase 1 of the cliff hunt).
      let tokens = 0;
      let last = Date.now();
      let done = 0;
      const inflight = new Set();
      while (done < need) {
        const now = Date.now();
        tokens = Math.min(RATE, tokens + ((now - last) / 1000) * RATE);
        last = now;
        while (tokens >= 1 && done < need) {
          tokens -= 1;
          const idx = clients.length + done;
          done++;
          const url = WS_URLS[idx % WS_URLS.length];
          const p = connectIdle(url, TOKEN, idx, hbTrack).then(
            (c) => { clients.push(c); inflight.delete(p); },
            (e) => { batchFail++; totalFailed++; inflight.delete(p); console.error(`[${TAG}] connect fail: ${e.message}`); }
          );
          inflight.add(p);
          if (inflight.size >= Math.ceil(RATE) + 10) {
            await Promise.race(inflight);
          }
        }
        if (batchFail > 0) break;
        await new Promise((r) => setTimeout(r, 20));
        const lag = await eventLoopLagMs(5);
        if (lag > 50) {
          console.error(`[${TAG}] DRIVER BEND: event-loop lag ${lag.toFixed(1)}ms — stopping AT rung ${target}`);
          break;
        }
      }
      await Promise.allSettled(inflight);
    } else {
      for (let done = 0; done < need; done += BATCH) {
        const n = Math.min(BATCH, need - done);
        const attempts = [];
        for (let i = 0; i < n; i++) {
          const idx = clients.length + i;
          const url = WS_URLS[idx % WS_URLS.length];
          attempts.push(
            connectIdle(url, TOKEN, idx, hbTrack).then(
              (c) => clients.push(c),
              (e) => { batchFail++; totalFailed++; console.error(`[${TAG}] connect fail: ${e.message}`); }
            )
          );
        }
        await Promise.all(attempts);
        if (batchFail > 0) break;
        const lag = await eventLoopLagMs(10);
        if (lag > 50) {
          console.error(`[${TAG}] DRIVER BEND: event-loop lag ${lag.toFixed(1)}ms — stopping AT rung ${target}`);
          break;
        }
      }
    }
    const connectMs = Date.now() - t0;
    const memAfter = process.memoryUsage();
    const lagAfter = await eventLoopLagMs(10);

    console.error(`[${TAG}] rung ${target}: ${clients.length} held, holding ${HOLD_S}s...`);
    await new Promise((r) => setTimeout(r, HOLD_S * 1000));

    // Gateway gauges (summed across nodes).
    const gw = await scrapeGwMetrics();

    // Heartbeat health across a sample (first 200 held clients).
    const sample = hbTrack.slice(0, 200);
    const closedSample = sample.filter((r) => r.closed).length;
    const closeCodeHist = {};
    let closeFirstAt = null;
    let closeLastAt = null;
    const closeAges = [];
    for (const r of hbTrack) {
      if (r.closed && r.closedAt) {
        const k = String(r.closeCode !== undefined ? r.closeCode : 'unknown');
        closeCodeHist[k] = (closeCodeHist[k] || 0) + 1;
        if (closeFirstAt === null || r.closedAt < closeFirstAt) closeFirstAt = r.closedAt;
        if (closeLastAt === null || r.closedAt > closeLastAt) closeLastAt = r.closedAt;
        if (r.readyAt) closeAges.push(r.closedAt - r.readyAt);
      }
    }
    closeAges.sort((a, b) => a - b);
    const ageP = (q) => (closeAges.length ? Math.round(closeAges[Math.min(closeAges.length - 1, Math.floor(closeAges.length * q))]) : null);
    const ackRate = sample.length
      ? sample.reduce((a, r) => a + (r.hbSent ? r.hbAck / r.hbSent : 1), 0) / sample.length
      : 1;

    // Resume probe on a live client (last connected), with its real seq.
    let resume = { ok: null, detail: 'skipped' };
    const probeSrc = clients[clients.length - 1];
    if (probeSrc && probeSrc.rec.session_id) {
      resume = await resumeProbe(probeSrc.rec.url, TOKEN, probeSrc.rec.session_id, probeSrc.rec.lastSeq);
    }

    const rung = {
      target,
      held: clients.length,
      failed: totalFailed,
      batch_fail: batchFail,
      connect_ms: connectMs,
      driver_heap_mb: +(memAfter.heapUsed / 1048576).toFixed(1),
      driver_heap_delta_mb: +((memAfter.heapUsed - memBefore.heapUsed) / 1048576).toFixed(1),
      driver_rss_mb: +(memAfter.rss / 1048576).toFixed(1),
      driver_fds: driverFds(),
      evloop_lag_ms: +lagAfter.toFixed(2),
      gw_connections: gw.connections,
      gw_sessions: gw.sessions,
      gw_guild_actors: gw.guild_actors,
      gw_procs: gw.procs,
      gw_mem_mb: +(gw.mem_bytes / 1048576).toFixed(1),
      gw_mem_per_conn_kb: gw.connections ? +((gw.mem_bytes / gw.connections / 1024).toFixed(1)) : null,
      hb_closed_sample: closedSample,
      hb_close_codes: closeCodeHist,
      hb_close_window_ms: closeFirstAt !== null ? closeLastAt - closeFirstAt : null,
      hb_close_age_ms: { p50: ageP(0.5), p90: ageP(0.9), min: closeAges.length ? closeAges[0] : null, max: closeAges.length ? closeAges[closeAges.length - 1] : null },
      hb_ack_rate: +ackRate.toFixed(3),
      resume_probe: resume,
    };
    rungs.push(rung);
    console.log(JSON.stringify(rung));

    if (batchFail > 0 || lagAfter > 50 || memAfter.heapUsed > 2 * 1024 * 1024 * 1024) {
      console.error(`[${TAG}] DRIVER BEND at rung ${target} — ladder stops here (recorded, not past).`);
      break;
    }
    if (!resume.ok && resume.detail !== 'skipped') {
      console.error(`[${TAG}] GATEWAY BEND at rung ${target}: resume probe ${resume.detail} — ladder stops here.`);
      break;
    }
  }

  const summary = {
    tool: 'ws_idle_army',
    node: process.version,
    tag: TAG,
    ws_urls: WS_URLS,
    rung_targets: RUNG_TARGETS,
    rungs,
    final_held: clients.length,
    final_failed: totalFailed,
  };
  require('fs').mkdirSync(require('path').dirname(OUT), { recursive: true });
  require('fs').writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.error(`[${TAG}] wrote ${OUT} — closing ${clients.length} clients...`);
  for (const c of clients) { clearInterval(c.hb); try { c.ws.close(); } catch {} }
  process.exit(batchFailOrBend(rungs) ? 2 : 0);
}

function batchFailOrBend(rungs) {
  if (!rungs.length) return true;
  const last = rungs[rungs.length - 1];
  return last.batch_fail > 0 || last.evloop_lag_ms > 50 || (last.resume_probe && last.resume_probe.ok === false);
}

main().catch((e) => { console.error(`[${TAG}] FATAL: ${e.message}`); process.exit(1); });
