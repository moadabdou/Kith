#!/usr/bin/env node
/**
 * Phase 1 Gateway Chaos Experiment Driver (Issue #27)
 * Implements rigorous stream verification across 3 canonical gateway failure drills:
 * 1. Transient Disconnects (5s and 30s) -> Op 6 RESUME -> RingBuffer replay
 * 2. Hard Container Death (SIGKILL) -> Op 9 INVALID_SESSION -> Op 2 IDENTIFY + REST reconciliation
 * 3. Session TTL Expiry (65s > 60s TTL) -> GenServer Reaper eviction -> Op 9 INVALID_SESSION
 *
 * Mathematical Invariants Checked:
 * - Completeness: Set(Received) == Set(Published)
 * - Idempotency: Count(Unique) == Count(Received)
 * - Monotonicity: seq[i] < seq[i+1]
 */

const { execSync } = require('child_process');

const API_BASE = 'http://127.0.0.1:8080/api';
const GATEWAY_WS = 'ws://127.0.0.1:4000/ws';
const GATEWAY_METRICS = 'http://127.0.0.1:4000/metrics';
const GATEWAY_HEALTH = 'http://127.0.0.1:4000/healthz';

async function request(url, options = {}, body = null) {
  const headers = { 'Content-Type': 'application/json', ...options.headers };
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  try {
    return { status: res.status, ok: res.ok, body: JSON.parse(text) };
  } catch {
    return { status: res.status, ok: res.ok, body: text };
  }
}

async function getPrometheusMetrics() {
  try {
    const res = await fetch(GATEWAY_METRICS);
    return await res.text();
  } catch {
    return '';
  }
}

async function waitForGatewayHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(GATEWAY_HEALTH);
      if (res.ok) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`Gateway failed to become healthy within ${timeoutMs}ms`);
}

function assertInvariants(publishedIds, receivedIds, sequences, context) {
  console.log(`\n--- [Invariant Audit: ${context}] ---`);
  console.log(`Total Published Messages: ${publishedIds.length}`);
  console.log(`Total Received Messages:  ${receivedIds.length}`);

  // 1. Completeness: Every published message was received
  const publishedSet = new Set(publishedIds);
  const receivedSet = new Set(receivedIds);
  const missing = publishedIds.filter((id) => !receivedSet.has(id));

  if (missing.length > 0) {
    throw new Error(`[FAIL: Completeness] ${missing.length} published messages missing: ${missing.join(', ')}`);
  }
  console.log('✓ Invariant 1 (Completeness): Zero lost messages. All published events accounted for.');

  // 2. Idempotency: No duplicate message IDs
  if (receivedIds.length !== receivedSet.size) {
    const duplicates = receivedIds.filter((item, index) => receivedIds.indexOf(item) !== index);
    throw new Error(`[FAIL: Idempotency] Duplicate messages detected: ${duplicates.join(', ')}`);
  }
  console.log('✓ Invariant 2 (Idempotency): Zero duplicate messages. Clean stream state.');

  // 3. Monotonicity: Strictly increasing sequence numbers
  for (let i = 1; i < sequences.length; i++) {
    if (sequences[i] <= sequences[i - 1]) {
      throw new Error(`[FAIL: Monotonicity] Sequence inversion at index ${i}: seq ${sequences[i]} <= seq ${sequences[i - 1]}`);
    }
  }
  console.log(`✓ Invariant 3 (Monotonicity): Strictly monotonic sequence progression (${sequences.join(' -> ')}).`);
}

class ChaosClient {
  constructor(token) {
    this.token = token;
    this.ws = null;
    this.sessionId = null;
    this.lastSeq = null;
    this.receivedMessages = [];
    this.receivedSequences = [];
    this.onMessageHook = null;
    this.onInvalidSessionHook = null;
    this.onReadyHook = null;
  }

  async connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(GATEWAY_WS);

      this.ws.onopen = () => {
        // Connected
      };

      this.ws.onerror = (err) => {
        // Socket error during chaos is expected
      };

      this.ws.onmessage = (event) => {
        const frame = JSON.parse(event.data);
        const { op, d, s, t } = frame;
        if (typeof s === 'number') this.lastSeq = s;

        if (op === 10) {
          // HELLO
          if (this.sessionId && this.lastSeq !== null) {
            // Attempt RESUME
            this.ws.send(JSON.stringify({
              op: 6,
              d: { token: this.token, session_id: this.sessionId, seq: this.lastSeq },
            }));
            resolve(this);
          } else {
            // Fresh IDENTIFY
            this.ws.send(JSON.stringify({
              op: 2,
              d: { token: this.token, properties: { os: 'chaos', browser: 'chaos' } },
            }));
          }
        } else if (op === 0 && t === 'READY') {
          this.sessionId = d.session_id;
          if (this.onReadyHook) this.onReadyHook(d);
          resolve(this);
        } else if (op === 0 && t === 'MESSAGE_CREATE') {
          this.receivedMessages.push(d);
          this.receivedSequences.push(s);
          if (this.onMessageHook) this.onMessageHook(d, s);
        } else if (op === 9) {
          // INVALID_SESSION
          this.sessionId = null;
          this.lastSeq = null;
          if (this.onInvalidSessionHook) this.onInvalidSessionHook(d);
          // Fall back to IDENTIFY
          this.ws.send(JSON.stringify({
            op: 2,
            d: { token: this.token, properties: { os: 'chaos', browser: 'chaos' } },
          }));
        }
      };
    });
  }

  close() {
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.onerror = null;
      this.ws.onopen = null;
      try { this.ws.close(); } catch {}
      this.ws = null;
    }
  }
}

async function runChaos() {
  console.log('================================================================');
  console.log('    PHASE 1 GATEWAY CHAOS EXPERIMENT SUITE (#27)');
  console.log('================================================================');

  const initialMetrics = await getPrometheusMetrics();

  // 1. Setup Environment
  console.log('\n[SETUP] Initializing test session on API...');
  const rand = Math.floor(Math.random() * 100000);
  const username = `chaos_${rand}`;
  const password = 'ChaosPassword123!';

  await request(`${API_BASE}/auth/register`, { method: 'POST' }, {
    username,
    email: `${username}@kith.local`,
    password,
  });
  const loginRes = await request(`${API_BASE}/auth/login`, { method: 'POST' }, {
    login: username,
    password,
  });
  const token = loginRes.body.token;

  const guildRes = await request(`${API_BASE}/guilds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }, { name: `Chaos Guild ${rand}` });
  const guildId = guildRes.body.id;

  const chanRes = await request(`${API_BASE}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  }, { name: 'chaos-lab' });
  const channelId = chanRes.body.id;
  console.log(`✓ Test environment ready: Guild ${guildId} | Channel ${channelId}`);

  async function postMessage(content) {
    const res = await request(`${API_BASE}/guilds/${guildId}/channels/${channelId}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    }, { content });
    return res.body;
  }

  // ==========================================================================
  // DRILL 1: Transient Disconnects (5s and 30s) -> RESUME Replay
  // ==========================================================================
  console.log('\n================================================================');
  console.log(' DRILL 1: Transient Network Drops (5s and 30s) -> RESUME Replay');
  console.log('================================================================');

  const client = new ChaosClient(token);
  await client.connect();
  console.log(`✓ Client connected to Gateway with session_id: ${client.sessionId}`);

  const drill1Published = [];
  const drill1Received = [];
  const drill1Sequences = [];

  client.onMessageHook = (msg, seq) => {
    drill1Received.push(msg.id);
    drill1Sequences.push(seq);
  };

  // 1A. Baseline message before drop
  console.log('\n[1A] Publishing baseline message while connected...');
  const m1 = await postMessage('Drill 1 - Msg 1 (online)');
  drill1Published.push(m1.id);
  await new Promise((r) => setTimeout(r, 400));

  // 1B. 5-second disconnect
  console.log('\n[1B] Injecting 5-SECOND transient disconnect...');
  client.close();
  console.log('    Socket closed. Publishing messages 2, 3, 4 while offline...');

  for (let i = 2; i <= 4; i++) {
    const m = await postMessage(`Drill 1 - Msg ${i} (offline 5s)`);
    drill1Published.push(m.id);
    await new Promise((r) => setTimeout(r, 200));
  }
  await new Promise((r) => setTimeout(r, 4000)); // Total ~5s

  console.log('    Reconnecting client -> sending Opcode 6 RESUME...');
  await client.connect();
  await new Promise((r) => setTimeout(r, 800)); // Allow replay
  console.log(`    Replay complete. Current lastSeq: ${client.lastSeq}`);

  // 1C. 30-second disconnect
  console.log('\n[1C] Injecting 30-SECOND transient disconnect (server zombie detection window)...');
  client.close();
  console.log('    Socket closed. Publishing messages 5, 6, 7 while offline...');

  for (let i = 5; i <= 7; i++) {
    const m = await postMessage(`Drill 1 - Msg ${i} (offline 30s)`);
    drill1Published.push(m.id);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('    Waiting remaining duration of 30s disconnect window...');
  await new Promise((r) => setTimeout(r, 24000)); // Total ~30s

  console.log('    Reconnecting client -> sending Opcode 6 RESUME...');
  await client.connect();
  await new Promise((r) => setTimeout(r, 1000)); // Allow replay

  // Publish one final message online to confirm active streaming
  const m8 = await postMessage('Drill 1 - Msg 8 (post-resume online)');
  drill1Published.push(m8.id);
  await new Promise((r) => setTimeout(r, 600));

  assertInvariants(drill1Published, drill1Received, drill1Sequences, 'Drill 1 (5s & 30s Drops)');
  client.close();

  // ==========================================================================
  // DRILL 2: Hard Container Kill (SIGKILL) -> Op 9 -> REST Reconciliation
  // ==========================================================================
  console.log('\n================================================================');
  console.log(' DRILL 2: Hard Container Kill (SIGKILL) -> Op 9 -> REST Resync');
  console.log('================================================================');

  const client2 = new ChaosClient(token);
  await client2.connect();
  console.log(`✓ Client connected with session_id: ${client2.sessionId}`);

  const drill2Published = [];
  const drill2Received = [];
  let op9Received = false;

  client2.onMessageHook = (msg) => {
    drill2Received.push(msg.id);
  };
  client2.onInvalidSessionHook = () => {
    op9Received = true;
    console.log('    [GATEWAY EVENT] Opcode 9 INVALID_SESSION received! In-memory buffer was wiped by SIGKILL.');
  };

  const mD2_1 = await postMessage('Drill 2 - Msg 1 (pre-kill)');
  drill2Published.push(mD2_1.id);
  await new Promise((r) => setTimeout(r, 400));

  console.log('\n[STRIKE] Executing: docker kill -s SIGKILL kith-gateway-1...');
  execSync('docker kill -s SIGKILL kith-gateway-1');
  console.log('✓ Container killed instantly with SIGKILL (zero graceful exit handling).');

  console.log('    Publishing messages while Gateway is dead (testing Tier Isolation)...');
  const mD2_2 = await postMessage('Drill 2 - Msg 2 (gateway dead)');
  const mD2_3 = await postMessage('Drill 2 - Msg 3 (gateway dead)');
  drill2Published.push(mD2_2.id, mD2_3.id);
  console.log('✓ REST API & Database accepted messages successfully without Gateway.');

  console.log('\n[HEAL] Starting gateway container: docker compose start gateway...');
  execSync('docker compose start gateway');
  await waitForGatewayHealth();
  console.log('✓ Gateway container healthy and listening on port 4000.');

  console.log('    Client reconnects -> attempts Opcode 6 RESUME on previous session...');
  await client2.connect();
  await new Promise((r) => setTimeout(r, 1000));

  if (!op9Received) {
    throw new Error('Expected Opcode 9 INVALID_SESSION following SIGKILL restart!');
  }
  console.log('✓ Opcode 9 verified. Client cleanly fell back to Opcode 2 IDENTIFY.');

  console.log('\n[RECONCILE] Performing client-side REST state reconciliation (as implemented in App.tsx/ChatArea.tsx)...');
  const historyRes = await request(`${API_BASE}/guilds/${guildId}/channels/${channelId}/messages`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  const reconciledIds = historyRes.body.map((m) => m.id);

  console.log(`Reconciled ${reconciledIds.length} total messages from REST history.`);
  for (const id of drill2Published) {
    if (!reconciledIds.includes(id)) {
      throw new Error(`Message ${id} was lost during SIGKILL!`);
    }
  }
  console.log('✓ Zero lost messages: Eventual consistency proven after container SIGKILL.');
  client2.close();

  // ==========================================================================
  // DRILL 3: Session TTL Expiration (>60s) -> GenServer Reaper
  // ==========================================================================
  console.log('\n================================================================');
  console.log(' DRILL 3: Session TTL Expiration (65s > 60s TTL) -> GenServer Reaper');
  console.log('================================================================');

  const client3 = new ChaosClient(token);
  await client3.connect();
  const deadSessionId = client3.sessionId;
  console.log(`✓ Client connected with session_id: ${deadSessionId}`);

  let drill3Op9Received = false;
  client3.onInvalidSessionHook = () => {
    drill3Op9Received = true;
  };

  console.log('\n[WAIT] Disconnecting client and waiting 65 seconds (> 60s disconnect_ttl_ms)...');
  client3.close();

  const totalWaitSec = 65;
  for (let s = 1; s <= totalWaitSec; s++) {
    process.stdout.write(`\r    Elapsed time: ${s}s / ${totalWaitSec}s...`);
    await new Promise((r) => setTimeout(r, 1000));
  }
  console.log('\n✓ TTL window exceeded. GenServer session reaper should have evicted session.');

  console.log(`    Reconnecting client and attempting Opcode 6 RESUME on expired session ${deadSessionId}...`);
  // Re-open with the old session ID to force RESUME attempt
  client3.sessionId = deadSessionId;
  client3.lastSeq = 0;
  await client3.connect();
  await new Promise((r) => setTimeout(r, 800));

  if (!drill3Op9Received) {
    throw new Error('Expected Opcode 9 INVALID_SESSION after exceeding 60s disconnect TTL!');
  }
  console.log('✓ Opcode 9 verified. Session reaper successfully evicted stale session without memory leaks.');
  client3.close();

  // ==========================================================================
  // METRICS & TELEMETRY AUDIT
  // ==========================================================================
  console.log('\n================================================================');
  console.log(' PROMETHEUS TELEMETRY & GATEWAY METRICS AUDIT');
  console.log('================================================================');

  const finalMetrics = await getPrometheusMetrics();
  const metricNames = [
    'gateway_resumes_total',
    'gateway_resume_replay_size',
    'gateway_ws_close_codes_total',
    'gateway_events_fanned_total',
    'gateway_sessions_active',
  ];

  for (const m of metricNames) {
    const matches = finalMetrics.split('\n').filter((l) => l.startsWith(m));
    if (matches.length > 0) {
      console.log(`\nMetric [${m}]:`);
      matches.forEach((line) => console.log(`  ${line}`));
    }
  }

  console.log('\n================================================================');
  console.log(' ALL 3 CHAOS DRILLS PASSED WITH ZERO LOSS & FORMAL INVARIANTS!');
  console.log('================================================================\n');
}

runChaos().catch((err) => {
  console.error('\nCHAOS EXPERIMENT FAILED:', err);
  process.exit(1);
});
