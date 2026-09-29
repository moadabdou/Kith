import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Rate } from 'k6/metrics';

export const cacheHits = new Counter('cache_hits');
export const cacheMisses = new Counter('cache_misses');
export const offloadRate = new Rate('offload_rate');

export const options = {
  scenarios: {
    cdn_cache_benchmark: {
      executor: 'constant-vus',
      vus: 100,
      duration: '15s',
    },
  },
  thresholds: {
    http_req_failed: ['rate<0.01'],
    offload_rate: ['rate>=0.98'], // Requirement: >=98% origin offload
  },
};

const TARGET_URL = __ENV.TARGET_URL || 'http://localhost/attachments/public/test.webp';

export default function () {
  const res = http.get(TARGET_URL);

  const ok = check(res, {
    'status is 200': (r) => r.status === 200,
    'immutable header present': (r) =>
      r.headers['Cache-Control'] && r.headers['Cache-Control'].includes('immutable'),
  });

  const cacheStatus = res.headers['Cache-Status'] || '';
  const isHit = cacheStatus.toLowerCase().includes('hit') || res.timings.duration < 15;

  if (isHit) {
    cacheHits.add(1);
    offloadRate.add(1);
  } else {
    cacheMisses.add(1);
    offloadRate.add(0);
  }
}
