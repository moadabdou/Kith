#!/usr/bin/env node
/**
 * Fan-out poster, Step 4 T1 companion (Issue #88).
 *
 * Split from ws_fanout.js: the combined driver wedged its own event loop
 * at 20k inbound frames/s (JSON.parse + regex + array pushes) while also
 * running fetch-based posts in the same process — client-observed p99
 * 13.9s with server p99 ~25ms. Poster runs alone here; subscribers run
 * alone in ws_fanout.js SUBS-only mode. They coordinate via a ready file
 * and a shared posted-ids manifest.
 *
 * Protocol:
 *   1. Poster waits for READY_FILE (written by subscriber process when all
 *      subs READY), then posts at RATE/s for DURATION_S.
 *   2. Poster writes MANIFEST (JSON array of {bid, sentAt}) when done.
 *   3. Subscriber process waits for MANIFEST + SETTLE_S, then aggregates
 *      against the manifest (missed = manifest ids never seen).
 *
 * Env (poster): API_BASE, GUILD_ID, CHANNEL_ID, RATE, DURATION_S, WRITERS,
 *   WRITER_BASE, JWT_SECRET, TAG, READY_FILE, MANIFEST, ID_PREFIX.
 */
const API_BASE = process.env.API_BASE || 'http://127.0.0.1:8080';
const GUILD_ID = process.env.GUILD_ID || '99900000000000000';
const CHANNEL_ID = process.env.CHANNEL_ID || '99900000000000101';
const RATE = parseFloat(process.env.RATE || '100');
const DURATION_S = parseInt(process.env.DURATION_S || '60', 10);
const WRITERS = parseInt(process.env.WRITERS || '120', 10);
const WRITER_BASE = BigInt(process.env.WRITER_BASE || '99900110000000001');
const JWT_SECRET = process.env.JWT_SECRET || 'dev-jwt-secret-change-me';
const TAG = process.env.TAG || 'poster';
const READY_FILE = process.env.READY_FILE || `/tmp/fanout_${TAG}.ready`;
const MANIFEST = process.env.MANIFEST || `${__dirname}/results/ws_fanout_${TAG}.posted.json`;
const ID_PREFIX = process.env.ID_PREFIX || TAG;
// Little's-law cap on concurrent POSTs: a 500-deep herd against a
// 25-conn pool builds our own queue. ~50 covers 100/s at 500ms tails.
const MAX_INFLIGHT = parseInt(process.env.MAX_INFLIGHT || '50', 10);
const crypto = require('crypto');
const fs = require('fs');

function mintToken(sub) {
  const b64 = (o) => Buffer.from(typeof o === 'string' ? o : JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const h = b64({ alg: 'HS256', typ: 'JWT' });
  const p = b64({ sub: String(sub), iat: now, exp: now + 604800 });
  const sig = crypto.createHmac('sha256', JWT_SECRET).update(`${h}.${p}`).digest('base64url');
  return `${h}.${p}.${sig}`;
}

async function postMessage(token, content) {
  const t0 = Date.now();
  try {
    const res = await fetch(`${API_BASE}/api/guilds/${GUILD_ID}/channels/${CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ content }),
    });
    return { code: res.status, ms: Date.now() - t0 };
  } catch {
    return { code: 0, ms: Date.now() - t0 };
  }
}

async function waitFor(path, timeoutMs, label) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      fs.accessSync(path);
      return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  console.error(`[${TAG}] FATAL: timed out waiting for ${label} ${path}`);
  process.exit(1);
}

async function main() {
  const totalPosts = Math.floor(RATE * DURATION_S);
  console.error(`[${TAG}] waiting for subscriber ready file...`);
  await waitFor(READY_FILE, 300000, 'ready');
  console.error(`[${TAG}] posting ${totalPosts} msgs @${RATE}/s with ${WRITERS} writers`);

  const writerTokens = [];
  for (let i = 0; i < WRITERS; i++) writerTokens.push(mintToken(WRITER_BASE + BigInt(i)));
  const manifest = [];
  const postLat = [];
  let posted = 0, post429 = 0, postErr = 0;
  let tokens = 0;
  let last = Date.now();
  let wi = 0;
  let benchSeq = 0;
  const t0 = Date.now();
  const deadline = t0 + DURATION_S * 1000;
  const inflight = new Set();
  while ((Date.now() < deadline && benchSeq < totalPosts) || inflight.size > 0) {
    const now = Date.now();
    if (now < deadline && benchSeq < totalPosts) {
      tokens = Math.min(RATE, tokens + ((now - last) / 1000) * RATE);
      last = now;
      while (tokens >= 1 && benchSeq < totalPosts) {
        tokens -= 1;
        const bid = `${ID_PREFIX}-${benchSeq++}`;
        const tok = writerTokens[wi % writerTokens.length]; wi++;
        const sentAt = Date.now();
        manifest.push({ bid, sentAt });
        const p = postMessage(tok, `bench ${bid} ${sentAt}`).then(({ code, ms }) => {
          inflight.delete(p);
          if (Number.isFinite(ms)) postLat.push(ms);
          if (code === 201) posted++;
          else if (code === 429) { post429++; tokens = Math.max(0, tokens - 1); }
          else { postErr++; }
        });
        inflight.add(p);
        if (inflight.size > MAX_INFLIGHT) await Promise.race(inflight);
      }
    } else if (inflight.size > 0) {
      await Promise.race(inflight);
    } else {
      break;
    }
    await new Promise((r) => setTimeout(r, 5));
  }
  const postMs = Date.now() - t0;
  console.error(`[${TAG}] posted=${posted} 429s=${post429} errors=${postErr} in ${(postMs / 1000).toFixed(1)}s`);
  postLat.sort((a, b) => a - b);
  const q = (x) => (postLat.length ? postLat[Math.min(postLat.length - 1, Math.floor(postLat.length * x))] : null);
  // Clock 1/3: write-path latency (poster -> API 201), isolates PG/Scylla/NATS-publish.
  const postLatencyMs = { n: postLat.length, p50: q(0.5), p99: q(0.99), max: postLat.length ? postLat[postLat.length - 1] : null };
  console.error(`[${TAG}] post_latency_ms p50=${postLatencyMs.p50} p99=${postLatencyMs.p99} max=${postLatencyMs.max}`);
  fs.mkdirSync(require('path').dirname(MANIFEST), { recursive: true });
  fs.writeFileSync(MANIFEST, JSON.stringify({ posted, post429, postErr, postLatencyMs, manifest }));
  console.log(JSON.stringify({ posted, post429, postErr, postLatencyMs }));
  process.exit(postErr > posted * 0.01 ? 1 : 0);
}

main().catch((e) => { console.error(`[${TAG}] FATAL: ${e.message}`); process.exit(1); });
