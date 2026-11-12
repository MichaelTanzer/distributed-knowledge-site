import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  FALLBACK_LANE_VALUES,
  LANE_VALUES,
  NOT_AVAILABLE_FOR_CASE,
  isPairUnavailable,
  laneChoices,
  laneModel,
  laneSelectable,
  offeredLaneValues,
  type ConfigLaneView
} from '../lib/v4Lanes';
import { LANES, isLane, parseSubmitBody } from '../lib/v4Staging';

const TODAY: ConfigLaneView[] = [
  { lane: 'openai', model: 'gpt-6-astra', unavailablePilots: [] },
  { lane: 'google', model: 'gemini-test-model', unavailablePilots: [] },
  { lane: 'xai', model: 'grok-4.7', unavailablePilots: [] }
];
const AFTER_DEPLOY: ConfigLaneView[] = [...TODAY, { lane: 'anthropic', model: 'claude-opus-5-5', unavailablePilots: ['SL-028'] }];

describe('four-lane catalogue and validation', () => {
  it('lists the four lanes in the static table, in display order', () => {
    assert.deepEqual(LANES.map((lane) => lane.value), [...LANE_VALUES]);
    assert.deepEqual([...LANE_VALUES], ['openai', 'google', 'xai', 'anthropic']);
  });

  it('labels Anthropic with its model, cap and typical runtime', () => {
    const anthropic = LANES.find((lane) => lane.value === 'anthropic');
    assert.deepEqual(anthropic, {
      value: 'anthropic',
      provider: 'Anthropic',
      model: 'claude-opus-5-5',
      capUsd: '12.00',
      typicalRuntime: '~25 min'
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
  it('offers the fallback three, never Anthropic, when the config is unavailable', () => {
    assert.deepEqual(offeredLaneValues(null), ['openai', 'google', 'xai']);
    assert.deepEqual([...FALLBACK_LANE_VALUES], ['openai', 'google', 'xai']);
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

  it('offers only the listed lanes, in the site order, whatever the backend order', () => {
    const listed: ConfigLaneView[] = [
      { lane: 'anthropic', model: null, unavailablePilots: [] },
      { lane: 'openai', model: null, unavailablePilots: [] }
    ];
    assert.deepEqual(offeredLaneValues(listed), ['openai', 'anthropic']);
    assert.equal(laneSelectable('google', '', listed), false);
  });

  it('offers nothing when the backend lists no lanes', () => {
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

  it('makes the pair unselectable, so a selected value is cleared and cannot be submitted', () => {
    assert.equal(laneSelectable('anthropic', 'SL-028', AFTER_DEPLOY), false);
    assert.equal(laneSelectable('anthropic', 'SL-035', AFTER_DEPLOY), true);
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
    assert.equal(laneChoices(LANES, AFTER_DEPLOY, '').some((choice) => choice.disabled), false);
  });

  it('renders three enabled choices and no Anthropic while the config is unavailable', () => {
    const choices = laneChoices(LANES, null, 'SL-028');
    assert.deepEqual(choices.map((choice) => choice.option.value), ['openai', 'google', 'xai']);
    assert.equal(choices.some((choice) => choice.disabled), false);
  });
});

describe('model names', () => {
  it("prefers the backend config's generator model and falls back to the static name", () => {
    const staticGoogle = LANES.find((lane) => lane.value === 'google')?.model ?? '';
    assert.notEqual(staticGoogle, '');
    assert.equal(laneModel(AFTER_DEPLOY, 'google', staticGoogle), 'gemini-test-model');
    assert.equal(laneModel(null, 'google', staticGoogle), staticGoogle);
    assert.equal(laneModel([{ lane: 'google', model: null, unavailablePilots: [] }], 'google', staticGoogle), staticGoogle);
    const google = laneChoices(LANES, AFTER_DEPLOY, '').find((choice) => choice.option.value === 'google');
    assert.equal(google?.model, 'gemini-test-model');
    const fallback = laneChoices(LANES, null, '').find((choice) => choice.option.value === 'google');
    assert.equal(fallback?.model, staticGoogle);
  });
});
