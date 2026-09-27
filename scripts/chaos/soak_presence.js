#!/usr/bin/env node
// Soak presence churn + watchers (Issue #94): K flippers cycle Op-3
// online -> dnd -> idle -> online while watcher sessions log every
// PRESENCE_UPDATE for exactly those users. Post-run checker asserts each
// scripted flip was observed and last-seen matches the final flip.
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:4000/ws';
const K = parseInt(process.env.FLIPPERS || '3', 10);
// Flippers must be real guild members sharing a guild with the watcher,
// or broadcasts have no mutual guild to fan out to. Defaults use bench
// members distinct from the poster writer range.
const FLIPPER_BASE = BigInt(process.env.FLIPPER_BASE || '99900000000001001');
const SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const WATCH_TOKEN = process.env.WATCH_TOKEN || '';
const DURATION_S = parseInt(process.env.DURATION_S || '1800', 10);
const FLIP_EVERY_S = parseInt(process.env.FLIP_EVERY_S || '90', 10);
const OUT = process.env.PRESENCE_LOG || '/tmp/soak_presence.jsonl';
const crypto = require('crypto');
const fs = require('fs');

const STATES = ['online', 'dnd', 'idle'];

function mint(sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: String(sub), iat: now, exp: now + 604800 });
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function connect(token, onmsg) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(WS_URL);
    const hb = setInterval(() => {
      if (ws.readyState === 1) ws.send(JSON.stringify({ op: 1, d: null }));
    }, 8000);
    const timer = setTimeout(() => reject(new Error('no READY')), 15000);
    ws.onmessage = (ev) => {
      let msg; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.op === 10) ws.send(JSON.stringify({ op: 2, d: { token } }));
      else if (msg.t === 'READY') { clearTimeout(timer); resolve({ ws, hb }); }
      else if (onmsg) onmsg(msg);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    ws.onclose = () => clearInterval(hb);
  });
}

(async () => {
  if (!WATCH_TOKEN) throw new Error('WATCH_TOKEN env required');
  const targets = Array.from({ length: K }, (_, i) => String(FLIPPER_BASE + BigInt(i)));
  const log = fs.createWriteStream(OUT, { flags: 'a' });
  const seen = {};
  const watcher = await connect(WATCH_TOKEN, (msg) => {
    const pl = msg.d || {};
    const uid = String((pl.user && pl.user.id) || pl.user_id || '');
    if (msg.t === 'PRESENCE_UPDATE' || msg.type === 'PRESENCE_UPDATE') {
      if (targets.includes(uid)) {
        seen[uid] = (seen[uid] || 0) + 1;
        log.write(JSON.stringify({ t: Date.now(), user: uid, status: pl.status }) + '\n');
      }
    }
  });
  console.error(`[presence] watcher up, tracking ${targets.join(',')}`);

  const flippers = [];
  for (const uid of targets) {
    try { flippers.push({ uid, idx: 0, ...(await connect(mint(uid))) }); }
    catch (e) { console.error(`[presence] flipper ${uid} failed: ${e.message}`); }
  }
  console.error(`[presence] ${flippers.length}/${K} flippers up`);
  const flips = {};
  const t0 = Date.now();
  while (Date.now() - t0 < DURATION_S * 1000) {
    for (const f of flippers) {
      const status = STATES[f.idx % STATES.length];
      f.idx++;
      if (f.ws.readyState === 1) {
        f.ws.send(JSON.stringify({ op: 3, d: { status, activities: [], afk: false, since: null } }));
        (flips[f.uid] = flips[f.uid] || []).push({ t: Date.now(), status });
      }
    }
    await new Promise((r) => setTimeout(r, FLIP_EVERY_S * 1000));
  }
  fs.writeFileSync(OUT + '.flips.json', JSON.stringify({ flips, seen }, null, 2));
  console.error(`[presence] done, flips per user: ${Object.values(flips).map((a) => a.length).join(',')}`);
  for (const f of flippers) { clearInterval(f.hb); try { f.ws.close(); } catch {} }
  clearInterval(watcher.hb);
  try { watcher.ws.close(); } catch {}
  process.exit(0);
})();
