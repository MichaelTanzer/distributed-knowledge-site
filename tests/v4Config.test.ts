import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { NextRequest } from 'next/server';
import { GET } from '../app/api/v4/config/route';
import { normalizeConfig } from '../lib/v4Staging';
import {
  ANTHROPIC_NOT_OFFERED,
  FOUR_LANES,
  OPENAI_LISTED_TWICE,
  OPENAI_NOT_OFFERED,
  THREE_LANES,
  backendConfig,
  enableV4,
  stubBackend
} from './helpers';

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const offered = (lanes: unknown) => normalizeConfig(backendConfig(lanes)).lanes?.map((entry) => entry.lane) ?? null;

describe('normalizeConfig lanes (fail closed)', () => {
  it("reads today's three lanes (no unavailablePilots) as offered for every case, each with its own cap", () => {
    const view = normalizeConfig(backendConfig(THREE_LANES));
    assert.deepEqual(view.lanes, [
      { lane: 'openai', model: 'gpt-6-astra', unavailablePilots: [] },
      { lane: 'google', model: 'gemini-test-model', unavailablePilots: [] },
      { lane: 'xai', model: 'grok-4.7', unavailablePilots: [] }
    ]);
    assert.deepEqual(view.laneCapsUsd, { openai: '13.50', google: '13.50', xai: '8.75' });
  });

  it('reads the fourth lane, its unavailable cases and its cap, and nothing else from the lane entries', () => {
    const view = normalizeConfig(backendConfig(FOUR_LANES));
    assert.deepEqual(view.lanes?.[3], { lane: 'anthropic', model: 'claude-opus-5-5', unavailablePilots: ['SL-028'] });
    for (const entry of view.lanes ?? []) assert.deepEqual(Object.keys(entry).sort(), ['lane', 'model', 'unavailablePilots']);
    assert.equal(view.laneCapsUsd.anthropic, '12.00');
  });

  for (const { name, lanes } of ANTHROPIC_NOT_OFFERED) {
    it(`anthropic not offered and no anthropic cap: ${name}`, () => {
      const view = normalizeConfig(backendConfig(lanes));
      assert.equal(view.lanes?.some((entry) => entry.lane === 'anthropic') ?? false, false);
      assert.equal(view.laneCapsUsd.anthropic, undefined);
      // The legacy three stay offered (as listed entries, or as the no-per-lane-data fallback for the keyed form).
      assert.ok(view.lanes === null || ['openai', 'google', 'xai'].every((lane) => view.lanes?.some((entry) => entry.lane === lane)));
    });
  }

  it('the keyed form offers nothing new: lanes null, legacy caps read as origin/main read them', () => {
    const view = normalizeConfig(backendConfig({ openai: '15.00', google: { capUsd: 15 }, xai: '8.75', anthropic: '12.00' }));
    assert.equal(view.lanes, null);
    assert.deepEqual(view.laneCapsUsd, { openai: '15.00', google: '15.00', xai: '8.75' });
  });

  for (const { name, lanes } of OPENAI_NOT_OFFERED) {
    it(`a malformed legacy entry is not offered and gives no cap: openai ${name}`, () => {
      const view = normalizeConfig(backendConfig(lanes));
      assert.deepEqual(view.lanes?.map((entry) => entry.lane), ['google', 'xai', 'anthropic']);
      assert.equal(view.laneCapsUsd.openai, undefined);
    });
  }

  it("a legacy lane listed twice keeps origin/main's behaviour: offered, unrestricted, static model, last valid cap", () => {
    const view = normalizeConfig(backendConfig(OPENAI_LISTED_TWICE));
    assert.deepEqual(view.lanes?.[0], { lane: 'openai', model: null, unavailablePilots: [] });
    assert.equal(view.laneCapsUsd.openai, '14.00');
  });

  it('shows a legacy model only if it belongs to the lane family (else the static name)', () => {
    const lanes = [{ ...FOUR_LANES[0], generatorModel: 'claude-opus-5-5' }, ...FOUR_LANES.slice(1)];
    const view = normalizeConfig(backendConfig(lanes));
    assert.deepEqual(view.lanes?.[0], { lane: 'openai', model: null, unavailablePilots: [] });
    assert.equal(view.laneCapsUsd.openai, '15.00');
  });

  it('ignores unknown lanes and non-object entries; empty or unknown-only lists offer nothing', () => {
    assert.deepEqual(offered([...FOUR_LANES, { lane: 'meta', generatorModel: 'x', capUsd: '1.00' }, 'openai', 7]), [
      'openai',
      'google',
      'xai',
      'anthropic'
    ]);
    assert.deepEqual(offered([]), []);
    assert.deepEqual(offered([{ lane: 'meta', capUsd: '1.00' }]), []);
  });

  it('gives no per-lane data (null) when lanes is missing or scalar', () => {
    assert.equal(offered(undefined), null);
    assert.equal(offered('openai'), null);
    assert.deepEqual(normalizeConfig(backendConfig('openai')).laneCapsUsd, {});
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
      for (const hidden of ['reviewer-model', 'timeoutSeconds', 'internal-host', 'spendEnforcement', 'Used', '15.00', '12.00', '8.75', '127.0.0.1']) {
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
    assert.deepEqual(body.laneCapsUsd, { openai: '15.00', google: '15.00', xai: '8.75', anthropic: '12.00' });
    for (const hidden of ['reviewer-model', 'timeoutSeconds', 'internal-host', 'spendEnforcement']) {
      assert.equal(text.includes(hidden), false, hidden);
    }
  });

  it('never passes a model of another family through', async () => {
    cleanups.push(enableV4('production'));
    const backend = stubBackend(backendConfig([{ ...FOUR_LANES[0], generatorModel: 'claude-opus-5-5' }, ...FOUR_LANES.slice(1)]));
    cleanups.push(backend.restore);
    const body = (await (await GET(new NextRequest('http://site.test/api/v4/config'))).json()) as { lanes: Array<{ lane: string; model: string | null }> };
    assert.deepEqual(body.lanes[0], { lane: 'openai', model: null, unavailablePilots: [] });
  });
});
