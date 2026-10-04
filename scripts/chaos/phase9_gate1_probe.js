#!/usr/bin/env node
/**
 * Phase 9 Gate 1 probe (Issue #117): idle single-op reaction latency.
 * 200 sequential PUT + 200 sequential DELETE on one message, no concurrency:
 * measures the local write path (HTTP + Scylla LOCAL_QUORUM + NATS publish),
 * reported as p50/p99/max. Gate: p99 < 15ms locally.
 * Exit 0 when the gate passes, 2 otherwise.
 */
'use strict';
const API_BASE = (process.env.API_BASE || 'http://127.0.0.1:8080/api').replace(/\/$/, '');
const N = parseInt(process.env.N || '200', 10);
const EMOJI = process.env.EMOJI || '🔥';
// Idle probe must respect the fixed-window limiter (5 req / 5s per user,
// rxLimiter): batch 5 ops then wait out the window. The gate measures path
// latency, not limiter throughput.
const GAP_MS = parseInt(process.env.GAP_MS || '5200', 10);

async function timed(method, p, token, body) {
  const t0 = performance.now();
  const res = await fetch(`${API_BASE}${p}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const ms = performance.now() - t0;
  await res.text().catch(() => {});
  return { status: res.status, ms };
}

async function main() {
  const rand = Math.floor(Math.random() * 1e9);
  const owner = `gate1_${rand}`;
  const password = 'Gate1Probe123!';
  const jpost = async (p, t, b) => {
    const rr = await fetch(`${API_BASE}${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${t}` }, body: JSON.stringify(b) });
    if (!rr.ok) throw new Error(`POST ${p}: ${rr.status} ${await rr.text()}`);
    return rr.json();
  };

  await jpost('/auth/register', null, { username: owner, email: `${owner}@kith.local`, password });
  const loginRes = await fetch(`${API_BASE}/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: owner, password }) });
  if (!loginRes.ok) throw new Error(`login: ${loginRes.status}`);
  const ownerToken = (await loginRes.json()).token;

  const g = await jpost('/guilds', ownerToken, { name: `Gate1 ${rand}` });
  const c = await jpost(`/guilds/${g.id}/channels`, ownerToken, { name: 'gate1-lab', type: 0 });
  const m = await jpost(`/guilds/${g.id}/channels/${c.id}/messages`, ownerToken, { content: 'gate 1 probe target' });
  const ep = `/channels/${c.id}/messages/${m.id}/reactions/${encodeURIComponent(EMOJI)}/@me`;

  const lat = [];
  let bad = 0;
  let firstBad = null;
  for (let i = 0; i < N; i++) {
    const a = await timed('PUT', ep, ownerToken);
    if (a.status !== 204) { bad++; firstBad = firstBad || { op: 'PUT', status: a.status, i }; }
    else lat.push(a.ms);
    if (lat.length % 5 === 0) await new Promise((r) => setTimeout(r, GAP_MS));
    const d = await timed('DELETE', ep, ownerToken);
    if (d.status !== 204) { bad++; firstBad = firstBad || { op: 'DELETE', status: d.status, i }; }
    else lat.push(d.ms);
    if (lat.length % 5 === 0) await new Promise((r) => setTimeout(r, GAP_MS));
  }
  lat.sort((a, b) => a - b);
  const pct = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(lat.length * p))] : 0;
  const p50 = pct(0.5), p99 = pct(0.99), max = pct(1);
  const pass = bad === 0 && p99 < 15;
  console.log(JSON.stringify({ op: 'reaction-idle-latency', n: lat.length, bad, firstBad, p50Ms: +p50.toFixed(2), p99Ms: +p99.toFixed(2), maxMs: +max.toFixed(2), gateP99Lt15Ms: pass }, null, 2));
  process.exit(pass ? 0 : 2);
}

main().catch((e) => { console.error('FATAL', e); process.exit(1); });
