import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/v4/requests/route';
import { PUBLIC_ERROR_COPY } from '../lib/v4Staging';
import {
  ANTHROPIC_NOT_OFFERED,
  FOUR_LANES,
  OPENAI_LISTED_TWICE,
  OPENAI_NOT_OFFERED,
  REQUEST_ID,
  THREE_LANES,
  backendConfig,
  enableV4,
  stubBackend
} from './helpers';

const cleanups: Array<() => void> = [];
function cleanup() {
  while (cleanups.length > 0) cleanups.pop()?.();
}
afterEach(cleanup);

function submitRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest('http://site.test/api/v4/requests', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: 'http://site.test',
      'sec-fetch-site': 'same-origin',
      'idempotency-key': randomUUID(),
      'x-forwarded-for': '203.0.113.7'
    },
    body: JSON.stringify(body)
  });
}

function setup(config: unknown, vercelEnv: 'production' | 'preview' = 'production', submit?: Parameters<typeof stubBackend>[1]) {
  cleanups.push(enableV4(vercelEnv));
  const backend = stubBackend(config, submit);
  cleanups.push(backend.restore);
  return backend;
}

const routeCalls = (calls: Array<{ method: string; path: string }>) => calls.map((call) => `${call.method} ${call.path}`);
const ONLY_CONFIG = ['GET /v1/config'];

async function expectRefused(config: unknown, body: Record<string, unknown>, status: number, code: string) {
  const backend = setup(config);
  const response = await POST(submitRequest(body));
  assert.equal(response.status, status);
  const answer = (await response.json()) as { code: string; message: string };
  assert.equal(answer.code, code);
  assert.equal(answer.message, PUBLIC_ERROR_COPY[code]);
  // The config read is the only backend call: POST /v1/requests is never called.
  assert.deepEqual(routeCalls(backend.calls), ONLY_CONFIG);
  cleanup();
}

describe('POST /api/v4/requests: unavailable pairs and the fourth lane', () => {
  it('refuses an unavailable lane/case pair with 400 lane_pilot_unavailable and never calls POST /v1/requests', async () => {
    await expectRefused(backendConfig(FOUR_LANES), { pilot: 'SL-028', lane: 'anthropic', recipient: 'reader@example.org' }, 400, 'lane_pilot_unavailable');
  });

  it('uses operator wording on Preview, still without calling POST /v1/requests', async () => {
    const backend = setup(backendConfig(FOUR_LANES), 'preview');
    const response = await POST(submitRequest({ pilot: 'SL-028', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, 'lane_pilot_unavailable');
    assert.deepEqual(routeCalls(backend.calls), ONLY_CONFIG);
  });

  it("accepts anthropic for an available case and acknowledges that entry's own cap", async () => {
    const lanes = [...FOUR_LANES.slice(0, 3), { ...FOUR_LANES[3], capUsd: '11.25' }];
    const backend = setup(backendConfig(lanes));
    const response = await POST(submitRequest({ pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { requestId: REQUEST_ID, state: 'queued', capUsd: null, dailyRemainingUsd: null, replay: false });
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config', 'POST /v1/requests']);
    assert.deepEqual(JSON.parse(backend.calls[1]?.body ?? ''), {
      pilot: 'SL-002',
      lane: 'anthropic',
      recipient: 'reader@example.org',
      ack_cap_usd: '11.25'
    });
  });

  it('keeps the other lanes available for the case that is unavailable on anthropic', async () => {
    const backend = setup(backendConfig(FOUR_LANES));
    const response = await POST(submitRequest({ pilot: 'SL-028', lane: 'openai', recipient: 'reader@example.org' }));
    assert.equal(response.status, 202);
    assert.equal(JSON.parse(backend.calls[1]?.body ?? '').ack_cap_usd, '15.00');
  });

  it("refuses anthropic with 400 lane_unavailable while the backend lists only today's three lanes", async () => {
    await expectRefused(backendConfig(THREE_LANES), { pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }, 400, 'lane_unavailable');
  });

  it("leaves today's three lanes unchanged against today's backend", async () => {
    // Today's backend still caps openai and google at 13.50: ack_cap_usd is that backend value, never the page's
    // expected 15.00 (lib/v4Staging.ts LANES).
    for (const [lane, cap] of [
      ['openai', '13.50'],
      ['google', '13.50'],
      ['xai', '8.75']
    ] as const) {
      const backend = setup(backendConfig(THREE_LANES));
      const response = await POST(submitRequest({ pilot: 'SL-028', lane, recipient: 'reader@example.org' }));
      assert.equal(response.status, 202, lane);
      assert.equal(JSON.parse(backend.calls[1]?.body ?? '').ack_cap_usd, cap, lane);
      cleanup();
    }
  });

  it('refuses an unknown lane before any backend call', async () => {
    const backend = setup(backendConfig(FOUR_LANES));
    const response = await POST(submitRequest({ pilot: 'SL-002', lane: 'meta', recipient: 'reader@example.org' }));
    assert.equal(response.status, 400);
    assert.equal(((await response.json()) as { code: string }).code, 'invalid_request');
    assert.deepEqual(backend.calls, []);
  });

  it("keeps the backend's own lane_pilot_unavailable refusal (config changed between the two calls) as a 400", async () => {
    setup(backendConfig(FOUR_LANES), 'production', () => ({ status: 400, json: { error: 'lane_pilot_unavailable' } }));
    const response = await POST(submitRequest({ pilot: 'SL-035', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'lane_pilot_unavailable', message: PUBLIC_ERROR_COPY.lane_pilot_unavailable });
  });
});

describe('POST /api/v4/requests: malformed or duplicated lane data fails closed (zero POST /v1/requests)', () => {
  for (const { name, lanes } of ANTHROPIC_NOT_OFFERED) {
    it(`anthropic refused with 400 lane_unavailable: ${name}`, async () => {
      for (const pilot of ['SL-002', 'SL-028']) {
        await expectRefused(backendConfig(lanes), { pilot, lane: 'anthropic', recipient: 'reader@example.org' }, 400, 'lane_unavailable');
      }
    });
  }

  for (const { name, lanes } of OPENAI_NOT_OFFERED) {
    it(`openai refused with 400 lane_unavailable: openai ${name}`, async () => {
      await expectRefused(backendConfig(lanes), { pilot: 'SL-002', lane: 'openai', recipient: 'reader@example.org' }, 400, 'lane_unavailable');
    });
  }

  it('without a lanes field, anthropic is refused (400) and a legacy lane keeps origin/main behaviour (503, no POST)', async () => {
    await expectRefused(backendConfig(undefined), { pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }, 400, 'lane_unavailable');
    await expectRefused(backendConfig(undefined), { pilot: 'SL-002', lane: 'openai', recipient: 'reader@example.org' }, 503, 'v4_unavailable');
  });

  it('with the keyed form, a legacy lane keeps origin/main behaviour: POST with its keyed cap', async () => {
    const backend = setup(backendConfig({ openai: '15.00', google: '15.00', xai: '8.75', anthropic: '12.00' }));
    const response = await POST(submitRequest({ pilot: 'SL-002', lane: 'openai', recipient: 'reader@example.org' }));
    assert.equal(response.status, 202);
    assert.equal(JSON.parse(backend.calls[1]?.body ?? '').ack_cap_usd, '15.00');
  });

  it("a legacy lane listed twice keeps origin/main's behaviour: dispatched with the last valid cap", async () => {
    const backend = setup(backendConfig(OPENAI_LISTED_TWICE));
    const response = await POST(submitRequest({ pilot: 'SL-028', lane: 'openai', recipient: 'reader@example.org' }));
    assert.equal(response.status, 202);
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config', 'POST /v1/requests']);
    assert.equal(JSON.parse(backend.calls[1]?.body ?? '').ack_cap_usd, '14.00');
  });
});
