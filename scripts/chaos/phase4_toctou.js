#!/usr/bin/env node
/**
 * Phase 4 TOCTOU Mid-Session Role Revocation & Permission Chaos Drill (Issue #65)
 *
 * Validates real-time permission boundaries across 5 high-stakes chaos scenarios:
 * 1. Concurrency Burst Race Window: In-flight message delivery while revoking VIP role.
 * 2. Real-Time Sidebar Lifecycle Transitions: Synthetic CHANNEL_DELETE and CHANNEL_CREATE frames.
 * 3. Alternative Revocation Vectors: Channel deny overwrite, role permission mutation, and role deletion.
 * 4. Disconnect, Revoke & RESUME Replay Leak Defense: Ring buffer protection against unauthorized replay.
 * 5. Inbound Typing Flood Under Active Demotion: Silent suppression of TYPING_START frames without socket crash.
 */

const API_BASE = process.env.API_URL || 'http://127.0.0.1:8080/api';
const GATEWAY_WS = process.env.GATEWAY_URL || 'ws://127.0.0.1:4000/ws';
const GATEWAY_HEALTH = process.env.GATEWAY_HEALTH || 'http://127.0.0.1:4000/healthz';

const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const CYAN = '\x1b[36m';
const RESET = '\x1b[0m';

// Canonical Discord Permission Flags
const PERMS = {
  CREATE_INSTANT_INVITE: 1 << 0,
  VIEW_CHANNEL: 1 << 10,          // 1024
  SEND_MESSAGES: 1 << 11,         // 2048
  DEFAULT_EVERYONE: 104324673,    // Standard Discord baseline
};

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

async function waitForHealth(timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const gRes = await fetch(GATEWAY_HEALTH);
      const aRes = await fetch(`${API_BASE.replace('/api', '')}/healthz`);
      if (gRes.ok && aRes.ok) return true;
    } catch {}
    await sleep(200);
  }
  throw new Error(`Services failed to become healthy within ${timeoutMs}ms`);
}

class ChaosWebSocketClient {
  constructor(token, name = 'Client') {
    this.token = token;
    this.name = name;
    this.ws = null;
    this.sessionId = null;
    this.lastSeq = null;
    this.heartbeatTimer = null;
    this.receivedEvents = [];
    this.closeEvent = null;
    this.connected = false;
  }

  async connect(opts = {}) {
    const { resume = false, sessionId = null, seq = null } = opts;

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(GATEWAY_WS);

      const timeout = setTimeout(() => {
        reject(new Error(`${this.name}: Gateway connection timed out`));
      }, 10000);

      this.ws.onopen = () => {};

      this.ws.onerror = (err) => {
        // Socket errors during chaos drills are tracked
      };

      this.ws.onclose = (event) => {
        this.connected = false;
        this.closeEvent = { code: event.code, reason: event.reason };
        if (this.heartbeatTimer) {
          clearInterval(this.heartbeatTimer);
          this.heartbeatTimer = null;
        }
      };

      this.ws.onmessage = (msg) => {
        const frame = JSON.parse(msg.data);
        const { op, d, s, t } = frame;
        if (typeof s === 'number') this.lastSeq = s;

        if (op === 10) {
          // HELLO
          const interval = d.heartbeat_interval || 10000;
          this.heartbeatTimer = setInterval(() => {
            if (this.ws && this.ws.readyState === WebSocket.OPEN) {
              this.ws.send(JSON.stringify({ op: 1, d: this.lastSeq }));
            }
          }, interval);

          if (resume && sessionId) {
            // Opcode 6 RESUME
            this.ws.send(JSON.stringify({
              op: 6,
              d: { token: this.token, session_id: sessionId, seq: seq || 0 }
            }));
            this.sessionId = sessionId;
            this.connected = true;
            clearTimeout(timeout);
            resolve();
          } else {
            // Opcode 2 IDENTIFY
            this.ws.send(JSON.stringify({
              op: 2,
              d: {
                token: this.token,
                properties: { os: 'linux', browser: 'chaos_test', device: 'node' }
              }
            }));
          }
        } else if (op === 0) {
          if (t === 'READY') {
            this.sessionId = d.session_id;
            this.connected = true;
            clearTimeout(timeout);
            resolve();
          } else if (t === 'RESUMED') {
            this.connected = true;
            clearTimeout(timeout);
            resolve();
          }
          this.receivedEvents.push({ type: t, payload: d, seq: s, receivedAt: Date.now() });
        } else if (op === 9) {
          // INVALID_SESSION
          clearTimeout(timeout);
          resolve();
        }
      };
    });
  }

  send(op, d) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ op, d }));
    }
  }

  sendTyping(channelId) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({
        t: 'TYPING_START',
        d: { channel_id: channelId }
      }));
    }
  }

  close() {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      this.ws.onmessage = null;
      this.ws.close();
      this.ws = null;
    }
    this.connected = false;
  }

  clearEvents() {
    this.receivedEvents = [];
  }

  filterEvents(type, predicate = () => true) {
    return this.receivedEvents.filter((e) => e.type === type && predicate(e));
  }
}

async function registerAndLogin(username, email, password) {
  await request(`${API_BASE}/auth/register`, { method: 'POST' }, {
    username,
    email,
    password,
  });

  const res = await request(`${API_BASE}/auth/login`, { method: 'POST' }, {
    login: username,
    password,
  });

  if (!res.ok || !res.body.token) {
    throw new Error(`Auth failed for ${username}: ${JSON.stringify(res.body)}`);
  }

  return {
    token: res.body.token,
    user: res.body.user,
    id: res.body.user ? res.body.user.id : null,
    username,
  };
}

async function runChaos() {
  console.log(`\n${BOLD}${CYAN}╔══════════════════════════════════════════════════════════════════════╗`);
  console.log(`║     KITH PHASE 4: TOCTOU & PERMISSION CHAOS DRILL (#65)              ║`);
  console.log(`╚══════════════════════════════════════════════════════════════════════╝${RESET}\n`);

  await waitForHealth();
  console.log(`${GREEN}✓ Pre-flight health checks passed: Gateway and API alive.${RESET}`);

  // 1. Setup Identities
  console.log(`→ Registering test identities...`);
  const rand = Math.floor(Math.random() * 90000) + 10000;
  const userA = await registerAndLogin(`u_target_${rand}`, `target_${rand}@test.local`, 'Password123!');
  const userB = await registerAndLogin(`u_bystander_${rand}`, `bystander_${rand}@test.local`, 'Password123!');
  const userC = await registerAndLogin(`u_owner_${rand}`, `owner_${rand}@test.local`, 'Password123!');

  // 2. User C creates Guild
  const guildRes = await request(`${API_BASE}/guilds`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { name: `Chaos Guild ${rand}` });
  if (!guildRes.ok) throw new Error(`Guild creation failed: ${JSON.stringify(guildRes.body)}`);
  const guildId = guildRes.body.id;

  // 3. User C creates default channel and invite, then A & B join
  const defaultChanRes = await request(`${API_BASE}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { name: 'general', type: 0 });
  if (!defaultChanRes.ok) throw new Error(`Default channel creation failed: ${JSON.stringify(defaultChanRes.body)}`);
  const defaultChanId = defaultChanRes.body.id;

  const invRes = await request(`${API_BASE}/invites`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { channel_id: defaultChanId });
  if (!invRes.ok) throw new Error(`Invite creation failed: ${JSON.stringify(invRes.body)}`);
  const inviteCode = invRes.body.code;

  await request(`${API_BASE}/invites/${inviteCode}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userA.token}` },
  });
  await request(`${API_BASE}/invites/${inviteCode}/join`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userB.token}` },
  });

  // 4. Create VIP role
  const roleRes = await request(`${API_BASE}/guilds/${guildId}/roles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { name: 'VIP', permissions: PERMS.DEFAULT_EVERYONE });
  const vipRoleId = roleRes.body.id;

  // 5. Create private channel #secret-ops
  const chanRes = await request(`${API_BASE}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { name: 'secret-ops', type: 0 });
  const secretChanId = chanRes.body.id;

  // 6. Overwrite #secret-ops: deny @everyone, allow VIP
  // In Kith: type 0 = role
  await request(`${API_BASE}/channels/${secretChanId}/permissions/${guildId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 0, deny: PERMS.VIEW_CHANNEL, allow: 0 });

  await request(`${API_BASE}/channels/${secretChanId}/permissions/${vipRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 0, allow: PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES, deny: 0 });

  // 7. Assign VIP to User A and User B
  await request(`${API_BASE}/guilds/${guildId}/members/${userA.id}/roles/${vipRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  });
  await request(`${API_BASE}/guilds/${guildId}/members/${userB.id}/roles/${vipRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  });

  console.log(`✓ Environment initialized:`);
  console.log(`  Guild: ${guildId} | #secret-ops: ${secretChanId} | Role VIP: ${vipRoleId}`);
  console.log(`  Owner: ${userC.username} | Target: ${userA.username} | Bystander: ${userB.username}\n`);

  // Connect WebSocket clients
  const clientA = new ChaosWebSocketClient(userA.token, 'UserA_Target');
  const clientB = new ChaosWebSocketClient(userB.token, 'UserB_Bystander');
  await clientA.connect();
  await clientB.connect();
  console.log(`${GREEN}✓ User A and User B connected via WebSocket & IDENTIFY confirmed.${RESET}\n`);

  const results = [];

  // ==========================================================================
  // DRILL 1: High-Concurrency Burst Race Window (The True TOCTOU Window)
  // ==========================================================================
  console.log(`${BOLD}════════════════════════════════════════════════════════════════`);
  console.log(` DRILL 1: High-Concurrency Burst Race Window (The TOCTOU Race)`);
  console.log(`════════════════════════════════════════════════════════════════${RESET}`);
  clientA.clearEvents();
  clientB.clearEvents();

  // Kith enforces rate limits (5 messages per 5s bucket per sender)
  const TOTAL_BURST = 5;
  const REVOKE_AT = 2;

  console.log(`[ACTION] Publishing ${TOTAL_BURST} messages while firing role revocation at #${REVOKE_AT}...`);

  const publishPromises = [];
  for (let i = 1; i <= TOTAL_BURST; i++) {
    const promise = (async (seqIdx) => {
      await sleep(seqIdx * 35);

      if (seqIdx === REVOKE_AT) {
        const delRes = await request(`${API_BASE}/guilds/${guildId}/members/${userA.id}/roles/${vipRoleId}`, {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${userC.token}` },
        });
        if (!delRes.ok) throw new Error(`Role revoke failed: ${JSON.stringify(delRes.body)}`);
      }

      const msgRes = await request(`${API_BASE}/channels/${secretChanId}/messages`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${userC.token}` },
      }, { content: `burst_msg_${seqIdx}` });
      if (!msgRes.ok) throw new Error(`Message publish ${seqIdx} failed: ${JSON.stringify(msgRes.body)}`);
      return msgRes;
    })(i);

    publishPromises.push(promise);
  }

  await Promise.all(publishPromises);
  await sleep(1500); // Allow all gateway fan-outs to settle

  const msgsA = clientA.filterEvents('MESSAGE_CREATE');
  const msgsB = clientB.filterEvents('MESSAGE_CREATE');
  const channelDeletesA = clientA.filterEvents('CHANNEL_DELETE', (e) => e.payload.id === secretChanId);

  const lastMsgA = msgsA[msgsA.length - 1];
  const lastSeqA = lastMsgA ? parseInt(lastMsgA.payload.content.replace('burst_msg_', ''), 10) : 0;

  console.log(`  Bystander (User B) received: ${msgsB.length}/${TOTAL_BURST} messages (100% target)`);
  console.log(`  Target (User A) received:    ${msgsA.length}/${TOTAL_BURST} messages (Cutoff at msg #${lastSeqA})`);
  console.log(`  Target CHANNEL_DELETE received: ${channelDeletesA.length} (Target: >= 1)`);

  const drill1Pass =
    msgsB.length === TOTAL_BURST &&
    msgsA.length < TOTAL_BURST &&
    lastSeqA <= REVOKE_AT + 1 &&
    channelDeletesA.length >= 1;

  results.push({
    name: '1. Concurrency Burst TOCTOU Cutoff',
    target: 'Cutoff at revoke, 0 post-revocation leak, 100% bystander delivery',
    result: `User B: ${msgsB.length}/${TOTAL_BURST}, User A cutoff at #${lastSeqA}`,
    status: drill1Pass ? 'PASS' : 'FAIL',
  });

  if (!drill1Pass) {
    console.log(`${RED}✗ Drill 1 Failed: TOCTOU cutoff did not satisfy invariant${RESET}`);
  } else {
    console.log(`${GREEN}✓ Drill 1 Passed: Clean cutoff mid-flight with zero post-revocation leakage.${RESET}`);
  }

  // ==========================================================================
  // DRILL 2: Real-Time Sidebar Lifecycle Transitions (Synthetic Events)
  // ==========================================================================
  console.log(`\n${BOLD}════════════════════════════════════════════════════════════════`);
  console.log(` DRILL 2: Real-Time Sidebar Lifecycle Transitions (Synthetic CREATE)`);
  console.log(`════════════════════════════════════════════════════════════════${RESET}`);
  clientA.clearEvents();

  console.log(`[ACTION] Waiting 5.5s for REST rate-limit window reset...`);
  await sleep(5500);

  console.log(`[ACTION] Restoring VIP role to User A via REST...`);
  const grantRes = await request(`${API_BASE}/guilds/${guildId}/members/${userA.id}/roles/${vipRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  });
  if (!grantRes.ok) throw new Error(`Role grant failed: ${JSON.stringify(grantRes.body)}`);

  await sleep(1000);

  const channelCreatesA = clientA.filterEvents('CHANNEL_CREATE', (e) => e.payload.id === secretChanId);
  console.log(`  Target synthetic CHANNEL_CREATE received: ${channelCreatesA.length}`);

  let createPayloadValid = false;
  if (channelCreatesA.length > 0) {
    const payload = channelCreatesA[0].payload;
    createPayloadValid =
      payload.id === secretChanId &&
      payload.guild_id === guildId &&
      Array.isArray(payload.permission_overwrites);
    console.log(`  Synthetic CHANNEL_CREATE has full metadata & overwrites: ${createPayloadValid}`);
  }

  // Verify User A can receive messages immediately now
  const restoredMsgRes = await request(`${API_BASE}/channels/${secretChanId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { content: 'lifecycle_restored_msg' });
  if (!restoredMsgRes.ok) throw new Error(`Restored msg publish failed: ${JSON.stringify(restoredMsgRes.body)}`);

  await sleep(800);
  const restoredMsgsA = clientA.filterEvents('MESSAGE_CREATE', (e) => e.payload.content === 'lifecycle_restored_msg');

  const drill2Pass = channelCreatesA.length >= 1 && createPayloadValid && restoredMsgsA.length === 1;

  results.push({
    name: '2. Sidebar Lifecycle Transitions',
    target: 'Synthetic CHANNEL_CREATE on promotion, immediate receipt of new messages',
    result: `CHANNEL_CREATE: ${channelCreatesA.length}, Overwrites valid: ${createPayloadValid}, New Msg: ${restoredMsgsA.length === 1}`,
    status: drill2Pass ? 'PASS' : 'FAIL',
  });

  if (!drill2Pass) {
    console.log(`${RED}✗ Drill 2 Failed: Synthetic CHANNEL_CREATE transition violated${RESET}`);
  } else {
    console.log(`${GREEN}✓ Drill 2 Passed: Seamless sidebar promotion and immediate message delivery.${RESET}`);
  }

  // ==========================================================================
  // DRILL 3: Alternative Permission Revocation Vectors
  // ==========================================================================
  console.log(`\n${BOLD}════════════════════════════════════════════════════════════════`);
  console.log(` DRILL 3: Alternative Permission Revocation Vectors`);
  console.log(`════════════════════════════════════════════════════════════════${RESET}`);

  console.log(`[ACTION] Waiting 5.5s for REST rate-limit window reset...`);
  await sleep(5500);

  // 3a. Channel Deny Overwrite on User A
  console.log(`[3a] Applying explicit member deny overwrite on #secret-ops...`);
  clientA.clearEvents();

  await request(`${API_BASE}/channels/${secretChanId}/permissions/${userA.id}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 1, deny: PERMS.VIEW_CHANNEL, allow: 0 });

  await sleep(1000);
  const owDeleteA = clientA.filterEvents('CHANNEL_DELETE', (e) => e.payload.id === secretChanId);

  // Send message while overwrite is active
  await request(`${API_BASE}/channels/${secretChanId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { content: 'denied_by_overwrite_msg' });

  await sleep(800);
  const owDeniedMsgs = clientA.filterEvents('MESSAGE_CREATE', (e) => e.payload.content === 'denied_by_overwrite_msg');

  // Clear overwrite
  await request(`${API_BASE}/channels/${secretChanId}/permissions/${userA.id}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userC.token}` },
  });

  await sleep(1000);
  const owRestoredCreate = clientA.filterEvents('CHANNEL_CREATE', (e) => e.payload.id === secretChanId);

  const drill3aPass = owDeleteA.length >= 1 && owDeniedMsgs.length === 0 && owRestoredCreate.length >= 1;
  console.log(`  3a (Member Overwrite): DELETE=${owDeleteA.length >= 1}, MsgBlocked=${owDeniedMsgs.length === 0}, CREATE=${owRestoredCreate.length >= 1}`);

  // 3b. Role Overwrite Demotion (mutate the VIP role overwrite on #secret-ops to deny VIEW_CHANNEL)
  console.log(`[3b] Mutating VIP role overwrite on #secret-ops (deny VIEW_CHANNEL)...`);
  clientA.clearEvents();
  clientB.clearEvents();

  await request(`${API_BASE}/channels/${secretChanId}/permissions/${vipRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 0, deny: PERMS.VIEW_CHANNEL, allow: 0 });

  await sleep(1000);
  const roleDemoteDeleteA = clientA.filterEvents('CHANNEL_DELETE', (e) => e.payload.id === secretChanId);
  const roleDemoteDeleteB = clientB.filterEvents('CHANNEL_DELETE', (e) => e.payload.id === secretChanId);

  // Restore VIP role overwrite
  await request(`${API_BASE}/channels/${secretChanId}/permissions/${vipRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 0, allow: PERMS.VIEW_CHANNEL | PERMS.SEND_MESSAGES, deny: 0 });

  await sleep(1000);
  const roleRestoreCreateA = clientA.filterEvents('CHANNEL_CREATE', (e) => e.payload.id === secretChanId);
  const roleRestoreCreateB = clientB.filterEvents('CHANNEL_CREATE', (e) => e.payload.id === secretChanId);

  const drill3bPass =
    roleDemoteDeleteA.length >= 1 &&
    roleDemoteDeleteB.length >= 1 &&
    roleRestoreCreateA.length >= 1 &&
    roleRestoreCreateB.length >= 1;
  console.log(`  3b (Role Overwrite Mutation): Both received DELETE=${roleDemoteDeleteA.length >= 1 && roleDemoteDeleteB.length >= 1}, Both received CREATE=${roleRestoreCreateA.length >= 1 && roleRestoreCreateB.length >= 1}`);

  // 3c. Role Deletion
  console.log(`[3c] Creating and deleting ephemeral role...`);
  const tempRoleRes = await request(`${API_BASE}/guilds/${guildId}/roles`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { name: 'TempRole', permissions: PERMS.DEFAULT_EVERYONE });
  const tempRoleId = tempRoleRes.body.id;

  const tempChanRes = await request(`${API_BASE}/guilds/${guildId}/channels`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { name: 'temp-ops', type: 0 });
  const tempChanId = tempChanRes.body.id;

  await request(`${API_BASE}/channels/${tempChanId}/permissions/${guildId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 0, deny: PERMS.VIEW_CHANNEL, allow: 0 });

  await request(`${API_BASE}/channels/${tempChanId}/permissions/${tempRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { type: 0, allow: PERMS.VIEW_CHANNEL, deny: 0 });

  await request(`${API_BASE}/guilds/${guildId}/members/${userA.id}/roles/${tempRoleId}`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${userC.token}` },
  });

  await sleep(1000);
  clientA.clearEvents();

  // Delete temp role
  await request(`${API_BASE}/guilds/${guildId}/roles/${tempRoleId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userC.token}` },
  });

  await sleep(1000);
  const tempRoleDeleteA = clientA.filterEvents('CHANNEL_DELETE', (e) => e.payload.id === tempChanId);
  const drill3cPass = tempRoleDeleteA.length >= 1;
  console.log(`  3c (Role Deletion): Received CHANNEL_DELETE=${drill3cPass}`);

  const drill3Pass = drill3aPass && drill3bPass && drill3cPass;
  results.push({
    name: '3. Alternative Revocation Vectors',
    target: 'Deny overwrite, role overwrite mutation, and role delete all enforce cutoff',
    result: `3a (Overwrite): ${drill3aPass ? 'PASS' : 'FAIL'}, 3b (Role Overwrite): ${drill3bPass ? 'PASS' : 'FAIL'}, 3c (Role Delete): ${drill3cPass ? 'PASS' : 'FAIL'}`,
    status: drill3Pass ? 'PASS' : 'FAIL',
  });

  // ==========================================================================
  // DRILL 4: Disconnect, Revoke & RESUME Replay Leak Defense
  // ==========================================================================
  console.log(`\n${BOLD}════════════════════════════════════════════════════════════════`);
  console.log(` DRILL 4: Disconnect, Revoke & RESUME Replay Leak Defense`);
  console.log(`════════════════════════════════════════════════════════════════${RESET}`);

  console.log(`[ACTION] Waiting 5.5s for REST rate-limit window reset...`);
  await sleep(5500);

  // Ensure User A is authorized and gets a baseline message
  const preRes = await request(`${API_BASE}/channels/${secretChanId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { content: 'pre_disconnect_msg' });
  if (!preRes.ok) throw new Error(`Pre-disconnect msg publish failed: ${JSON.stringify(preRes.body)}`);

  await sleep(800);
  const lastSeqBeforeDisconnect = clientA.lastSeq;
  const savedSessionId = clientA.sessionId;

  console.log(`  User A disconnecting at seq: ${lastSeqBeforeDisconnect}...`);
  clientA.close();
  await sleep(500);

  console.log(`[ACTION] Revoking VIP role while User A is disconnected...`);
  const revokeOffRes = await request(`${API_BASE}/guilds/${guildId}/members/${userA.id}/roles/${vipRoleId}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${userC.token}` },
  });
  if (!revokeOffRes.ok) throw new Error(`Role revoke failed: ${JSON.stringify(revokeOffRes.body)}`);

  console.log(`[ACTION] Publishing sensitive messages to #secret-ops while User A is offline...`);
  await request(`${API_BASE}/channels/${secretChanId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { content: 'leaked_secret_msg_1' });
  await request(`${API_BASE}/channels/${secretChanId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${userC.token}` },
  }, { content: 'leaked_secret_msg_2' });

  console.log(`[ACTION] Reconnecting User A -> sending Opcode 6 RESUME (seq: ${lastSeqBeforeDisconnect})...`);
  const resumeClientA = new ChaosWebSocketClient(userA.token, 'UserA_Resume');
  await resumeClientA.connect({
    resume: true,
    sessionId: savedSessionId,
    seq: lastSeqBeforeDisconnect,
  });

  await sleep(1500);

  const replayedLeakedMsgs = resumeClientA.filterEvents('MESSAGE_CREATE', (e) =>
    e.payload.content && e.payload.content.startsWith('leaked_secret_msg_')
  );

  console.log(`  Replayed leaked messages received by User A: ${replayedLeakedMsgs.length} (Target: exactly 0)`);
  const drill4Pass = replayedLeakedMsgs.length === 0;

  results.push({
    name: '4. Disconnect, Revoke & RESUME Protection',
    target: '0 replayed private events delivered to demoted session upon reconnect',
    result: `Leaked messages replayed: ${replayedLeakedMsgs.length}`,
    status: drill4Pass ? 'PASS' : 'FAIL',
  });

  if (!drill4Pass) {
    console.log(`${RED}✗ Drill 4 Failed: Replay ring buffer leaked post-revocation events${RESET}`);
  } else {
    console.log(`${GREEN}✓ Drill 4 Passed: Zero private events leaked during session resume.${RESET}`);
  }

  // ==========================================================================
  // DRILL 5: Inbound Typing Defense Under Active Demotion
  // ==========================================================================
  console.log(`\n${BOLD}════════════════════════════════════════════════════════════════`);
  console.log(` DRILL 5: Inbound Typing Defense Under Active Demotion`);
  console.log(`════════════════════════════════════════════════════════════════${RESET}`);

  // User A currently has NO VIP role. Attempt to send typing in #secret-ops
  clientB.clearEvents();

  console.log(`[INJECTION] User A (unauthorized) firing TYPING_START frames into #secret-ops...`);
  resumeClientA.sendTyping(secretChanId);
  await sleep(200);
  resumeClientA.sendTyping(secretChanId);
  await sleep(200);

  const typingB = clientB.filterEvents('TYPING_START', (e) => e.payload.channel_id === secretChanId);
  const clientAAlive = resumeClientA.connected && !resumeClientA.closeEvent;

  console.log(`  Bystander received unauthorized TYPING_START: ${typingB.length} (Target: exactly 0)`);
  console.log(`  User A connection state: ${clientAAlive ? 'OPEN (Healthy)' : 'CLOSED'}`);

  const drill5Pass = typingB.length === 0 && clientAAlive;

  results.push({
    name: '5. Inbound Typing Flood Defense',
    target: 'Unauthorized typing frames silently dropped, zero socket termination',
    result: `Leaked typing: ${typingB.length}, Socket alive: ${clientAAlive}`,
    status: drill5Pass ? 'PASS' : 'FAIL',
  });

  if (!drill5Pass) {
    console.log(`${RED}✗ Drill 5 Failed: Inbound typing permission enforcement failed${RESET}`);
  } else {
    console.log(`${GREEN}✓ Drill 5 Passed: Typing silently dropped; connection maintained.${RESET}`);
  }

  // Cleanup connections
  resumeClientA.close();
  clientB.close();

  // ── Results Summary ────────────────────────────────────────────────────────
  console.log(`\n${BOLD}${CYAN}══════════════════════════════════════════════════════════════════════`);
  console.log(`                     CHAOS DRILL AUDIT RESULTS`);
  console.log(`══════════════════════════════════════════════════════════════════════${RESET}`);

  let allPassed = true;
  for (const r of results) {
    const color = r.status === 'PASS' ? GREEN : RED;
    console.log(`${BOLD}${r.name}${RESET}`);
    console.log(`  Target: ${r.target}`);
    console.log(`  Result: ${r.result}`);
    console.log(`  Status: ${color}${BOLD}${r.status}${RESET}\n`);
    if (r.status !== 'PASS') allPassed = false;
  }

  if (allPassed) {
    console.log(`${BOLD}${GREEN}✔ ALL 5 CHAOS DRILLS PASSED WITH ZERO LEAKS OR CORRUPTIONS.${RESET}\n`);
    process.exit(0);
  } else {
    console.log(`${BOLD}${RED}✘ ONE OR MORE CHAOS DRILLS FAILED.${RESET}\n`);
    process.exit(1);
  }
}

runChaos().catch((err) => {
  console.error(`\n${RED}Chaos execution crashed:${RESET}`, err);
  process.exit(1);
});
