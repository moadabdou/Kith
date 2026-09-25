#!/usr/bin/env node
/**
 * WS driver calibrator, Step 1b (Issue #88).
 *
 * Measures the DRIVER's own ceiling against a black-hole WS server
 * (accepts + holds sockets, never speaks): ramp idle clients in batches,
 * record driver heap/FD/event-loop lag per rung. Every later WS number is
 * valid only below the rung where the DRIVER bends — a knee found here is
 * a void run, not a result.
 *
 * Usage: node ws_calibrate.js [--port 9876] [--max 20000] [--batch 500]
 *   [--hold 5000] [--out results.json]
 *
 * Env may override flags: WS_CAL_PORT, WS_CAL_MAX, WS_CAL_BATCH,
 * WS_CAL_HOLD_MS, WS_CAL_OUT.
 */
const { WebSocketServer, WebSocket } = require('/tmp/ws-calib/node_modules/ws');

const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, cur, i, arr) => {
    if (cur.startsWith('--')) {
      const k = cur.slice(2);
      acc.push([k, arr[i + 1] && !arr[i + 1].startsWith('--') ? arr[i + 1] : '1']);
    }
    return acc;
  }, [])
);

const PORT = parseInt(process.env.WS_CAL_PORT || args.port || '9876', 10);
const MAX = parseInt(process.env.WS_CAL_MAX || args.max || '20000', 10);
const BATCH = parseInt(process.env.WS_CAL_BATCH || args.batch || '500', 10);
const HOLD_MS = parseInt(process.env.WS_CAL_HOLD_MS || args.hold || '5000', 10);
const OUT = process.env.WS_CAL_OUT || args.out || '';

const wss = new WebSocketServer({ port: PORT });
wss.on('connection', (ws) => {
  ws.on('error', () => {});
  // Black hole: hold, never speak. Count only.
});
wss.on('listening', () => console.error(`[calib] black-hole listening on :${PORT}`));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

function fds() {
  try {
    const fs = require('fs');
    return fs.readdirSync('/proc/self/fd').length;
  } catch {
    return -1;
  }
}

async function connectOne(url, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url);
    const t = setTimeout(() => {
      try { ws.terminate(); } catch {}
      reject(new Error('connect timeout'));
    }, timeoutMs);
    ws.on('open', () => {
      clearTimeout(t);
      ws.on('error', () => {});
      resolve(ws);
    });
    ws.on('error', (e) => {
      clearTimeout(t);
      reject(e);
    });
  });
}

async function main() {
  await new Promise((r) => wss.on('listening', r));
  const url = `ws://127.0.0.1:${PORT}`;
  const sockets = [];
  const rungs = [];
  let connected = 0;
  let failed = 0;

  for (let target = BATCH; target <= MAX; target += BATCH) {
    const memBefore = process.memoryUsage();
    const lagBefore = await eventLoopLagMs(10);
    const t0 = Date.now();
    let batchFail = 0;

    const attempts = [];
    for (let i = 0; i < BATCH; i++) {
      attempts.push(
        connectOne(url).then(
          (ws) => { sockets.push(ws); connected++; },
          () => { batchFail++; failed++; }
        )
      );
    }
    await Promise.all(attempts);
    const batchMs = Date.now() - t0;

    const memAfter = process.memoryUsage();
    const lagAfter = await eventLoopLagMs(10);

    const rung = {
      target,
      connected,
      failed,
      batch_fail: batchFail,
      batch_ms: batchMs,
      driver_heap_mb: +(memAfter.heapUsed / 1048576).toFixed(1),
      driver_heap_delta_mb: +((memAfter.heapUsed - memBefore.heapUsed) / 1048576).toFixed(1),
      driver_rss_mb: +(memAfter.rss / 1048576).toFixed(1),
      driver_fds: fds(),
      evloop_lag_ms_before: +lagBefore.toFixed(2),
      evloop_lag_ms_after: +lagAfter.toFixed(2),
    };
    rungs.push(rung);
    console.log(JSON.stringify(rung));

    // Driver bend criteria: batch failures, lag blowup, or heap runaway.
    // Stop AT the bend (record it) rather than past it.
    if (batchFail > 0 || lagAfter > 50 || memAfter.heapUsed > 2 * 1024 * 1024 * 1024) {
      console.error(`[calib] DRIVER BEND at target=${target} (batchFail=${batchFail} lag=${lagAfter.toFixed(1)}ms heap=${(memAfter.heapUsed / 1048576).toFixed(0)}MB)`);
      break;
    }
    await sleep(500);
  }

  console.error(`[calib] holding ${sockets.length} sockets for ${HOLD_MS}ms...`);
  await sleep(HOLD_MS);

  const summary = {
    tool: 'ws_calibrate',
    node: process.version,
    port: PORT,
    batch: BATCH,
    rungs,
    final_connected: connected,
    final_failed: failed,
    final_heap_mb: +(process.memoryUsage().heapUsed / 1048576).toFixed(1),
    final_fds: fds(),
  };
  if (OUT) {
    require('fs').writeFileSync(OUT, JSON.stringify(summary, null, 2));
    console.error(`[calib] wrote ${OUT}`);
  } else {
    console.log(JSON.stringify(summary));
  }

  for (const ws of sockets) {
    try { ws.terminate(); } catch {}
  }
  wss.close();
  process.exit(0);
}

main().catch((e) => {
  console.error(`[calib] FATAL: ${e.message}`);
  process.exit(1);
});
