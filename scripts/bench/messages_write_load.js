import http from 'k6/http';
import { check } from 'k6';
import { Counter, Trend, Rate } from 'k6/metrics';
import encoding from 'k6/encoding';
import crypto from 'k6/crypto';

// Custom metrics
const writeLatency = new Trend('message_write_duration', true);
const writeErrors = new Rate('message_write_errors');
const writeSuccess = new Counter('message_write_success');
const rateLimitHits = new Counter('rate_limit_hits');

// Benchmark configuration parameters
const targetRate = parseInt(__ENV.TARGET_RATE || '1000', 10);
const rampUpDuration = __ENV.RAMP_UP || '10s';
const sustainDuration = __ENV.DURATION || '60s';
const apiBase = __ENV.API_BASE || 'http://127.0.0.1:8080';

// Default config fallback if bench_config.json is absent
let config = {
  guild_id: '99900000000000000',
  channel_ids: [],
  start_user_id: '99900000000000002',
  user_count: 1000,
  jwt_secret: 'dev-jwt-secret-change-me'
};

try {
  config = JSON.parse(open('./bench_config.json'));
} catch (e) {
  // If run from a different directory, synthesize default channel IDs
  for (let i = 1; i <= 50; i++) {
    config.channel_ids.push((99900000000000100 + i).toString());
  }
}

export const options = {
  scenarios: {
    message_writes: {
      executor: 'ramping-arrival-rate',
      startRate: Math.min(100, targetRate),
      timeUnit: '1s',
      preAllocatedVUs: Math.min(200, targetRate),
      maxVUs: Math.max(1000, targetRate * 2),
      stages: [
        { target: Math.floor(targetRate / 2), duration: rampUpDuration },
        { target: targetRate, duration: rampUpDuration },
        { target: targetRate, duration: sustainDuration },
        { target: 0, duration: '5s' }
      ]
    }
  },
  thresholds: {
    http_req_failed: ['rate<0.001'],       // Zero 5xx / client errors (< 0.1%)
    http_req_duration: ['p(99)<10'],       // Hard Gate: p99 write latency < 10ms
    message_write_errors: ['rate<0.001'],
    message_write_duration: ['p(99)<10']
  }
};

// Generate valid stateless HS256 JWT tokens for all virtual users
function generateTokens(cfg) {
  const tokens = [];
  const startId = BigInt(cfg.start_user_id);
  const now = Math.floor(Date.now() / 1000);
  const header = encoding.b64encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }), 'rawurl');

  for (let i = 0; i < cfg.user_count; i++) {
    const userId = (startId + BigInt(i)).toString();
    const payload = encoding.b64encode(JSON.stringify({
      sub: userId,
      iat: now,
      exp: now + 86400 * 7 // 7 days valid
    }), 'rawurl');

    const signature = crypto.hmac('sha256', cfg.jwt_secret, `${header}.${payload}`, 'base64rawurl');
    tokens.push({
      userId: userId,
      token: `${header}.${payload}.${signature}`
    });
  }
  return tokens;
}

export function setup() {
  console.log(`[k6 setup] Preparing benchmark against ${apiBase}...`);
  console.log(`[k6 setup] Target write rate: ${targetRate} msg/s sustained for ${sustainDuration}`);
  console.log(`[k6 setup] Benchmark Guild: ${config.guild_id}, Channels: ${config.channel_ids.length}, Users: ${config.user_count}`);

  const userTokens = generateTokens(config);
  console.log(`[k6 setup] Generated ${userTokens.length} HS256 JWT tokens.`);

  // Validate one write before starting full load
  const testUser = userTokens[0];
  const testChannel = config.channel_ids[0];
  const testRes = http.post(
    `${apiBase}/api/guilds/${config.guild_id}/channels/${testChannel}/messages`,
    JSON.stringify({ content: "k6 setup probe message" }),
    {
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${testUser.token}`
      }
    }
  );

  if (testRes.status !== 201) {
    throw new Error(`[k6 setup] Initial probe write failed! Status: ${testRes.status}, Body: ${testRes.body}`);
  }
  console.log(`[k6 setup] Probe message write succeeded (HTTP 201). Ready for load test!`);

  return {
    guildId: config.guild_id,
    channelIds: config.channel_ids,
    tokens: userTokens
  };
}

export default function (data) {
  // Rotate users across VUs and channels
  const userIdx = (__VU + __ITER) % data.tokens.length;
  const user = data.tokens[userIdx];
  const channelIdx = Math.floor(Math.random() * data.channelIds.length);
  const channelId = data.channelIds[channelIdx];

  const payload = JSON.stringify({
    content: `bench msg vu=${__VU} iter=${__ITER} ts=${Date.now()}`
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${user.token}`
    },
    tags: { name: 'POST_messages' }
  };

  const res = http.post(
    `${apiBase}/api/guilds/${data.guildId}/channels/${channelId}/messages`,
    payload,
    params
  );

  const duration = res.timings.duration;
  writeLatency.add(duration);

  const is201 = res.status === 201;
  writeSuccess.add(is201 ? 1 : 0);
  writeErrors.add(!is201);

  if (res.status === 429) {
    rateLimitHits.add(1);
  }

  check(res, {
    'status is 201': (r) => r.status === 201,
    'latency < 10ms': () => duration < 10
  });
}
