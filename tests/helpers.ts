/** Shared fixtures for the unit tests: a backend `/v1/config` body and a fetch stub that records backend calls. */

export const REQUEST_ID = '0123456789abcdef0123456789abcdef';

type BackendLane = Record<string, unknown>;

/** Today's backend (before the Anthropic deploy): three lanes, no `unavailablePilots`. */
export const THREE_LANES: BackendLane[] = [
  { lane: 'openai', generatorModel: 'gpt-6-astra', reviewerModel: 'reviewer-model-a', capUsd: '13.50', timeoutSeconds: 3000 },
  { lane: 'google', generatorModel: 'gemini-test-model', reviewerModel: 'reviewer-model-b', capUsd: '13.50', timeoutSeconds: 3000 },
  { lane: 'xai', generatorModel: 'grok-4.7', reviewerModel: 'reviewer-model-c', capUsd: '8.75', timeoutSeconds: 6000 }
];

/** The backend after the Anthropic deploy: four lanes, `unavailablePilots` on every lane, anthropic:SL-028 off. */
export const FOUR_LANES: BackendLane[] = [
  ...THREE_LANES.map((lane) => ({ ...lane, unavailablePilots: [] })),
  {
    lane: 'anthropic',
    generatorModel: 'claude-opus-5-5',
    reviewerModel: 'reviewer-model-d',
    capUsd: '12.00',
    timeoutSeconds: 2700,
    unavailablePilots: ['SL-028']
  }
];

const LEGACY_VALID = FOUR_LANES.slice(0, 3);
const ANTHROPIC = FOUR_LANES[3] as BackendLane;

function omit(entry: BackendLane, key: string): BackendLane {
  const copy = { ...entry };
  delete copy[key];
  return copy;
}

function withAnthropic(...entries: BackendLane[]): BackendLane[] {
  return [...LEGACY_VALID, ...entries];
}

export interface LaneCase {
  name: string;
  /** The `lanes` field of /v1/config. */
  lanes: unknown;
}

/**
 * Configs that must NOT offer anthropic (fail closed); the three legacy lanes in them are valid. A route request
 * for anthropic with any of them must be refused without calling POST /v1/requests.
 */
export const ANTHROPIC_NOT_OFFERED: LaneCase[] = [
  { name: 'unavailablePilots missing', lanes: withAnthropic(omit(ANTHROPIC, 'unavailablePilots')) },
  { name: 'unavailablePilots is a string', lanes: withAnthropic({ ...ANTHROPIC, unavailablePilots: 'SL-028' }) },
  { name: 'unavailablePilots is null', lanes: withAnthropic({ ...ANTHROPIC, unavailablePilots: null }) },
  { name: 'unavailablePilots has an unknown case id', lanes: withAnthropic({ ...ANTHROPIC, unavailablePilots: ['SL-028', 'SL-999'] }) },
  { name: 'unavailablePilots has a non-string', lanes: withAnthropic({ ...ANTHROPIC, unavailablePilots: ['SL-028', 7] }) },
  { name: 'capUsd missing', lanes: withAnthropic(omit(ANTHROPIC, 'capUsd')) },
  { name: 'capUsd is a number', lanes: withAnthropic({ ...ANTHROPIC, capUsd: 12 }) },
  { name: 'capUsd is not a two-decimal string', lanes: withAnthropic({ ...ANTHROPIC, capUsd: '12' }) },
  { name: 'generatorModel missing', lanes: withAnthropic(omit(ANTHROPIC, 'generatorModel')) },
  { name: 'generatorModel of another family', lanes: withAnthropic({ ...ANTHROPIC, generatorModel: 'gpt-6-astra' }) },
  { name: 'generatorModel not a plain id', lanes: withAnthropic({ ...ANTHROPIC, generatorModel: 'claude opus <b>' }) },
  {
    name: 'listed twice: open with cap 12.00, then SL-028 unavailable with cap 13.00',
    lanes: withAnthropic({ ...ANTHROPIC, unavailablePilots: [] }, { ...ANTHROPIC, capUsd: '13.00' })
  },
  { name: 'listed twice, identical entries', lanes: withAnthropic(ANTHROPIC, ANTHROPIC) },
  { name: 'keyed form with scalar caps', lanes: { openai: '13.50', google: '13.50', xai: '8.75', anthropic: '12.00' } },
  {
    name: 'keyed form with full entries',
    lanes: {
      openai: { capUsd: '13.50' },
      google: { capUsd: '13.50' },
      xai: { capUsd: '8.75' },
      anthropic: { ...ANTHROPIC, unavailablePilots: [] }
    }
  }
];

/** Configs whose openai entry is malformed: openai must not be offered (the other lanes stay valid). */
export const OPENAI_NOT_OFFERED: LaneCase[] = [
  { name: 'unavailablePilots is a string', lanes: [{ ...FOUR_LANES[0], unavailablePilots: 'SL-028' }, ...FOUR_LANES.slice(1)] },
  { name: 'unavailablePilots has an unknown case id', lanes: [{ ...FOUR_LANES[0], unavailablePilots: ['SL-999'] }, ...FOUR_LANES.slice(1)] },
  { name: 'capUsd is a number', lanes: [{ ...FOUR_LANES[0], capUsd: 13.5 }, ...FOUR_LANES.slice(1)] },
  { name: 'capUsd missing', lanes: [omit(FOUR_LANES[0] as BackendLane, 'capUsd'), ...FOUR_LANES.slice(1)] }
];

/**
 * A legacy lane listed twice keeps origin/main's behaviour: offered without site-side restriction, static model,
 * and the last valid cap among its entries (here 14.00), as origin/main's laneCapsFrom chose it.
 */
export const OPENAI_LISTED_TWICE: unknown[] = [
  { ...FOUR_LANES[0], unavailablePilots: ['SL-028'], capUsd: '13.50' },
  { lane: 'openai', generatorModel: 'gpt-other', capUsd: '14.00' },
  ...FOUR_LANES.slice(1)
];

/** A `/v1/config` body shaped like the staging backend's, including fields the site must not pass through. */
export function backendConfig(lanes: unknown): Record<string, unknown> {
  const config: Record<string, unknown> = {
    service: 'dk-v4-staging',
    s1: 'f5b229fabcdef0123456789abcdef0123456789a',
    pilots: ['SL-002', 'SL-028', 'SL-035'],
    recipientMode: 'public',
    allowedRecipients: [],
    dailyCapUsd: '50.00',
    totalCapUsd: '300.00',
    dailyUsedUsd: 4.26,
    dailyRemainingUsd: 45.74,
    totalUsedUsd: 20.5,
    totalRemainingUsd: 279.5,
    dayUtc: '2026-11-12',
    spendState: 'enabled',
    runInProgress: false,
    reconciliationRequired: false,
    spendEnforcement: 'internal note: reservations on internal-host.invalid'
  };
  if (lanes !== undefined) config.lanes = lanes;
  return config;
}

export interface BackendCall {
  method: string;
  path: string;
  body: string | null;
}

export interface SubmitAnswer {
  status: number;
  json: unknown;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

/**
 * Replaces global fetch with a stub backend. Returns the recorded calls and a restore function.
 * `submit` answers POST /v1/requests (default: 202 accepted).
 */
export function stubBackend(
  config: unknown,
  submit: (body: Record<string, unknown>) => SubmitAnswer = () => ({
    status: 202,
    json: { requestId: REQUEST_ID, state: 'queued', capUsd: '12.00', dailyRemainingUsd: '33.74' }
  })
): { calls: BackendCall[]; restore: () => void } {
  const original = globalThis.fetch;
  const calls: BackendCall[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    const body = typeof init?.body === 'string' ? init.body : null;
    const method = init?.method ?? 'GET';
    calls.push({ method, path: url.pathname, body });
    if (method === 'GET' && url.pathname.endsWith('/v1/config')) return jsonResponse(200, config);
    if (method === 'POST' && url.pathname.endsWith('/v1/requests')) {
      const answer = submit(JSON.parse(body ?? '{}') as Record<string, unknown>);
      return jsonResponse(answer.status, answer.json);
    }
    return jsonResponse(404, { error: 'not_found' });
  }) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

/** Enables v4 for the route handlers (loopback base URL, so nothing can leave the machine). */
export function enableV4(vercelEnv: 'production' | 'preview' | undefined): () => void {
  const saved = {
    url: process.env.DK_V4_STAGING_URL,
    token: process.env.DK_V4_STAGING_TOKEN,
    env: process.env.VERCEL_ENV
  };
  process.env.DK_V4_STAGING_URL = 'http://127.0.0.1:9/';
  process.env.DK_V4_STAGING_TOKEN = 'unit-test-bearer';
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;
  return () => {
    for (const [name, value] of [
      ['DK_V4_STAGING_URL', saved.url],
      ['DK_V4_STAGING_TOKEN', saved.token],
      ['VERCEL_ENV', saved.env]
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  };
}
