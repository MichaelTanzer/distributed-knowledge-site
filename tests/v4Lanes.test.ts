import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  LANE_VALUES,
  LEGACY_LANE_VALUES,
  NOT_AVAILABLE_FOR_CASE,
  effectiveLane,
  isPairUnavailable,
  laneChoices,
  laneModel,
  laneSelectable,
  offeredLaneValues,
  plausibleModel,
  sanitizeLaneViews,
  type ConfigLaneView
} from '../lib/v4Lanes';
import { LANES, isLane, parseSubmitBody } from '../lib/v4Staging';

const TODAY: ConfigLaneView[] = [
  { lane: 'openai', model: 'gpt-6-astra', unavailablePilots: [] },
  { lane: 'google', model: 'gemini-test-model', unavailablePilots: [] },
  { lane: 'xai', model: 'grok-4.7', unavailablePilots: [] }
];
const AFTER_DEPLOY: ConfigLaneView[] = [...TODAY, { lane: 'anthropic', model: 'claude-opus-5-5', unavailablePilots: ['SL-028'] }];
const staticModel = (lane: string) => LANES.find((option) => option.value === lane)?.model ?? '';

describe('four-lane catalogue and validation', () => {
  it('lists the four lanes in the static table, in display order', () => {
    assert.deepEqual(LANES.map((lane) => lane.value), [...LANE_VALUES]);
    assert.deepEqual([...LANE_VALUES], ['openai', 'google', 'xai', 'anthropic']);
    assert.deepEqual([...LEGACY_LANE_VALUES], ['openai', 'google', 'xai']);
  });

  it('labels Anthropic with its model, cap and typical runtime', () => {
    assert.deepEqual(LANES.find((lane) => lane.value === 'anthropic'), {
      value: 'anthropic',
      provider: 'Anthropic',
      model: 'claude-opus-5-5',
      pastModel: 'claude-opus-5-5',
      capUsd: '12.00',
      typicalRuntime: '~25 min'
    });
  });

  it('offers gemini-4-carbon as the Google fallback, while earlier requests keep origin/main labels', () => {
    assert.equal(LANES.find((lane) => lane.value === 'google')?.model, 'gemini-4-carbon');
    assert.deepEqual(Object.fromEntries(LANES.map((lane) => [lane.value, lane.pastModel])), {
      openai: 'gpt-6-astra',
      google: 'gemini-4-argon',
      xai: 'grok-4.7',
      anthropic: 'claude-opus-5-5'
    });
  });

  it('accepts exactly the four lanes', () => {
    for (const lane of LANE_VALUES) assert.equal(isLane(lane), true, lane);
    for (const lane of ['', 'Anthropic', 'claude', 'meta', 'openai ', null, 4]) assert.equal(isLane(lane), false, String(lane));
  });

  it('accepts an anthropic request body and refuses an unknown lane', () => {
    const ok = parseSubmitBody(JSON.stringify({ pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' }));
    assert.deepEqual(ok, { ok: true, body: { pilot: 'SL-002', lane: 'anthropic', recipient: 'reader@example.org' } });
    const bad = parseSubmitBody(JSON.stringify({ pilot: 'SL-002', lane: 'meta', recipient: 'reader@example.org' }));
    assert.deepEqual(bad, { ok: false, reason: 'shape' });
  });
});

describe('lane filtering: only what the backend offers', () => {
  it('offers the legacy three, never Anthropic, when there is no per-lane data', () => {
    assert.deepEqual(offeredLaneValues(null), ['openai', 'google', 'xai']);
    assert.equal(laneSelectable('anthropic', 'SL-002', null), false);
    assert.equal(laneSelectable('openai', 'SL-028', null), true);
  });

  it("offers today's three lanes when the backend lists three", () => {
    assert.deepEqual(offeredLaneValues(TODAY), ['openai', 'google', 'xai']);
    assert.equal(laneSelectable('anthropic', 'SL-002', TODAY), false);
  });

  it('offers Anthropic once the backend lists it', () => {
    assert.deepEqual(offeredLaneValues(AFTER_DEPLOY), ['openai', 'google', 'xai', 'anthropic']);
    assert.equal(laneSelectable('anthropic', 'SL-002', AFTER_DEPLOY), true);
  });

  it('offers only the listed lanes, in the site order, and nothing for an empty list', () => {
    const listed: ConfigLaneView[] = [
      { lane: 'anthropic', model: 'claude-opus-5-5', unavailablePilots: [] },
      { lane: 'openai', model: null, unavailablePilots: [] }
    ];
    assert.deepEqual(offeredLaneValues(listed), ['openai', 'anthropic']);
    assert.equal(laneSelectable('google', '', listed), false);
    assert.deepEqual(offeredLaneValues([]), []);
  });
});

describe('unavailable lane/case pairs', () => {
  it('marks only the listed pair unavailable', () => {
    assert.equal(isPairUnavailable(AFTER_DEPLOY, 'anthropic', 'SL-028'), true);
    assert.equal(isPairUnavailable(AFTER_DEPLOY, 'anthropic', 'SL-002'), false);
    assert.equal(isPairUnavailable(AFTER_DEPLOY, 'anthropic', 'SL-035'), false);
    assert.equal(isPairUnavailable(AFTER_DEPLOY, 'openai', 'SL-028'), false);
    assert.equal(isPairUnavailable(AFTER_DEPLOY, 'anthropic', ''), false);
    assert.equal(isPairUnavailable(null, 'anthropic', 'SL-028'), false);
  });

  it('clears a selection that becomes unavailable or is no longer offered, and keeps a selectable one', () => {
    assert.equal(effectiveLane('anthropic', 'SL-028', AFTER_DEPLOY), '');
    assert.equal(effectiveLane('anthropic', 'SL-035', AFTER_DEPLOY), 'anthropic');
    assert.equal(effectiveLane('anthropic', 'SL-002', TODAY), '');
    assert.equal(effectiveLane('anthropic', 'SL-002', null), '');
    assert.equal(effectiveLane('openai', 'SL-028', AFTER_DEPLOY), 'openai');
    assert.equal(effectiveLane('', 'SL-028', AFTER_DEPLOY), '');
  });

  it('renders the pair as a disabled choice; other choices stay enabled', () => {
    const choices = laneChoices(LANES, AFTER_DEPLOY, 'SL-028');
    assert.deepEqual(
      choices.map((choice) => [choice.option.value, choice.disabled]),
      [
        ['openai', false],
        ['google', false],
        ['xai', false],
        ['anthropic', true]
      ]
    );
    assert.equal(NOT_AVAILABLE_FOR_CASE, 'Not available for this case');
    assert.equal(laneChoices(LANES, AFTER_DEPLOY, 'SL-002').some((choice) => choice.disabled), false);
  });
});

describe('browser-side validation of the lanes view (fails closed, same rules as the server)', () => {
  it('passes a valid view unchanged and keeps null as "no per-lane data"', () => {
    assert.deepEqual(sanitizeLaneViews(AFTER_DEPLOY), AFTER_DEPLOY);
    assert.equal(sanitizeLaneViews(null), null);
    assert.equal(sanitizeLaneViews(undefined), null);
  });

  it('offers nothing when the view is present but not an array', () => {
    for (const value of ['openai', 4, { openai: {} }, true]) assert.deepEqual(sanitizeLaneViews(value), [], JSON.stringify(value));
  });

  const anthropic = AFTER_DEPLOY[3] as ConfigLaneView;
  const cases: Array<[string, unknown]> = [
    ['unknown case id', { ...anthropic, unavailablePilots: ['SL-028', 'SL-999'] }],
    ['unavailablePilots not an array', { ...anthropic, unavailablePilots: 'SL-028' }],
    ['unavailablePilots missing', { lane: 'anthropic', model: 'claude-opus-5-5' }],
    ['null model on a non-legacy lane', { ...anthropic, model: null }],
    ['model of another family', { ...anthropic, model: 'gpt-6-astra' }],
    ['model not a plain id', { ...anthropic, model: 'claude <b>' }]
  ];
  for (const [name, entry] of cases) {
    it(`drops anthropic for: ${name}`, () => {
      assert.deepEqual(sanitizeLaneViews([...TODAY, entry]), TODAY);
    });
  }

  it('drops a lane listed twice, and unknown lanes', () => {
    assert.deepEqual(sanitizeLaneViews([...AFTER_DEPLOY, { ...anthropic, unavailablePilots: [] }]), TODAY);
    assert.deepEqual(sanitizeLaneViews([...TODAY, { lane: 'meta', model: null, unavailablePilots: [] }]), TODAY);
  });

  it('keeps a legacy lane with a null model (static name shown)', () => {
    assert.deepEqual(sanitizeLaneViews([{ lane: 'openai', model: null, unavailablePilots: [] }]), [
      { lane: 'openai', model: null, unavailablePilots: [] }
    ]);
  });
});

describe('model names', () => {
  it('accepts a model only from its lane family', () => {
    assert.equal(plausibleModel('openai', 'gpt-6-astra'), 'gpt-6-astra');
    assert.equal(plausibleModel('google', 'gemini-test-model'), 'gemini-test-model');
    assert.equal(plausibleModel('xai', 'grok-4.7'), 'grok-4.7');
    assert.equal(plausibleModel('anthropic', 'claude-opus-5-5'), 'claude-opus-5-5');
    assert.equal(plausibleModel('openai', 'claude-opus-5-5'), null);
    assert.equal(plausibleModel('anthropic', 'gpt-6-astra'), null);
    assert.equal(plausibleModel('google', 'gemini-'.padEnd(70, 'x')), null);
    assert.equal(plausibleModel('xai', 'grok 4'), null);
    assert.equal(plausibleModel('xai', 7), null);
  });

  it("prefers the backend config's plausible model and falls back to the static name", () => {
    assert.equal(laneModel(AFTER_DEPLOY, 'google', staticModel('google')), 'gemini-test-model');
    assert.equal(laneModel(null, 'google', staticModel('google')), staticModel('google'));
    assert.equal(laneModel([{ lane: 'google', model: null, unavailablePilots: [] }], 'google', staticModel('google')), staticModel('google'));
    const wrongFamily: ConfigLaneView[] = [{ lane: 'openai', model: 'claude-opus-5-5', unavailablePilots: [] }];
    assert.equal(laneModel(wrongFamily, 'openai', staticModel('openai')), staticModel('openai'));
    const google = laneChoices(LANES, AFTER_DEPLOY, '').find((choice) => choice.option.value === 'google');
    assert.equal(google?.model, 'gemini-test-model');
  });
});
