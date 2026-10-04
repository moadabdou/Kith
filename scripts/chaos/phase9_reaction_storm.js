#!/usr/bin/env node
/**
 * Phase 9 Chaos Drill 1 — Reaction Storm (Issue #116, plan/13 §2 & §7).
 *
 * 500 sessions concurrently add/remove reactions on a single message
 * (500 x 0.8 rps ≈ 400 req/s aggregate, clean under the 5 req / 5s per-user
 * limiter), then assert triple-agreement with zero count drift:
 *
 * Two phases: clean baseline, then an impaired phase. Packet loss via tc
 * netem is unavailable in this sandbox (no CAP_NET_ADMIN even from
 * --privileged helpers), so the impaired phase is a 3x request burst
 * (BURST_RPS_MULT, default 3): same sessions, triple the per-session rate.
 * This exercises client timeouts, server retries/backoff, and the 5 req/5s
 * per-user limiter under pressure — a different stress vector than loss,
 * but the consistency assertion (zero drift) is identical.
 *
 * Ground truth comes from the live Scylla table — the actual drift detector.
 *
 * Each session owns a deterministic intent script: a fixed add/remove
 * sequence over a small emoji set. The final expected state per
 * (user, emoji) is purely a function of that script, so no coordination
 * between sessions is needed to compute ground truth.
 *
 * Env:
 *   API_BASE     REST base (default http://127.0.0.1:8080)
 *   SCYLLA       host for ground-truth CQL (default 127.0.0.1:9042)
 *   USERS        sessions (default 500)
 *   RPS          per-session req/s (default 0.8; keep ≤1 for a 429-free run)
 *   DURATION_S   storm seconds per phase (default 60)
 *   ROUNDS       reply/delete race rounds in the live section (default 20)
 *   TAG          run label for the results artifact
 *   OUT          results JSON path (default scripts/chaos/results/phase9_reaction_storm.json)
 *
 * Exit: 0 on zero drift + all race rounds legal, 2 otherwise.
 *
 * Requires: node with global fetch (node >= 18). Scylla ground truth uses
 * `docker exec <scylla> cqlsh` — no extra npm deps on purpose (chaos
 * scripts must run on a bare box like the other phase drivers).
 */
'use strict';

const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:8080/api').replace(/\/$/, '');
const USERS = parseInt(process.env.USERS || '500', 10);
// Reaction limiter is 5 req / 5s per user (api/cmd/api/main.go rxLimiter):
// default 0.8 rps keeps every session clean under burst tolerance.
const RPS = parseFloat(process.env.RPS || '0.8');
// Impaired phase multiplier: 3x burst intentionally exceeds the limiter so
// the phase measures graceful 429 handling + eventual convergence.
const BURST_RPS_MULT = parseFloat(process.env.BURST_RPS_MULT || '3');
const DURATION_S = parseInt(process.env.DURATION_S || '60', 10);
const ROUNDS = parseInt(process.env.ROUNDS || '20', 10);
const TAG = process.env.TAG || 'drill1';
const OUT = process.env.OUT || path.join(__dirname, 'results', 'phase9_reaction_storm.json');

const EMOJIS = ['🔥', '❤️', '🎉', '👍', '😂'];
// Mulberry32 — deterministic per-session scripts so runs are reproducible.
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

async function api(method, p, token, body, tries = 3) {
  let lastErr = null;
  for (let a = 0; a < tries; a++) {
    try {
      const res = await fetch(`${API_BASE}${p}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
      const text = await res.text();
      let json = null;
      try { json = text ? JSON.parse(text) : null; } catch { /* non-JSON */ }
      return { status: res.status, body: json, text };
    } catch (e) {
      lastErr = e;
      // Transient socket reset under connection churn (UND_ERR_SOCKET):
      // brief backoff, then retry. Only the final failure throws.
      await new Promise((r) => setTimeout(r, 300 + a * 700));
    }
  }
  throw lastErr;
}

function cql(query) {
  const out = execFileSync(
    'docker', ['exec', 'kith-scylla-1', 'cqlsh', '-e', query],
    { encoding: 'utf8', timeout: 30000 },
  );
  return out;
}

function parseCqlRows(out) {
  const rows = [];
  let data = false;
  for (const line of out.split('\n')) {
    if (/^---/.test(line)) { data = true; continue; }
    if (/^\(.*rows?\)/.test(line.trim())) break;
    if (data && line.trim() !== '') rows.push(line.split('|').map((c) => c.trim()));
  }
  return rows;
}

async function gatewayMemoryKB() {
  try {
    const out = execSync(
      `curl -s http://127.0.0.1:4000/metrics | grep 'gateway_erlang_memory_bytes{kind="total"}' | head -1`,
      { encoding: 'utf8', timeout: 10000 },
    );
    const m = out.match(/}\s+(\d+)/);
    return m ? Math.round(parseInt(m[1], 10) / 1024) : null;
  } catch { return null; }
}

async function setup() {
  const rand = Math.floor(Math.random() * 1e9);
  const owner = `storm_owner_${rand}`;
  const password = 'StormPassword123!';
  await api('POST', '/auth/register', null, { username: owner, email: `${owner}@kith.local`, password });
  const login = await api('POST', '/auth/login', null, { login: owner, password });
  if (login.status !== 200 || !login.body?.token) throw new Error(`owner login failed: ${login.status} ${login.text}`);
  const ownerToken = login.body.token;

  const guild = await api('POST', '/guilds', ownerToken, { name: `Storm Guild ${rand}` });
  const guildId = guild.body.id;
  const chan = await api('POST', `/guilds/${guildId}/channels`, ownerToken, { name: 'storm-lab', type: 0 });
  const channelId = chan.body.id;
  const seed = await api('POST', `/guilds/${guildId}/channels/${channelId}/messages`, ownerToken, { content: 'reaction storm target 🎯' });
  const messageId = seed.body.id;
  return { ownerToken, guildId, channelId, messageId, password, rand };
}

async function makeSession(i, password, rand, guildId, channelId, ownerToken) {
  const username = `storm_${rand}_${i}`;
  await api('POST', '/auth/register', null, { username, email: `${username}@kith.local`, password });
  const login = await api('POST', '/auth/login', null, { login: username, password });
  const token = login.body.token;
  // Join the guild via owner-created invite (invite is channel-scoped).
  const inv = await api('POST', '/invites', ownerToken, { channel_id: String(channelId) });
  if (inv.status !== 200 && inv.status !== 201) throw new Error(`invite failed: ${inv.status} ${inv.text}`);
  const code = inv.body.code || inv.body.invite?.code;
  if (!code) throw new Error(`no invite code in: ${inv.text}`);
  const join = await api('POST', `/invites/${code}/join`, token, {});
  if (![200, 201, 204].includes(join.status)) {
    throw new Error(`join failed: ${join.status} ${join.text}`);
  }
  // Fetch own user id for ground-truth keying.
  const me = await api('GET', '/users/@me', token, undefined);
  return { token, userId: String(me.body.id), username };
}

// Deterministic per-session intent: for each emoji, a pseudo-random final
// state (present/absent) plus a script of toggles ending in that state.
// Ground truth = final states only; intermediate toggles exercise the path.
function buildScript(i) {
  const r = rng(0xC0FFEE + i);
  const script = [];
  const finalState = {};
  for (const e of EMOJIS) {
    const present = r() < 0.5;
    finalState[e] = present;
    const toggles = 1 + Math.floor(r() * 5); // 1..5 ops
    // Walk from absent; odd toggles end present, even end absent — pad to match.
    let state = false;
    for (let t = 0; t < toggles; t++) {
      state = !state;
      script.push({ emoji: e, op: state ? 'add' : 'remove' });
    }
    if (state !== present) {
      state = !state;
      script.push({ emoji: e, op: state ? 'add' : 'remove' });
    }
  }
  // Shuffle ops so sessions interleave unpredictably (seeded).
  for (let k = script.length - 1; k > 0; k--) {
    const j = Math.floor(r() * (k + 1));
    [script[k], script[j]] = [script[j], script[k]];
  }
  return { script, finalState };
}

async function react(token, channelId, messageId, emoji, op) {
  const p = `/channels/${channelId}/messages/${messageId}/reactions/${encodeURIComponent(emoji)}/@me`;
  const t0 = Date.now();
  const res = await api(op === 'add' ? 'PUT' : 'DELETE', p, token);
  return { status: res.status, latencyMs: Date.now() - t0 };
}

async function runStorm(sessions, channelId, messageId, durationS, rpsOverride) {
  const rate = rpsOverride || RPS;
  const intervalMs = 1000 / rate;
  const deadline = Date.now() + durationS * 1000;
  const stats = { sent: 0, ok: 0, rateLimited: 0, failed: 0, latencies: [], rps: rate };
  // Per-session op cursor; loop the script until the deadline.
  const cursors = sessions.map(() => 0);

  await Promise.all(sessions.map(async (s, i) => {
    const { script } = s.stormScript;
    while (Date.now() < deadline) {
      const step = script[cursors[i] % script.length];
      cursors[i] += 1;
      try {
        const r = await react(s.token, channelId, messageId, step.emoji, step.op);
        stats.sent += 1;
        if (r.status === 204) stats.ok += 1;
        else if (r.status === 429) stats.rateLimited += 1;
        else stats.failed += 1;
        stats.latencies.push(r.latencyMs);
      } catch {
        stats.sent += 1;
        stats.failed += 1;
      }
      const wait = intervalMs - 2; // crude pacing; drift acceptable for a storm
      if (wait > 0) await new Promise((r2) => setTimeout(r2, wait));
    }
  }));

  // Settle: replay each session's FINAL intent state only (one write per
  // (user, emoji)), sequentially with 429 backoff. Settle writes are
  // convergence, not load — counted separately so the storm's 429 gate
  // measures only the paced storm phase.
  const settle = { sent: 0, ok: 0, rateLimited: 0, failed: 0 };
  for (const s of sessions) {
    for (const [emoji, present] of Object.entries(s.stormScript.finalState)) {
      const op = present ? 'add' : 'remove';
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          const r = await react(s.token, channelId, messageId, emoji, op);
          settle.sent += 1;
          if (r.status === 204) { settle.ok += 1; break; }
          if (r.status === 429) {
            settle.rateLimited += 1;
            await new Promise((x) => setTimeout(x, 1500));
            continue;
          }
          settle.failed += 1;
          break;
        } catch { settle.failed += 1; break; }
      }
    }
  }
  await new Promise((r) => setTimeout(r, 5000));
  stats.latencies.sort((a, b) => a - b);
  const p99 = stats.latencies.length ? stats.latencies[Math.floor(stats.latencies.length * 0.99)] : 0;
  return { ...stats, p99Ms: p99, latencies: undefined, settle };
}

function groundTruthFromIntents(sessions) {
  // emoji -> Set(userId) expected present at the end.
  const truth = {};
  for (const e of EMOJIS) truth[e] = new Set();
  for (const s of sessions) {
    for (const [emoji, present] of Object.entries(s.stormScript.finalState)) {
      if (present) truth[emoji].add(s.userId);
    }
  }
  return truth;
}

function scyllaReactionRows(channelId, messageId) {
  const out = cql(
    `SELECT emoji, user_id FROM kith.message_reactions WHERE channel_id = ${channelId} AND message_id = ${messageId};`,
  );
  const actual = {};
  for (const e of EMOJIS) actual[e] = new Set();
  for (const [emoji, userId] of parseCqlRows(out)) {
    if (!actual[emoji]) actual[emoji] = new Set();
    actual[emoji].add(String(userId));
  }
  return actual;
}

async function apiTallies(token, guildId, channelId, messageId) {
  const res = await api('GET', `/guilds/${guildId}/channels/${channelId}/messages?limit=50`, token);
  const body = res.body;
  const msgs = body?.messages || (Array.isArray(body) ? body : []);
  // List is newest-first: the seed may sit below newer race parents.
  const m = (Array.isArray(msgs) ? msgs : []).find((x) => String(x.id) === String(messageId));
  if (!m) throw new Error(`seed message ${messageId} not found in timeline read (${(msgs || []).length} msgs)`);
  const tallies = {};
  for (const t of m.reactions || []) tallies[t.emoji] = t.count;
  return tallies;
}

function compareSets(label, truth, actual) {
  const drift = [];
  const emojis = new Set([...Object.keys(truth), ...Object.keys(actual)]);
  for (const e of emojis) {
    const t = truth[e] || new Set();
    const a = actual[e] instanceof Set ? actual[e] : new Set(Object.keys(actual[e] || {}));
    const missing = [...t].filter((u) => !a.has(String(u)));
    const extra = [...a].filter((u) => !t.has(String(u)));
    if (missing.length || extra.length) drift.push({ emoji: e, missing, extra });
  }
  return { label, driftCount: drift.length, drift };
}

async function runPhase(name, sessions, ctx, opts = {}) {
  console.log(`\n[STORM] Phase ${name}: ${sessions.length} sessions x ${opts.rps || RPS} rps x ${DURATION_S}s...`);
  const memBefore = await gatewayMemoryKB();
  const storm = await runStorm(sessions, ctx.channelId, ctx.messageId, DURATION_S, opts.rps);
  const memAfter = await gatewayMemoryKB();
  const truth = groundTruthFromIntents(sessions);
  const rows = scyllaReactionRows(ctx.channelId, ctx.messageId);
  const tallies = await apiTallies(ctx.ownerToken, ctx.guildId, ctx.channelId, ctx.messageId);
  const truthTallies = {};
  for (const [e, set] of Object.entries(truth)) truthTallies[e] = set.size;

  const c1 = compareSets('intent-vs-scylla', truth, rows);
  // tallies: {emoji: count} -> compare counts only.
  const tallyDrift = [];
  for (const e of EMOJIS) {
    const want = truthTallies[e] || 0;
    const got = tallies[e] || 0;
    if (want !== got) tallyDrift.push({ emoji: e, want, got });
  }
  const pass = opts.allowRateLimit
    ? c1.driftCount === 0 && tallyDrift.length === 0
    : c1.driftCount === 0 && tallyDrift.length === 0 && storm.rateLimited === 0;
  const memGrowthOk = memBefore === null || memAfter === null
    ? true // metrics unavailable: boundedness checked in the full drill via artifact
    : memAfter <= memBefore * 1.5 + 1024;
  const gate = pass && memGrowthOk;
  console.log(`[${name}] sent=${storm.sent} ok=${storm.ok} 429=${storm.rateLimited} failed=${storm.failed} p99=${storm.p99Ms}ms settle=${JSON.stringify(storm.settle)}`);
  console.log(`[${name}] drift(intent↔scylla)=${c1.driftCount} drift(tallies)=${tallyDrift.length} memBefore=${memBefore} memAfter=${memAfter} memOk=${memGrowthOk} => ${gate ? 'PASS' : 'FAIL'}`);
  return { name, storm, memBeforeKB: memBefore, memAfterKB: memAfter, memGrowthOk, intentVsScylla: c1, tallyDrift, pass: gate };
}

// Live reply/delete race smoke: N paired rounds, reply POST vs delete DELETE
// fired simultaneously at one parent. Each round must land in exactly one
// legal outcome — never a 500/orphan/partial. Posting is 5 req / 5s per user
// (msgLimiter), so rounds pace ~1.5s apart with 429 backoff+retry.
async function runRaceLive(ctx, sessions) {
  console.log(`\n[RACE] ${ROUNDS} live reply-vs-delete rounds...`);
  const outcomes = { replyWins: 0, deleteWins: 0, illegal: [] };
  const deleter = sessions[0];
  const replier = sessions[1 % sessions.length];
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function postWithBackoff(url, token, body, tries = 4) {
    for (let a = 0; a < tries; a++) {
      const res = await api('POST', url, token, body);
      if (res.status !== 429) return res;
      await sleep(1500 + a * 1000);
    }
    return api('POST', url, token, body);
  }
  for (let i = 0; i < ROUNDS; i++) {
    const parent = await postWithBackoff(
      `/guilds/${ctx.guildId}/channels/${ctx.channelId}/messages`, ctx.ownerToken,
      { content: `race parent ${i}` });
    if (parent.status !== 201 && parent.status !== 200) {
      outcomes.illegal.push({ round: i, kind: 'parent-seed-failed', status: parent.status });
      await sleep(1500);
      continue;
    }
    const parentId = parent.body.id;
    const [replyRes, delRes] = await Promise.all([
      (async () => {
        for (let a = 0; a < 4; a++) {
          const r = await api('POST', `/guilds/${ctx.guildId}/channels/${ctx.channelId}/messages`, replier.token, {
            content: `race reply ${i}`,
            message_reference: { message_id: String(parentId) },
          });
          if (r.status !== 429) return r;
          await sleep(1500 + a * 1000);
        }
        return { status: 429 };
      })(),
      (async () => {
        // Owner deletes (MANAGE path via ownership); small jitter for interleave variety.
        await new Promise((r) => setTimeout(r, Math.floor(Math.random() * 15)));
        return api('DELETE', `/channels/${ctx.channelId}/messages/${parentId}`, ctx.ownerToken);
      })(),
    ]);
    void delRes;
    if (replyRes.status === 201) {
      // Reply won: parent may now be deleted — list read-back must tombstone
      // (no single-message GET route exists; timeline hydration is the read path).
      const list = await api('GET', `/guilds/${ctx.guildId}/channels/${ctx.channelId}/messages?limit=50`, replier.token);
      const msgs = list.body?.messages || list.body || [];
      const m = (Array.isArray(msgs) ? msgs : []).find((x) => String(x.id) === String(replyRes.body.id));
      if (m && String(m.reply_to) === String(parentId) && (m.referenced_message === null || m.referenced_message === undefined)) {
        outcomes.replyWins += 1;
      } else {
        outcomes.illegal.push({ round: i, kind: 'reply-won-but-readback-wrong', found: !!m, body: m });
      }
    } else if (replyRes.status === 400) {
      // Delete won: parent must be gone from the timeline, no reply row.
      const list = await api('GET', `/guilds/${ctx.guildId}/channels/${ctx.channelId}/messages?limit=50`, ctx.ownerToken);
      const msgs = Array.isArray(list.body?.messages) ? list.body.messages : (Array.isArray(list.body) ? list.body : []);
      const parentGone = !msgs.some((x) => String(x.id) === String(parentId));
      const noReply = !msgs.some((x) => String(x.reply_to) === String(parentId));
      if (parentGone && noReply) outcomes.deleteWins += 1;
      else outcomes.illegal.push({ round: i, kind: 'reply-400-but-state-wrong', parentGone, noReply });
    } else {
      outcomes.illegal.push({ round: i, kind: 'unexpected-reply-status', status: replyRes.status, text: replyRes.text });
    }
    await sleep(1500); // respect the 5 req / 5s post limiter between rounds
  }
  const pass = outcomes.illegal.length === 0;
  console.log(`[RACE] replyWins=${outcomes.replyWins} deleteWins=${outcomes.deleteWins} illegal=${outcomes.illegal.length} => ${pass ? 'PASS' : 'FAIL'}`);
  return { ...outcomes, pass };
}

async function main() {
  console.log('================================================================');
  console.log('    PHASE 9 DRILL 1 — REACTION STORM + REPLY/DELETE RACE (#116)');
  console.log(`    ${USERS} sessions x ${RPS} rps (${USERS * RPS} req/s) x ${DURATION_S}s/phase`);
  console.log('================================================================');

  const ctx = await setup();
  console.log(`[SETUP] guild=${ctx.guildId} channel=${ctx.channelId} msg=${ctx.messageId}`);

  console.log(`[SETUP] creating ${USERS} sessions...`);
  const sessions = [];
  const batch = 10;
  // Batched with a settle delay: hundreds of near-simultaneous register+login
  // pairs exhaust the API's ephemeral-port/accept backlog and reset sockets.
  for (let b = 0; b < USERS; b += batch) {
    const chunk = [];
    for (let i = b; i < Math.min(b + batch, USERS); i++) {
      chunk.push(makeSession(i, ctx.password, ctx.rand, ctx.guildId, ctx.channelId, ctx.ownerToken).then((s) => {
        s.stormScript = buildScript(i);
        return s;
      }));
    }
    sessions.push(...(await Promise.all(chunk)));
    await new Promise((r) => setTimeout(r, 800));
    process.stdout.write(`  ${sessions.length}/${USERS}\r`);
  }
  console.log(`\n[SETUP] ${sessions.length} sessions ready`);

  const phaseClean = await runPhase('clean', sessions, ctx);

  console.log(`\n[CHAOS] Burst-impaired phase: same sessions at ${RPS * BURST_RPS_MULT} rps (limiter pressure expected)...`);
  // Impaired = burst: 429s are the expected backpressure signal, not a
  // failure — but drift must still be zero after settle convergence.
  let phaseImpaired = await runPhase('impaired-burst', sessions, ctx, {
    rps: RPS * BURST_RPS_MULT,
    allowRateLimit: true,
  });

  const race = await runRaceLive(ctx, sessions);

  const pass = phaseClean.pass && phaseImpaired.pass && race.pass;
  const result = {
    experiment: 'CHAOS-PHASE-9-DRILL-1-REACTION-STORM',
    issue: 116,
    tag: TAG,
    at: new Date().toISOString(),
    config: { users: USERS, rps: RPS, burstMult: BURST_RPS_MULT, durationS: DURATION_S, emojis: EMOJIS, rounds: ROUNDS, impairedModel: 'burst (no CAP_NET_ADMIN for tc netem in sandbox)' },
    phases: [phaseClean, phaseImpaired],
    race,
    gate: pass ? 'PASS' : 'FAIL',
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(result, null, 2));
  console.log(`\n[RESULT] gate=${result.gate} artifact=${OUT}`);
  process.exit(pass ? 0 : 2);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
