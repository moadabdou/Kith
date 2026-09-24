#!/usr/bin/env node
/**
 * Phase 7c gateway drill driver (Issue #86).
 *
 * Connects N WS clients (split across gateway :4000/:4001 or via Caddy),
 * IDENTIFies each, heartbeats, and records every MESSAGE_CREATE dispatch
 * frame (per-client seq + message id). Prints a JSON summary used by
 * scripts/chaos/phase7_gateway.sh assertions:
 *   { clients: [{url, session_id, received, dup_ids, min_seq, max_seq}], ... }
 *
 * Env:
 *   WS_URLS      comma-separated ws urls to round-robin clients across
 *   CLIENTS      number of clients (default 4)
 *   TOKEN        JWT for IDENTIFY (must be a member of GUILD_ID)
 *   GUILD_ID     guild under test
 *   CHANNEL_ID   channel to POST into (driver does not post; the .sh does)
 *   API_BASE     REST base for setup posts (default http://127.0.0.1:8080)
 *   RUN_SECONDS  how long to listen (default 20)
 *   TAG          run label for logs
 */
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const WS_URLS = (process.env.WS_URLS || 'ws://127.0.0.1:4000/ws').split(',');
const CLIENTS = parseInt(process.env.CLIENTS || '4', 10);
const TOKEN = process.env.TOKEN || '';
const GUILD_ID = process.env.GUILD_ID || '99900000000000000';
const CHANNEL_ID = process.env.CHANNEL_ID || '99900000000000101';
const RUN_SECONDS = parseInt(process.env.RUN_SECONDS || '20', 10);
const TAG = process.env.TAG || 'run';
const MODE = process.env.MODE || 'listen';
// MODE=resume: client 0 IDENTIFies, collects 3s, closes; then RESUMEs the
// same session with (max_seq - RESUME_BEHIND) and collects the replay.
// Reports replayed frames + monotonicity for the ordering drill.
const RESUME_BEHIND = parseInt(process.env.RESUME_BEHIND || '2', 10);

async function api(path, token, body) {
  const res = await fetch(`${API_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  if (res.status !== 201) throw new Error(`POST ${path} -> ${res.status}: ${text.slice(0, 200)}`);
  return JSON.parse(text);
}

function connectClient(url, token, idx) {
  return new Promise((resolve, reject) => {
    const rec = { url, idx, session_id: null, received: [], seen_ids: {}, dup_ids: [], min_seq: null, max_seq: null, ready: false };
    const ws = new WebSocket(url);
    const hb = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: null }));
    }, 8000);
    const timer = setTimeout(() => reject(new Error(`client ${idx}: no READY in 10s`)), 10_000);
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.op === 10) {
        ws.send(JSON.stringify({ op: 2, d: { token } }));
      } else if (msg.t === 'READY') {
        rec.session_id = msg.d.session_id;
        rec.ready = true;
        clearTimeout(timer);
        resolve({ ws, rec, hb });
      } else if (msg.op === 0 && msg.t === 'MESSAGE_CREATE') {
        const id = msg.d && msg.d.id;
        const s = msg.s;
        rec.received.push({ s, id, t: Date.now() });
        if (id) {
          if (rec.seen_ids[id]) rec.dup_ids.push(id);
          rec.seen_ids[id] = true;
        }
        rec.min_seq = rec.min_seq === null ? s : Math.min(rec.min_seq, s);
        rec.max_seq = rec.max_seq === null ? s : Math.max(rec.max_seq, s);
      }
    };
    ws.onerror = (e) => { clearTimeout(timer); reject(new Error(`client ${idx} ws error`)); };
  });
}

async function main() {
  if (!TOKEN) throw new Error('TOKEN env required');
  if (MODE === 'resume') return resumeMode();
  const clients = [];
  for (let i = 0; i < CLIENTS; i++) {
    const url = WS_URLS[i % WS_URLS.length];
    clients.push(await connectClient(url, TOKEN, i));
  }
  console.error(`[${TAG}] ${clients.length} clients READY (guild ${GUILD_ID})`);
  await new Promise((r) => setTimeout(r, RUN_SECONDS * 1000));
  const summary = {
    tag: TAG,
    clients: clients.map(({ rec }) => summarize(rec)),
  };
  console.log(JSON.stringify(summary));
  for (const c of clients) { clearInterval(c.hb); try { c.ws.close(); } catch {} }
  process.exit(0);
}

function summarize(rec) {
  return {
    url: rec.url,
    session_id: rec.session_id,
    received: rec.received.length,
    unique_ids: Object.keys(rec.seen_ids).length,
    dup_ids: rec.dup_ids,
    min_seq: rec.min_seq,
    max_seq: rec.max_seq,
    frames: rec.received,
  };
}

async function resumeMode() {
  const url = WS_URLS[0];
  const { ws, rec, hb } = await connectClient(url, TOKEN, 0);
  console.error(`[${TAG}] identified session ${rec.session_id}, collecting 3s`);
  await new Promise((r) => setTimeout(r, 3000));
  const atClose = rec.max_seq;
  ws.close();
  clearInterval(hb);
  await new Promise((r) => setTimeout(r, 1000));

  // Reconnect and RESUME behind by RESUME_BEHIND.
  const replay = { received: [], seen_ids: {}, dup_ids: [], min_seq: null, max_seq: null };
  await new Promise((resolve, reject) => {
    const ws2 = new WebSocket(url);
    const hb2 = setInterval(() => {
      if (ws2.readyState === 1) ws2.send(JSON.stringify({ op: 1, d: null }));
    }, 8000);
    const timer = setTimeout(() => reject(new Error('no resume reply in 10s')), 10_000);
    ws2.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.op === 10) {
        const base = atClose === null ? 0 : atClose;
        ws2.send(JSON.stringify({ op: 6, d: { token: TOKEN, session_id: rec.session_id, seq: Math.max(0, base - RESUME_BEHIND) } }));
      } else if (msg.op === 0 && msg.t === 'MESSAGE_CREATE') {
        replay.received.push({ s: msg.s, id: msg.d && msg.d.id });
        if (msg.d && msg.d.id) {
          if (replay.seen_ids[msg.d.id]) replay.dup_ids.push(msg.d.id);
          replay.seen_ids[msg.d.id] = true;
        }
        replay.min_seq = replay.min_seq === null ? msg.s : Math.min(replay.min_seq, msg.s);
        replay.max_seq = replay.max_seq === null ? msg.s : Math.max(replay.max_seq, msg.s);
      } else if (msg.op === 9) {
        clearTimeout(timer); clearInterval(hb2);
        resolve({ invalid: true });
      }
    };
    // First replayed or live frame within window counts as success; collect 6s.
    setTimeout(() => { clearTimeout(timer); clearInterval(hb2); try { ws2.close(); } catch {} resolve({ invalid: false }); }, 6000);
  }).then((r) => {
    const mono = replay.received.every((f, i, a) => i === 0 || a[i - 1].s < f.s);
    console.log(JSON.stringify({
      tag: TAG, session_id: rec.session_id, closed_at_seq: atClose,
      replayed: replay.received.length, unique_replayed: Object.keys(replay.seen_ids).length,
      dup_ids: replay.dup_ids, monotonic: mono, invalid_session: r.invalid || false,
    }));
    process.exit(0);
  }).catch((e) => { console.error(`[${TAG}] FATAL: ${e.message}`); process.exit(1); });
}

main().catch((e) => { console.error(`[${TAG}] FATAL: ${e.message}`); process.exit(1); });
