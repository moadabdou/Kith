#!/usr/bin/env node
// Soak typers (Issue #94): N sessions sending TYPING_START in rotation,
// staggered past the 8s per-(user,channel) cooldown. Rate-limited drops
// are fine (still exercises the path). Heartbeats kept throughout.
const WS_URL = process.env.WS_URL || 'ws://127.0.0.1:4000/ws';
const CHANNEL_ID = process.env.CHANNEL_ID || '99900000000000101';
const N = parseInt(process.env.TYPERS || '10', 10);
const BASE = BigInt(process.env.TYPER_BASE || '99900000000000002');
const SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const DURATION_S = parseInt(process.env.DURATION_S || '1800', 10);
const PERIOD_S = parseFloat(process.env.TYPER_PERIOD_S || '12');
const crypto = require('crypto');

function mint(sub) {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: String(sub), iat: now, exp: now + 604800 });
  const sig = crypto.createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

function connect(token) {
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
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error('ws error')); };
    ws.onclose = () => clearInterval(hb);
  });
}

(async () => {
  const conns = [];
  for (let i = 0; i < N; i++) {
    try { conns.push(await connect(mint(BASE + BigInt(i)))); }
    catch (e) { console.error(`[typers] connect ${i} failed: ${e.message}`); }
  }
  console.error(`[typers] ${conns.length}/${N} typing sessions up, period ${PERIOD_S}s`);
  const t0 = Date.now();
  let sent = 0;
  let i = 0;
  while (Date.now() - t0 < DURATION_S * 1000) {
    const c = conns[i % conns.length];
    if (c && c.ws.readyState === 1) {
      c.ws.send(JSON.stringify({ t: 'TYPING_START', d: { channel_id: CHANNEL_ID } }));
      sent++;
    }
    i++;
    await new Promise((r) => setTimeout(r, (PERIOD_S * 1000) / Math.max(1, conns.length)));
  }
  console.error(`[typers] sent ${sent} typing frames`);
  for (const c of conns) { clearInterval(c.hb); try { c.ws.close(); } catch {} }
  process.exit(0);
})();
