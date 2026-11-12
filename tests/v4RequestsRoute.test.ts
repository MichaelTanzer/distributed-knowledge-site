import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { POST } from '../app/api/v4/requests/route';
import { PUBLIC_ERROR_COPY } from '../lib/v4Staging';
import { FOUR_LANES, REQUEST_ID, THREE_LANES, backendConfig, enableV4, stubBackend } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

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

describe('POST /api/v4/requests: unavailable pairs and the fourth lane', () => {
  it('refuses an unavailable lane/case pair with 400 lane_pilot_unavailable and never calls POST /v1/requests', async () => {
    const backend = setup(backendConfig(FOUR_LANES));
    const response = await POST(submitRequest({ pilot: 'SL-028', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'lane_pilot_unavailable', message: PUBLIC_ERROR_COPY.lane_pilot_unavailable });
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config']);
  });

  it('uses operator wording on Preview, still without calling POST /v1/requests', async () => {
    const backend = setup(backendConfig(FOUR_LANES), 'preview');
    const response = await POST(submitRequest({ pilot: 'SL-028', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 400);
    const body = (await response.json()) as { code: string; message: string };
    assert.equal(body.code, 'lane_pilot_unavailable');
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config']);
  });

  it('accepts anthropic for an available case and sends the backend cap 12.00 as the acknowledgement', async () => {
    const backend = setup(backendConfig(FOUR_LANES));
    const response = await POST(submitRequest({ pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 202);
    assert.deepEqual(await response.json(), { requestId: REQUEST_ID, state: 'queued', capUsd: null, dailyRemainingUsd: null, replay: false });
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config', 'POST /v1/requests']);
    assert.deepEqual(JSON.parse(backend.calls[1]?.body ?? ''), {
      pilot: 'SL-002',
      lane: 'anthropic',
      recipient: 'reader@example.org',
      ack_cap_usd: '12.00'
    });
  });

  it('keeps the other lanes available for the case that is unavailable on anthropic', async () => {
    const backend = setup(backendConfig(FOUR_LANES));
    const response = await POST(submitRequest({ pilot: 'SL-028', lane: 'openai', recipient: 'reader@example.org' }));
    assert.equal(response.status, 202);
    assert.equal(JSON.parse(backend.calls[1]?.body ?? '').ack_cap_usd, '13.50');
  });

  it("refuses anthropic with 400 lane_unavailable while the backend lists only today's three lanes", async () => {
    const backend = setup(backendConfig(THREE_LANES));
    const response = await POST(submitRequest({ pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { code: 'lane_unavailable', message: PUBLIC_ERROR_COPY.lane_unavailable });
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config']);
  });

  it("leaves today's three lanes unchanged against today's backend", async () => {
    for (const [lane, cap] of [
      ['openai', '13.50'],
      ['google', '13.50'],
      ['xai', '8.75']
    ] as const) {
      const backend = setup(backendConfig(THREE_LANES));
      const response = await POST(submitRequest({ pilot: 'SL-028', lane, recipient: 'reader@example.org' }));
      assert.equal(response.status, 202, lane);
      assert.equal(JSON.parse(backend.calls[1]?.body ?? '').ack_cap_usd, cap, lane);
      cleanups.splice(0).reverse().forEach((cleanup) => cleanup());
    }
  });

  it('with no lanes field in the config, keeps the old behaviour: no cap, 503 v4_unavailable, no POST', async () => {
    const backend = setup(backendConfig(undefined));
    const response = await POST(submitRequest({ pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.equal(response.status, 503);
    assert.equal(((await response.json()) as { code: string }).code, 'v4_unavailable');
    assert.deepEqual(routeCalls(backend.calls), ['GET /v1/config']);
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
