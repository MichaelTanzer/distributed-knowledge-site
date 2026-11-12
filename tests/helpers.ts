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

/** A `/v1/config` body shaped like the staging backend's, including fields the site must not pass through. */
export function backendConfig(lanes: unknown[] | undefined): Record<string, unknown> {
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
