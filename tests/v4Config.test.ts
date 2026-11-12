import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/v4/config/route';
import { normalizeConfig } from '../lib/v4Staging';
import { FOUR_LANES, THREE_LANES, backendConfig, enableV4, stubBackend } from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

describe('normalizeConfig lanes', () => {
  it("reads today's three lanes (no unavailablePilots) as offered for every case", () => {
    assert.deepEqual(normalizeConfig(backendConfig(THREE_LANES)).lanes, [
      { lane: 'openai', model: 'gpt-6-astra', unavailablePilots: [] },
      { lane: 'google', model: 'gemini-test-model', unavailablePilots: [] },
      { lane: 'xai', model: 'grok-4.7', unavailablePilots: [] }
    ]);
  });

  it('reads the fourth lane and its unavailable cases, and nothing else from the lane entries', () => {
    const view = normalizeConfig(backendConfig(FOUR_LANES));
    assert.deepEqual(view.lanes?.[3], { lane: 'anthropic', model: 'claude-opus-5-5', unavailablePilots: ['SL-028'] });
    for (const entry of view.lanes ?? []) assert.deepEqual(Object.keys(entry).sort(), ['lane', 'model', 'unavailablePilots']);
    assert.equal(view.laneCapsUsd.anthropic, '12.00');
  });

  it('is null when the backend sends no usable lanes field (the form then offers the fallback three)', () => {
    assert.equal(normalizeConfig(backendConfig(undefined)).lanes, null);
    assert.equal(normalizeConfig({ ...backendConfig(undefined), lanes: 'openai' }).lanes, null);
  });

  it('drops unknown lanes, unknown cases, duplicates and odd model ids', () => {
    const view = normalizeConfig(
      backendConfig([
        { lane: 'meta', generatorModel: 'x', unavailablePilots: [] },
        { lane: 'anthropic', generatorModel: 'bad model id <script>', unavailablePilots: ['SL-028', 'SL-999', 7, 'SL-028'] },
        { lane: 'anthropic', generatorModel: 'claude-opus-5-5', unavailablePilots: [] },
        { lane: 'xai', generator_model: 'grok-4.7', unavailable_pilots: 'SL-002' },
        'openai'
      ])
    );
    assert.deepEqual(view.lanes, [
      { lane: 'anthropic', model: null, unavailablePilots: ['SL-028'] },
      { lane: 'xai', model: 'grok-4.7', unavailablePilots: [] }
    ]);
  });

  it('also reads an object keyed by lane', () => {
    const view = normalizeConfig({ ...backendConfig(undefined), lanes: { openai: { capUsd: '13.50' }, anthropic: { unavailablePilots: ['SL-035'] } } });
    assert.deepEqual(view.lanes, [
      { lane: 'openai', model: null, unavailablePilots: [] },
      { lane: 'anthropic', model: null, unavailablePilots: ['SL-035'] }
    ]);
  });
});

describe('GET /api/v4/config passes through exactly what the form needs', () => {
  const VIEW_KEYS = [
    'backendSha',
    'dailyCapUsd',
    'dailyRemainingUsd',
    'dayUtc',
    'laneCapsUsd',
    'lanes',
    'reconciliationRequired',
    'recipient',
    'runInProgress',
    'spendState',
    'totalCapUsd',
    'totalRemainingUsd'
  ].sort();

  for (const vercelEnv of ['production', undefined] as const) {
    it(`public view (VERCEL_ENV=${vercelEnv ?? 'unset'}): lanes without money, reviewer or timeouts; no totals`, async () => {
      cleanups.push(enableV4(vercelEnv));
      const backend = stubBackend(backendConfig(FOUR_LANES));
      cleanups.push(backend.restore);
      const response = await GET(new NextRequest('http://site.test/api/v4/config'));
      assert.equal(response.status, 200);
      const text = await response.text();
      const body = JSON.parse(text) as Record<string, unknown>;
      assert.deepEqual(Object.keys(body).sort(), VIEW_KEYS);
      assert.deepEqual(body.lanes, [
        { lane: 'openai', model: 'gpt-6-astra', unavailablePilots: [] },
        { lane: 'google', model: 'gemini-test-model', unavailablePilots: [] },
        { lane: 'xai', model: 'grok-4.7', unavailablePilots: [] },
        { lane: 'anthropic', model: 'claude-opus-5-5', unavailablePilots: ['SL-028'] }
      ]);
      assert.deepEqual(body.laneCapsUsd, {});
      for (const key of ['dailyRemainingUsd', 'dailyCapUsd', 'totalRemainingUsd', 'totalCapUsd', 'dayUtc', 'recipient', 'backendSha']) {
        assert.equal(body[key], null, key);
      }
      for (const hidden of ['reviewer-model', 'timeoutSeconds', 'internal-host', 'spendEnforcement', 'Used', '13.50', '12.00', '8.75', '127.0.0.1']) {
        assert.equal(text.includes(hidden), false, hidden);
      }
      assert.deepEqual(backend.calls.map((call) => `${call.method} ${call.path}`), ['GET /v1/config']);
    });
  }

  it('operator view (Preview) adds the lane caps, still no reviewer, timeouts or internal note', async () => {
    cleanups.push(enableV4('preview'));
    const backend = stubBackend(backendConfig(FOUR_LANES));
    cleanups.push(backend.restore);
    const response = await GET(new NextRequest('http://site.test/api/v4/config'));
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    assert.deepEqual(Object.keys(body).sort(), VIEW_KEYS);
    assert.deepEqual(body.laneCapsUsd, { openai: '13.50', google: '13.50', xai: '8.75', anthropic: '12.00' });
    for (const hidden of ['reviewer-model', 'timeoutSeconds', 'internal-host', 'spendEnforcement']) {
      assert.equal(text.includes(hidden), false, hidden);
    }
  });

  it("today's backend (three lanes, no unavailablePilots) yields three offered lanes", async () => {
    cleanups.push(enableV4('production'));
    const backend = stubBackend(backendConfig(THREE_LANES));
    cleanups.push(backend.restore);
    const body = (await (await GET(new NextRequest('http://site.test/api/v4/config'))).json()) as { lanes: Array<{ lane: string }> };
    assert.deepEqual(body.lanes.map((entry) => entry.lane), ['openai', 'google', 'xai']);
  });
});
