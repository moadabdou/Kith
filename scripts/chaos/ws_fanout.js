#!/usr/bin/env node
/**
 * WS fan-out driver, Step 4 T1 (Issue #88).
 *
 * 200 subscribers hold one guild channel; a paced poster writes
 * 100 msg/s with rotating writer identities (5/5s per (user,channel)
 * rate limit => >=100 distinct writers). Each message carries a unique
 * bench id; subscribers record arrival latency (client Date.now() minus
 * server timestamp in payload) plus missed/dup accounting.
 *
 * Metrics per run: client-observed p50/p99, missed count, dup count,
 * gateway fanout histogram + actor queue depth scraped before/after.
 *
 * Env:
 *   WS_URLS       gateway ws urls, round-robined (subscribers)
 *   SUB_TOKEN     JWT for subscribers (member of GUILD_ID)
 *   GUILD_ID      guild under test
 *   CHANNEL_ID    channel posted into + subscribed
 *   API_BASE      REST base for posts (default http://127.0.0.1:8080)
 *   SUBS          subscriber count (default 200)
 *   RATE          posts/sec (default 100)
 *   DURATION_S    sustain seconds (default 60)
 *   WRITERS       distinct poster user-id base count (default 120)
 *   WRITER_BASE   first poster user id (default 99900110000000001)
 *   JWT_SECRET    HS256 secret for minting writer tokens
 *   TAG           run label
 *   OUT           results JSON path
 *
 * Split modes (poster runs alone in ws_poster.js; this process only
 * subscribes + aggregates). Coordination via files:
 *   SUBS_ONLY=1   connect subs, write READY_FILE, wait for MANIFEST,
 *                 settle SETTLE_S, aggregate vs manifest, exit.
 *   READY_FILE    path this process writes when subs READY.
 *   MANIFEST      path the poster writes when done posting.
 *   SETTLE_S      quiet seconds after manifest before aggregating (default 5).
 * Unset SUBS_ONLY: legacy combined mode (subs + inline poster).
 */
const WS_URLS = (process.env.WS_URLS || 'ws://127.0.0.1:4000/ws').split(',');
const SUB_TOKEN = process.env.SUB_TOKEN || process.env.TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '99900000000000000';
const CHANNEL_ID = process.env.CHANNEL_ID || '99900000000000101';
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const SUBS = parseInt(process.env.SUBS || '200', 10);
const RATE = parseFloat(process.env.RATE || '100');
const DURATION_S = parseInt(process.env.DURATION_S || '60', 10);
const WRITERS = parseInt(process.env.WRITERS || '120', 10);
const WRITER_BASE = BigInt(process.env.WRITER_BASE || '99900110000000001');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const TAG = process.env.TAG || 'fanout';
// Subscriber sharding: SUB_SHARD="i/n" makes this process own 1/n of SUBS
// (shard i, 0-based). Two processes with SUB_SHARD=0/2,1/2 each hold half.
// Manifest/ready coordination unchanged (shard 0 owns the files).
const SUB_SHARD = process.env.SUB_SHARD || '';
const OUT = process.env.OUT || `${__dirname}/results/ws_fanout_${TAG}.json`;
const METRICS_URLS = (process.env.METRICS_URLS || 'http://127.0.0.1:4000/metrics,http://127.0.0.1:4001/metrics').split(',');
const SUBS_ONLY = process.env.SUBS_ONLY === '1';
const READY_FILE = process.env.READY_FILE || `/tmp/fanout_${TAG}.ready`;
const MANIFEST = process.env.MANIFEST || `${__dirname}/results/ws_fanout_${TAG}.posted.json`;
const SETTLE_S = parseInt(process.env.SETTLE_S || '5', 10);

const HB_MS = 8000;
const crypto = require('crypto');

// Clock 3/3: observer health. A 500ms interval measures event-loop drift;
// if the subscriber process saturates parsing inbound frames, drift grows
// and client-observed latencies are observer-inflated (void run).
const evloopSamples = [];
let evloopTimer = null;
function startEvloopTrack() {
  let last = Date.now();
  evloopTimer = setInterval(() => {
    const now = Date.now();
    evloopSamples.push(Math.max(0, now - last - 500));
    last = now;
  }, 500);
  if (evloopTimer.unref) evloopTimer.unref();
}
function stopEvloopTrack() {
  if (evloopTimer) clearInterval(evloopTimer);
  evloopTimer = null;
  const s = [...evloopSamples].sort((a, b) => a - b);
  const q = (x) => (s.length ? s[Math.min(s.length - 1, Math.floor(s.length * x))] : null);
  return { n: s.length, p50: q(0.5), p99: q(0.99), max: s.length ? s[s.length - 1] : null };
}

function mintToken(sub) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: String(sub), iat: now, exp: now + 604800 });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function connectSub(url, token, idx) {
  return new Promise((resolve, reject) => {
    // Collect-cheap/verify-late: data frames are recorded as compact
    // tuples with NO JSON.parse (the old per-frame parse+regex saturated
    // one thread at ~20k frames/s). Dedup + latency math runs once, after
    // sockets close, when nothing is time-critical. Control frames
    // (HELLO/READY/acks) are rare and still parsed.
    const rec = { idx, url, session_id: null, tuples: [], closed: false };
    const ws = new WebSocket(url);
    const hb = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: null }));
    }, HB_MS);
    const timer = setTimeout(() => reject(new Error(`sub ${idx}: no READY in 15s`)), 15000);
    ws.onmessage = (ev) => {
      const raw = typeof ev.data === 'string' ? ev.data : String(ev.data);
      if (raw.includes('MESSAGE_CREATE')) {
        // Bench markers ride in content as "bench <bid> <sentMs>" (plain
        // ASCII, never JSON-escaped): raw-string match, no parse.
        const m = raw.match(/bench (\S+) (\d+)/);
        if (!m) return; // non-bench traffic
        rec.tuples.push([m[1], parseInt(m[2], 10), Date.now()]);
        return;
      }
      let msg;
      try { msg = JSON.parse(raw); } catch { return; }
      if (msg.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: { token } }));
      } else if (msg.t === 'READY') {
        rec.session_id = msg.d.session_id;
        clearTimeout(timer);
        resolve({ ws, rec, hb });
      } else if (msg.op === 11) {
        // heartbeat ack, ignore
      }
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(`sub ${idx} ws error`)); };
    ws.onclose = () => { rec.closed = true; clearInterval(hb); };
  });
}

async function postMessage(apiBase, token, content) {
  const res = await fetch(`${apiBase}/api/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(content),
  });
  const code = res.status;
  let body = null;
  try { body = await res.json(); } catch {}
  return { code, body };
}

async function scrapeFanout() {
  // Sum fanout histogram count + scrape rendered p50/p99 if exposed;
  // fall back to raw count. Returns per-node lines for the report.
  // Buckets + actor count ride along so the gate can read the
  // holder node's dispatch p99 (same-VM clock; mirror-node samples
  // carry an arbitrary BEAM timebase offset).
  const out = [];
  for (const base of METRICS_URLS) {
    try {
      const res = await fetch(base);
      if (!res.ok) { out.push({ base, error: res.status }); continue; }
      const text = await res.text();
      const get = (name) => {
        const m = text.match(new RegExp(`^${name} (.+)$`, 'm'));
        return m ? m[1] : null;
      };
      const buckets = {};
      for (const m of text.matchAll(/^gateway_fanout_latency_seconds_bucket\{le="([^"]+)"\} (\d+(?:\.\d+)?)$/gm)) {
        buckets[m[1]] = parseFloat(m[2]);
      }
      out.push({
        base,
        fanout_count: get('gateway_fanout_latency_seconds_count'),
        fanout_sum: get('gateway_fanout_latency_seconds_sum'),
        guild_actors: get('gateway_guild_actors_active'),
        buckets,
      });
    } catch (e) { out.push({ base, error: String(e).slice(0, 80) }); }
  }
  return out;
}

// Latency gate quantity: dispatch p99 from the actor-holding node's
// bucket deltas (before -> after). First le holding >=99% of the delta
// count; coarse at bucket granularity, exact enough for a 50ms gate
// (bucket edge sits at 0.05).
function serverFanoutP99(before, after) {
  if (!after || !after.length) return { p99_s: null, per_node: [], holder_only: false, note: 'no after-scrape' };
  const perNode = [];
  for (let i = 0; i < after.length; i++) {
    const a = after[i] || {};
    const b = (before && before[i]) || {};
    if (!a.buckets) { perNode.push({ base: a.base, error: a.error || 'no buckets' }); continue; }
    const am = {}, bm = {};
    for (const [k, v] of Object.entries(a.buckets)) am[parseFloat(k)] = v;
    for (const [k, v] of Object.entries(b.buckets || {})) bm[parseFloat(k)] = v;
    const total = (parseFloat(a.fanout_count) || 0) - (parseFloat(b.fanout_count) || 0);
    let cum = 0, p99 = null;
    const les = Object.keys(am).map(parseFloat).filter((x) => Number.isFinite(x)).sort((x, y) => x - y);
    for (const le of les) {
      cum += (am[le] || 0) - (bm[le] || 0);
      if (p99 === null && total > 0 && cum >= 0.99 * total) p99 = le;
    }
    perNode.push({ base: a.base, actors: a.guild_actors, delta_count: total, p99_s: p99 });
  }
  const holders = perNode.filter((n) => parseFloat(n.actors) > 0 && n.p99_s !== null);
  const usable = holders.length ? holders : perNode.filter((n) => n.p99_s !== null);
  const p99 = usable.length ? Math.max(...usable.map((n) => n.p99_s)) : null;
  return { p99_s: p99, per_node: perNode, holder_only: holders.length === 1 };
}

function pct(sorted, q) {
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))];
}

async function main() {
  if (!SUB_TOKEN) throw new Error('SUB_TOKEN (or TOKEN) env required');
  startEvloopTrack();
  const totalPosts = Math.floor(RATE * DURATION_S);
  console.error(`[${TAG}] T1: ${SUBS} subs, ${RATE}/s x ${DURATION_S}s = ${totalPosts} posts into ${CHANNEL_ID}`);

  // 1. Connect subscribers in batches (this shard's share only).
  let shardIdx = 0, shardN = 1;
  if (SUB_SHARD) {
    const parts = SUB_SHARD.split('/');
    shardIdx = parseInt(parts[0], 10) || 0;
    shardN = parseInt(parts[1], 10) || 1;
  }
  const myIdx = [];
  for (let i = 0; i < SUBS; i++) if (i % shardN === shardIdx) myIdx.push(i);
  const subs = [];
  // BATCH caps concurrent IDENTIFYs: births past a few hundred concurrent
  // collapse per-node (T3 wedged gw1 twice). Default 100 suits ≤1k armies;
  // 10k births pace at BATCH=20.
  const BATCH = parseInt(process.env.BIRTH_BATCH || '100', 10);
  let birthSlot = 0;
  for (let done = 0; done < myIdx.length; done += BATCH) {
    const slice = myIdx.slice(done, done + BATCH);
    // Round-robin by per-process slot order (not global idx): a strided
    // shard would otherwise single-home on one gateway and herd its
    // births onto one node. Slots increment per batch (map runs sync).
    const slotBase = birthSlot;
    birthSlot += slice.length;
    const attempts = slice.map((idx, k) =>
      connectSub(WS_URLS[(slotBase + k) % WS_URLS.length], SUB_TOKEN, idx).then(
        (c) => subs.push(c),
        (e) => console.error(`[${TAG}] sub fail: ${e.message}`)
      )
    );
    await Promise.all(attempts);
    console.error(`[${TAG}] ${subs.length}/${myIdx.length} subs READY (shard ${shardIdx}/${shardN})`);
  }
  if (subs.length < myIdx.length) {
    // Birth stragglers (single 15s IDENTIFY timeouts) must not void a
    // 10k-sub army: tolerate down to MIN_SUBS (default: all). Delivery
    // accounting uses held subs, so partial shards stay valid.
    const minRequired = parseInt(process.env.MIN_SUBS || String(myIdx.length), 10);
    if (subs.length < minRequired) {
      throw new Error(`only ${subs.length}/${myIdx.length} subs connected (min ${minRequired})`);
    }
    console.error(`[${TAG}] birth stragglers: ${subs.length}/${myIdx.length} held, proceeding`);
  }

  const fanoutBefore = await scrapeFanout();

  if (SUBS_ONLY) {
    return subsOnlyAggregate(subs, fanoutBefore, shardIdx, shardN);
  }

  // 2. Paced poster: token-bucket at RATE/s, rotating WRITERS identities
  // (5/5s per (user,channel) => sustained RATE needs >= RATE writers).
  const writerTokens = [];
  for (let i = 0; i < WRITERS; i++) writerTokens.push(mintToken(WRITER_BASE + BigInt(i)));
  let posted = 0, post429 = 0, postErr = 0;
  const postedIds = [];
  let tokens = 0;
  let last = Date.now();
  let wi = 0;
  const t0 = Date.now();
  const deadline = t0 + DURATION_S * 1000;
  let benchSeq = 0;
  while (Date.now() < deadline && posted + post429 + postErr < totalPosts * 1.5) {
    const now = Date.now();
    tokens = Math.min(RATE, tokens + ((now - last) / 1000) * RATE);
    last = now;
    while (tokens >= 1 && posted < totalPosts) {
      tokens -= 1;
      const bid = `t1-${benchSeq++}`;
      const tok = writerTokens[wi % writerTokens.length]; wi++;
      const sentAt = Date.now();
      postedIds.push(bid);
      postMessage(API_BASE, tok, { content: `bench ${bid} ${sentAt}` }).then(
        ({ code }) => {
          if (code === 201) posted++;
          else if (code === 429) { post429++; tokens = Math.max(0, tokens - 1); }
          else { postErr++; }
        },
        () => { postErr++; }
      );
      // Cap in-flight posts to avoid unbounded promise pileup.
      if (benchSeq - posted - post429 - postErr > 500) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  // Drain: wait for in-flight posts to resolve (accepted or rejected).
  const drainDeadline = Date.now() + 15000;
  while (benchSeq > posted + post429 + postErr && Date.now() < drainDeadline) {
    await new Promise((r) => setTimeout(r, 200));
  }
  const postMs = Date.now() - t0;
  console.error(`[${TAG}] posted=${posted} 429s=${post429} errors=${postErr} in ${(postMs / 1000).toFixed(1)}s`);

  // 3. Settle: allow stragglers to arrive (2s quiet).
  await new Promise((r) => setTimeout(r, 2000));

  const fanoutAfter = await scrapeFanout();

  // 4. Aggregate client observations.
  const summary = aggregateResults(subs, postedIds.slice(0, posted), posted, post429, postErr, fanoutBefore, null);
  summary.evloop_lag_ms = stopEvloopTrack();
  const fanoutAfter2 = await scrapeFanout();
  summary.fanout_histogram_after = fanoutAfter2;
  summary.server_fanout_p99 = serverFanoutP99(fanoutBefore, fanoutAfter2);
  summary.gate.server_p99_le_50ms = summary.server_fanout_p99.p99_s !== null && summary.server_fanout_p99.p99_s <= 0.05;
  writeSummary(summary);
  closeSubs(subs);

  const pass = summary.gate.server_p99_le_50ms && summary.gate.zero_missed && summary.gate.zero_closed;
  process.exit(pass ? 0 : 2);
}

// SUBS_ONLY mode: signal readiness, wait for the external poster's
// manifest, settle, aggregate against it. No posting in this process.
// Only shard 0 owns the ready file + final aggregation; other shards write
// partial JSON (OUT) and exit 0/2 on their own gate.
async function subsOnlyAggregate(subs, fanoutBefore, shardIdx, shardN) {
  const fs = require('fs');
  const isLeader = shardIdx === 0;
  if (isLeader) {
    fs.writeFileSync(READY_FILE, String(Date.now()));
  }
  console.error(`[${TAG}] subs READY (shard ${shardIdx}/${shardN}), waiting for manifest ${MANIFEST}...`);
  const t0 = Date.now();
  while (Date.now() - t0 < 600000) {
    try {
      fs.accessSync(MANIFEST);
      break;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  let postedIds;
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    postedIds = m.manifest.map((e) => e.bid);
    console.error(`[${TAG}] manifest: posted=${m.posted} 429s=${m.post429} errors=${m.postErr}`);
    var posterStats = { posted: m.posted, post429: m.post429, postErr: m.postErr };
  } catch (e) {
    throw new Error(`manifest unreadable: ${e.message}`);
  }
  console.error(`[${TAG}] settling ${SETTLE_S}s...`);
  await new Promise((r) => setTimeout(r, SETTLE_S * 1000));

  const fanoutAfter = await scrapeFanout();
  const evloopLag = stopEvloopTrack();
  console.error(`[${TAG}] evloop_lag_ms p50=${evloopLag.p50} p99=${evloopLag.p99} max=${evloopLag.max}`);
  const summary = aggregateResults(subs, postedIds, posterStats.posted, posterStats.post429, posterStats.postErr, fanoutBefore, fanoutAfter);
  summary.evloop_lag_ms = evloopLag;
  try {
    const m = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    if (m.postLatencyMs) summary.post_latency_ms = m.postLatencyMs;
  } catch {}
  writeSummary(summary);
  closeSubs(subs);

  const pass = summary.gate.server_p99_le_50ms && summary.gate.zero_missed && summary.gate.zero_closed;
  process.exit(pass ? 0 : 2);
}

function aggregateResults(subs, postedIds, posted, post429, postErr, fanoutBefore, fanoutAfter) {
  let totalRecv = 0, totalDups = 0;
  const allLat = [];
  let minRecv = Infinity, maxRecv = 0;
  let closedSubs = 0;
  const expectedIds = new Set(postedIds);
  let missedWorst = 0;
  for (const { rec } of subs) {
    // Verify-late: dedup + latency math over stored tuples, after close.
    const seen = new Set();
    let dups = 0;
    for (const [bid, sentAt, recvAt] of rec.tuples) {
      if (seen.has(bid)) { dups++; continue; }
      seen.add(bid);
      if (Number.isFinite(sentAt)) allLat.push(recvAt - sentAt);
    }
    const received = seen.size;
    totalRecv += received;
    totalDups += dups;
    if (rec.closed) closedSubs++;
    minRecv = Math.min(minRecv, received);
    maxRecv = Math.max(maxRecv, received);
    let missed = 0;
    for (const bid of expectedIds) if (!seen.has(bid)) missed++;
    missedWorst = Math.max(missedWorst, missed);
  }
  allLat.sort((a, b) => a - b);
  const lat = {
    n: allLat.length,
    p50: pct(allLat, 0.5),
    p90: pct(allLat, 0.9),
    p95: pct(allLat, 0.95),
    p99: pct(allLat, 0.99),
    max: allLat.length ? allLat[allLat.length - 1] : null,
    note: 'diagnostic only: includes API write path + socket delivery, NOT the gate',
  };

  // Gate latency quantity: server dispatch p99 (holder node). Client e2e
  // above stays as a diagnostic; loss counting stays client-side.
  const serverFanout = serverFanoutP99(fanoutBefore, fanoutAfter);
  const serverP99Ok = serverFanout.p99_s !== null && serverFanout.p99_s <= 0.05;

  return {
    tool: 'ws_fanout',
    tag: TAG,
    subs: SUBS, held_subs: subs.length, rate: RATE, duration_s: DURATION_S,
    posted, post429, postErr, expected_msgs: posted,
    per_client_recv: { min: minRecv === Infinity ? 0 : minRecv, max: maxRecv },
    total_deliveries: totalRecv,
    expected_deliveries: posted * subs.length,
    delivery_rate: posted ? +(totalRecv / (posted * subs.length)).toFixed(5) : 0,
    total_dups: totalDups,
    worst_client_missed: missedWorst,
    closed_subs: closedSubs,
    client_latency_ms: lat,
    server_fanout_p99: serverFanout,
    fanout_histogram_before: fanoutBefore,
    fanout_histogram_after: fanoutAfter,
    gate: { server_p99_le_50ms: serverP99Ok, zero_missed: missedWorst === 0, zero_closed: closedSubs === 0 },
  };
}

function writeSummary(summary) {
  const fs = require('fs');
  const path = require('path');
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

function closeSubs(subs) {
  for (const c of subs) { clearInterval(c.hb); try { c.ws.close(); } catch {} }
}

function closedSampleClosed(subs) {
  let n = 0;
  for (const { rec } of subs) if (rec.closed) n++;
  return n;
}

main().catch((e) => { console.error(`[${TAG}] FATAL: ${e.message}`); process.exit(1); });
