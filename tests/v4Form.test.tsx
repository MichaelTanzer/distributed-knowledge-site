import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { renderToStaticMarkup } from 'react-dom/server';
import V4StagingForm from '../app/v4-staging/V4StagingForm';
import { LaneRadios, ProviderSelect, canSubmitForm, requestProviderLabel, type SubmitGate } from '../app/v4-staging/formParts';
import { effectiveLane, laneChoices, sanitizeLaneViews, type ConfigLaneView, type LaneValue, type PilotValue } from '../lib/v4Lanes';
import {
  LANES,
  PUBLIC_ERROR_COPY,
  RECIPIENT_PATTERN,
  REQUEST_ID_PATTERN,
  configForAudience,
  normalizeConfig,
  pilotsWithDescriptions
} from '../lib/v4Staging';
import { ANTHROPIC_NOT_OFFERED, FOUR_LANES, OPENAI_LISTED_TWICE, THREE_LANES, backendConfig } from './helpers';

const PUBLIC_LANES = LANES.map((lane) => ({ ...lane, capUsd: '' }));

/** First render (before the config answer): the config is unavailable, so the fallback rules apply. */
function renderForm(variant: 'public' | 'operator'): string {
  return renderToStaticMarkup(
    <V4StagingForm
      errorCopy={variant === 'public' ? { ...PUBLIC_ERROR_COPY } : undefined}
      lanes={variant === 'public' ? PUBLIC_LANES : LANES.map((lane) => ({ ...lane }))}
      pilots={pilotsWithDescriptions()}
      recipientPattern={RECIPIENT_PATTERN.source}
      requestIdPattern={REQUEST_ID_PATTERN.source}
      variant={variant}
    />
  );
}

/**
 * The lanes the loaded form works with for a backend `lanes` field: exactly the browser's path (server
 * normalisation, public audience view, JSON transport, browser validation).
 */
function loadedLanes(lanes: unknown): ConfigLaneView[] | null {
  const view = JSON.parse(JSON.stringify(configForAudience(normalizeConfig(backendConfig(lanes))))) as { lanes: unknown };
  return sanitizeLaneViews(view.lanes);
}

/** The public provider select as the loaded form renders it, with `selected` the lane held in state. */
function renderSelect(lanes: unknown, pilot: PilotValue | '', selected: LaneValue | ''): string {
  const configLanes = loadedLanes(lanes);
  return renderToStaticMarkup(
    <ProviderSelect
      choices={laneChoices(PUBLIC_LANES, configLanes, pilot)}
      disabled={false}
      onSelect={() => undefined}
      value={effectiveLane(selected, pilot, configLanes)}
    />
  );
}

function renderRadios(lanes: unknown, pilot: PilotValue | '', selected: LaneValue | ''): string {
  const configLanes = loadedLanes(lanes);
  return renderToStaticMarkup(
    <LaneRadios
      caps={{}}
      choices={laneChoices(LANES, configLanes, pilot)}
      disabled={false}
      onSelect={() => undefined}
      value={effectiveLane(selected, pilot, configLanes)}
    />
  );
}

interface RenderedOption {
  value: string;
  text: string;
  disabled: boolean;
  selected: boolean;
}

function options(html: string): RenderedOption[] {
  return [...html.matchAll(/<option([^>]*)>([^<]*)<\/option>/g)].map((match) => ({
    value: /value="([^"]*)"/.exec(match[1] ?? '')?.[1] ?? '',
    text: match[2] ?? '',
    disabled: /\sdisabled=""/.test(match[1] ?? ''),
    selected: /\sselected=""/.test(match[1] ?? '')
  }));
}

function radios(html: string): Array<{ value: string; disabled: boolean; checked: boolean; label: string }> {
  return [...html.matchAll(/<label class="v4s-lane"[^>]*>([\s\S]*?)<\/label>/g)].map((match) => {
    const input = /<input([^>]*)\/?>/.exec(match[1] ?? '')?.[1] ?? '';
    return {
      value: /value="([^"]*)"/.exec(input)?.[1] ?? '',
      disabled: /\sdisabled=""/.test(input),
      checked: /\schecked=""/.test(input),
      label: (match[1] ?? '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
    };
  });
}

function gate(lanes: unknown, pilot: PilotValue | '', selected: LaneValue | ''): SubmitGate {
  const configLanes = loadedLanes(lanes);
  return {
    configReady: true,
    paused: false,
    reconciliation: false,
    backendBusy: false,
    pilot,
    lane: effectiveLane(selected, pilot, configLanes),
    configLanes,
    recipientValid: true,
    publicVariant: true,
    effectiveCap: null,
    acknowledged: false,
    submitting: false,
    storageOk: true,
    locksOk: true,
    blockingRecords: false,
    activeId: null
  };
}

describe('v4 form, first render (config not loaded yet)', () => {
  it("public: offers today's three providers and not Anthropic", () => {
    const rendered = options(/<select[^>]*id="v4s-lane"[^>]*>[\s\S]*?<\/select>/.exec(renderForm('public'))?.[0] ?? '');
    assert.deepEqual(rendered.map((option) => option.value), ['', 'openai', 'google', 'xai']);
    assert.equal(rendered.some((option) => option.disabled), false);
    // Without a config the static fallback names are offered.
    assert.equal(rendered.find((option) => option.value === 'google')?.text, 'Google · gemini-4-carbon (about 20–25 min)');
  });

  it('operator: shows the three lane radios and not Anthropic', () => {
    assert.deepEqual(radios(renderForm('operator')).map((radio) => radio.value), ['openai', 'google', 'xai']);
  });

  for (const variant of ['public', 'operator'] as const) {
    it(`${variant}: the KIQ select is described by the case description region`, () => {
      const html = renderForm(variant);
      const kiq = /<select[^>]*id="v4s-pilot"[^>]*>[\s\S]*?<\/select>/.exec(html)?.[0] ?? '';
      assert.match(kiq, /aria-describedby="v4s-pilot-description"/);
      assert.deepEqual(options(kiq).map((option) => option.value), ['', 'SL-002', 'SL-028', 'SL-035']);
      const region = /<div[^>]*id="v4s-pilot-description"[^>]*>([\s\S]*?)<\/div>/.exec(html);
      assert.ok(region, 'description region rendered');
      assert.match(region[0], /aria-live="polite"/);
      // No case selected yet: the region is empty, and it sits outside the <label> so it never joins the select's name.
      assert.equal(region[1], '');
      const label = /<label[^>]*for="v4s-pilot"[^>]*>[\s\S]*?<\/label>/.exec(html);
      assert.ok(label);
      assert.equal(label[0].includes('id="v4s-pilot-description"'), false);
    });
  }

  it('public: keeps the technical-trial notice', () => {
    assert.match(renderForm('public'), /DK v4 technical preview: packets are technical-trial output/);
  });
});

describe('v4 form with the config loaded: unavailable pair', () => {
  it('public: the unavailable provider is disabled with its label; the others stay enabled', () => {
    const rendered = options(renderSelect(FOUR_LANES, 'SL-028', ''));
    assert.deepEqual(rendered.map((option) => option.value), ['', 'openai', 'google', 'xai', 'anthropic']);
    const anthropic = rendered.find((option) => option.value === 'anthropic');
    assert.equal(anthropic?.disabled, true);
    assert.equal(anthropic?.text, 'Anthropic · claude-opus-5-5 (about 25 min) — Not available for this case');
    assert.equal(rendered.filter((option) => option.value !== 'anthropic').some((option) => option.disabled), false);
  });

  it('public: a previous selection of the now unavailable provider is cleared (nothing but the placeholder selected)', () => {
    const rendered = options(renderSelect(FOUR_LANES, 'SL-028', 'anthropic'));
    assert.deepEqual(rendered.filter((option) => option.selected).map((option) => option.value), ['']);
    const available = options(renderSelect(FOUR_LANES, 'SL-002', 'anthropic'));
    assert.deepEqual(available.filter((option) => option.selected).map((option) => option.value), ['anthropic']);
    assert.equal(available.find((option) => option.value === 'anthropic')?.disabled, false);
  });

  it('operator: the unavailable radio is disabled with its label and not checked', () => {
    const rendered = radios(renderRadios(FOUR_LANES, 'SL-028', 'anthropic'));
    const anthropic = rendered.find((radio) => radio.value === 'anthropic');
    assert.equal(anthropic?.disabled, true);
    assert.equal(anthropic?.checked, false);
    assert.match(anthropic?.label ?? '', /Anthropic · claude-opus-5-5 Not available for this case/);
    assert.equal(rendered.filter((radio) => radio.value !== 'anthropic').some((radio) => radio.disabled), false);
    assert.equal(radios(renderRadios(FOUR_LANES, 'SL-035', 'anthropic')).find((radio) => radio.value === 'anthropic')?.checked, true);
  });

  it('submit is blocked for the unavailable pair and allowed for an available one', () => {
    assert.equal(canSubmitForm(gate(FOUR_LANES, 'SL-028', 'anthropic')), false);
    assert.equal(canSubmitForm({ ...gate(FOUR_LANES, 'SL-028', 'anthropic'), lane: 'anthropic' }), false);
    assert.equal(canSubmitForm(gate(FOUR_LANES, 'SL-002', 'anthropic')), true);
    assert.equal(canSubmitForm(gate(FOUR_LANES, 'SL-028', 'openai')), true);
    assert.equal(canSubmitForm(gate(THREE_LANES, 'SL-002', 'anthropic')), false);
  });
});

describe('v4 form with the config loaded: malformed or duplicated lane data', () => {
  for (const { name, lanes } of ANTHROPIC_NOT_OFFERED) {
    it(`anthropic not shown and not submittable: ${name}`, () => {
      const rendered = options(renderSelect(lanes, 'SL-002', 'anthropic'));
      assert.deepEqual(rendered.map((option) => option.value), ['', 'openai', 'google', 'xai']);
      assert.deepEqual(rendered.filter((option) => option.selected).map((option) => option.value), ['']);
      assert.deepEqual(radios(renderRadios(lanes, 'SL-002', 'anthropic')).map((radio) => radio.value), ['openai', 'google', 'xai']);
      for (const pilot of ['SL-002', 'SL-028', 'SL-035'] as const) {
        assert.equal(canSubmitForm({ ...gate(lanes, pilot, 'anthropic'), lane: 'anthropic' }), false, pilot);
      }
    });
  }

  it('a legacy lane listed twice is shown with its static model, as on origin/main', () => {
    const openai = options(renderSelect(OPENAI_LISTED_TWICE, 'SL-028', '')).find((option) => option.value === 'openai');
    assert.equal(openai?.text, 'OpenAI · gpt-6-astra (about 20 min)');
    assert.equal(openai?.disabled, false);
  });

  it('a model of another family is never shown: the static name is', () => {
    const lanes = [{ ...FOUR_LANES[0], generatorModel: 'claude-opus-5-5' }, ...FOUR_LANES.slice(1)];
    assert.equal(options(renderSelect(lanes, '', '')).find((option) => option.value === 'openai')?.text, 'OpenAI · gpt-6-astra (about 20 min)');
  });
});

describe('submitted and earlier requests (pending and status panels)', () => {
  it('are labelled with the provider name only, never a model name', () => {
    assert.deepEqual(
      LANES.map((lane) => requestProviderLabel(lane, lane.value)),
      ['OpenAI', 'Google', 'xAI', 'Anthropic']
    );
    for (const lane of LANES) {
      const label = requestProviderLabel(lane, lane.value);
      assert.equal(label.includes(lane.model), false, lane.value);
      assert.doesNotMatch(label, /gpt-|gemini-|grok-|claude-/);
    }
  });

  it('fall back to the given text when the lane is unknown', () => {
    assert.equal(requestProviderLabel(undefined, '—'), '—');
    assert.equal(requestProviderLabel(undefined, 'meta'), 'meta');
  });
});
