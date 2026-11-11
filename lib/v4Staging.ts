/**
 * DK v4 staging helpers. SERVER-ONLY: imported by app/v4-staging/page.tsx and
 * the app/api/v4/* route handlers. Client components may only use
 * `import type` from this module (type imports are erased at build time).
 *
 * Nothing here contains a backend address or credential. The backend base URL
 * and bearer come from the DK_V4_STAGING_URL / DK_V4_STAGING_TOKEN env vars,
 * which exist only in the Vercel Preview environment for branch feat/v4-staging.
 */
import { isIP } from 'node:net';
import { NextResponse } from 'next/server';
import { operatorPreview, v4Enabled } from './v4Env';

export { operatorPreview, v4Enabled };

if (typeof window !== 'undefined') {
  throw new Error('lib/v4Staging is server-only');
}

// ---------------------------------------------------------------------------
// Catalogue (display labels; the `value` fields are the exact backend values)
// ---------------------------------------------------------------------------

export type PilotValue = 'SL-002' | 'SL-028' | 'SL-035';
export type LaneValue = 'openai' | 'google' | 'xai';

export interface PilotOption {
  value: PilotValue;
  label: string;
}

export interface LaneOption {
  value: LaneValue;
  provider: string;
  model: string;
  /**
   * Per-request reservation cap in USD (two decimals, exactly as sent in
   * `ack_cap_usd`). Enforced on worst-case reservations before each call; it is
   * not a hard maximum on billed usage.
   */
  capUsd: string;
  typicalRuntime: string;
}

export const PILOTS: readonly PilotOption[] = [
  { value: 'SL-002', label: 'KIQ example 1 (SL-002)' },
  { value: 'SL-028', label: 'KIQ example 2 (SL-028)' },
  { value: 'SL-035', label: 'KIQ example 3 (SL-035)' }
];

export const LANES: readonly LaneOption[] = [
  { value: 'openai', provider: 'OpenAI', model: 'gpt-6-astra', capUsd: '13.50', typicalRuntime: '~20 min' },
  { value: 'google', provider: 'Google', model: 'gemini-4-argon', capUsd: '13.50', typicalRuntime: '~20–25 min' },
  { value: 'xai', provider: 'xAI', model: 'grok-4.7', capUsd: '8.75', typicalRuntime: '~70 min' }
];

const PILOT_VALUES: ReadonlySet<string> = new Set(PILOTS.map((pilot) => pilot.value));
const LANE_VALUES: ReadonlySet<string> = new Set(LANES.map((lane) => lane.value));

export function isPilot(value: unknown): value is PilotValue {
  return typeof value === 'string' && PILOT_VALUES.has(value);
}

export function isLane(value: unknown): value is LaneValue {
  return typeof value === 'string' && LANE_VALUES.has(value);
}

export const REQUEST_STATES = ['queued', 'running', 'delivered', 'failed', 'interrupted', 'interrupted_unreconciled'] as const;
export type RequestState = (typeof REQUEST_STATES)[number] | 'unknown';

// ---------------------------------------------------------------------------
// Backend field names. ALL backend JSON field names live in this one table so
// they can be adjusted in one place if the backend contract changes. A list
// means "first one present wins". `pick()` also accepts the snake_case
// spelling of every camelCase name here.
// Reconciled with infopack/staging/server.py (backend writer, 2026-11-10).
// ---------------------------------------------------------------------------

export const BACKEND_FIELDS = {
  /** POST /v1/requests body (plan §2.2). */
  requestBody: {
    pilot: 'pilot',
    lane: 'lane',
    recipient: 'recipient',
    ackCapUsd: 'ack_cap_usd'
  },
  /**
   * GET /v1/config response. `recipient` / `allowedRecipients` are informational only (operator view;
   * empty in public recipient mode): the submitted recipient is always the requester's own email.
   */
  config: {
    recipient: 'recipient',
    recipientList: 'allowedRecipients',
    dailyRemainingUsd: 'dailyRemainingUsd',
    dailyCapUsd: 'dailyCapUsd',
    totalRemainingUsd: 'totalRemainingUsd',
    totalCapUsd: 'totalCapUsd',
    dayUtc: 'dayUtc',
    spendState: 'spendState',
    runInProgress: 'runInProgress',
    reconciliationRequired: 'reconciliationRequired',
    lanes: 'lanes',
    laneId: 'lane',
    laneCapUsd: 'capUsd',
    backendSha: 's1'
  },
  /**
   * POST /v1/requests success: 202 for a new request, or 200 with
   * `replay: true` when the same Idempotency-Key and body are replayed.
   */
  accepted: {
    requestId: 'requestId',
    state: 'state',
    capUsd: 'capUsd',
    dailyRemainingUsd: 'dailyRemainingUsd',
    replay: 'replay'
  },
  /** GET /v1/requests/{id} response. */
  status: {
    requestId: 'requestId',
    state: 'state',
    pilot: 'pilot',
    lane: 'lane',
    capUsd: 'capUsd',
    committedUsd: 'committedUsd',
    reservedUsd: 'reservedUsd',
    reasonCode: 'reasonCode',
    admittedAt: 'admittedAt',
    startedAt: 'startedAt',
    finishedAt: 'finishedAt'
  },
  /**
   * Error body on any non-2xx response. The backend sends `{error, message?,
   * retryAfterSeconds?, capUsd?}`; plan §2.2 called the code field `code`.
   */
  error: {
    code: ['error', 'code'],
    message: 'message',
    retryAfterSeconds: 'retryAfterSeconds',
    requestId: 'requestId',
    capUsd: 'capUsd'
  }
} as const;

/** Backend paths, relative so that a base URL with a path prefix keeps it. */
export const BACKEND_PATHS = {
  config: 'v1/config',
  requests: 'v1/requests',
  request: (id: string) => `v1/requests/${encodeURIComponent(id)}`
} as const;

/**
 * Request-id format: exactly 32 lowercase hex characters, as the backend
 * generates and as its `/v1/requests/{id}` route accepts. No `/`, `.` or `%`,
 * so an id can never change the backend path.
 */
export const REQUEST_ID_PATTERN = /^[0-9a-f]{32}$/;

export function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_ID_PATTERN.test(value);
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Guards: v4Enabled() (lib/v4Env.ts) gates /generate's v4 form and the /api/v4 routes in any environment;
// the operator page /v4-staging additionally needs a Vercel Preview deployment.
// ---------------------------------------------------------------------------

function envValue(name: 'DK_V4_STAGING_URL' | 'DK_V4_STAGING_TOKEN'): string {
  return (process.env[name] ?? '').trim();
}

/** The operator page: Vercel Preview only, and v4 configured. */
export function stagingPageEnabled(): boolean {
  return operatorPreview() && v4Enabled();
}

// ---------------------------------------------------------------------------
// Requester email (the public form's recipient)
// ---------------------------------------------------------------------------

/**
 * One strict ASCII address, local@domain.tld, at most 254 characters (local part at most 64): no CR or LF,
 * commas, semicolons, angle brackets, quotes, backticks or spaces; no leading, trailing or doubled dots in
 * the local part; domain labels of letters, digits and inner hyphens, ending in a 2-63 letter TLD. The same
 * pattern is used by the browser form and by POST /api/v4/requests.
 */
export const RECIPIENT_PATTERN =
  /^(?=.{3,254}$)(?!\.)(?!.*\.\.)[A-Za-z0-9.!#$%&*+/=?^_{|}~-]{1,64}(?<!\.)@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}$/;

export function isPublicRecipient(value: unknown): value is string {
  return typeof value === 'string' && RECIPIENT_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// Shapes returned to the browser (sanitised; never raw backend JSON)
// ---------------------------------------------------------------------------

/** `admission_disabled` = kill switch on: no new runs; a run in flight continues. */
export type SpendState = 'enabled' | 'admission_disabled' | 'unknown';

export interface StagingConfigView {
  recipient: string | null;
  dailyRemainingUsd: string | null;
  dailyCapUsd: string | null;
  totalRemainingUsd: string | null;
  totalCapUsd: string | null;
  dayUtc: string | null;
  spendState: SpendState;
  runInProgress: boolean | null;
  reconciliationRequired: boolean | null;
  laneCapsUsd: Partial<Record<LaneValue, string>>;
  backendSha: string | null;
}

export interface SubmitAcceptedView {
  requestId: string;
  state: RequestState;
  capUsd: string | null;
  dailyRemainingUsd: string | null;
  /** True when the backend recognised a replay of an earlier submission. */
  replay: boolean;
}

export interface RequestStatusView {
  requestId: string;
  state: RequestState;
  pilot: PilotValue | null;
  lane: LaneValue | null;
  capUsd: string | null;
  committedUsd: string | null;
  reservedUsd: string | null;
  reasonCode: string | null;
  admittedAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface ApiErrorView {
  code: string;
  message: string;
  retryAfterSeconds?: number;
  requestId?: string;
}

// ---------------------------------------------------------------------------
// Normalisation of backend JSON
// ---------------------------------------------------------------------------

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function snakeCase(name: string): string {
  return name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);
}

/** Reads the first present of `names`, each also tried in its snake_case spelling. */
function pick(source: JsonObject, names: string | readonly string[]): unknown {
  for (const name of typeof names === 'string' ? [names] : names) {
    if (Object.prototype.hasOwnProperty.call(source, name)) return source[name];
    const snake = snakeCase(name);
    if (snake !== name && Object.prototype.hasOwnProperty.call(source, snake)) return source[snake];
  }
  return undefined;
}

function bool(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

/** USD amount (number or decimal string) → two-decimal string, else null. */
export function usd(value: unknown): string | null {
  let amount: number;
  if (typeof value === 'number') {
    amount = value;
  } else if (typeof value === 'string' && /^-?\d{1,7}(\.\d{1,8})?$/.test(value.trim())) {
    amount = Number(value.trim());
  } else {
    return null;
  }
  if (!Number.isFinite(amount) || Math.abs(amount) >= 1e7) return null;
  return amount.toFixed(2);
}

const EMAIL_PATTERN = /^[^\s@<>()",;:]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,62}[A-Za-z0-9])?)+$/;

function recipientFrom(value: unknown): string | null {
  return typeof value === 'string' && value.length <= 254 && EMAIL_PATTERN.test(value) ? value : null;
}

function shortCode(value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(value) ? value : null;
}

/** ISO-like string passed through; epoch seconds converted only when the Date is valid (never throws). */
function timestamp(value: unknown): string | null {
  if (typeof value === 'string' && /^[0-9T:.+\-Z ]{4,40}$/.test(value)) return value;
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    const date = new Date(value * 1000);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  return null;
}

function requestState(value: unknown): RequestState {
  return typeof value === 'string' && (REQUEST_STATES as readonly string[]).includes(value)
    ? (value as RequestState)
    : 'unknown';
}

function spendStateFrom(source: JsonObject): SpendState {
  const f = BACKEND_FIELDS.config;
  const state = pick(source, f.spendState);
  if (state === 'enabled') return 'enabled';
  if (state === 'admission_disabled') return 'admission_disabled';
  return 'unknown';
}

function laneCapsFrom(value: unknown): Partial<Record<LaneValue, string>> {
  const f = BACKEND_FIELDS.config;
  const caps: Partial<Record<LaneValue, string>> = {};
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!isObject(entry)) continue;
      const lane = pick(entry, f.laneId);
      const cap = usd(pick(entry, f.laneCapUsd));
      if (isLane(lane) && cap) caps[lane] = cap;
    }
  } else if (isObject(value)) {
    for (const lane of LANE_VALUES) {
      const entry = value[lane];
      const cap = isObject(entry) ? usd(pick(entry, f.laneCapUsd)) : usd(entry);
      if (cap) caps[lane as LaneValue] = cap;
    }
  }
  return caps;
}

export function normalizeConfig(raw: unknown): StagingConfigView {
  const source = isObject(raw) ? raw : {};
  const f = BACKEND_FIELDS.config;
  let recipient = recipientFrom(pick(source, f.recipient));
  if (!recipient) {
    const list = pick(source, f.recipientList);
    if (Array.isArray(list)) recipient = recipientFrom(list[0]);
  }
  const sha = pick(source, f.backendSha);
  const day = pick(source, f.dayUtc);
  return {
    recipient,
    dailyRemainingUsd: usd(pick(source, f.dailyRemainingUsd)),
    dailyCapUsd: usd(pick(source, f.dailyCapUsd)),
    totalRemainingUsd: usd(pick(source, f.totalRemainingUsd)),
    totalCapUsd: usd(pick(source, f.totalCapUsd)),
    dayUtc: typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) ? day : null,
    spendState: spendStateFrom(source),
    runInProgress: bool(pick(source, f.runInProgress)),
    reconciliationRequired: bool(pick(source, f.reconciliationRequired)),
    laneCapsUsd: laneCapsFrom(pick(source, f.lanes)),
    backendSha: typeof sha === 'string' && /^[0-9a-f]{7,40}$/i.test(sha) ? sha.slice(0, 12) : null
  };
}

export function normalizeAccepted(raw: unknown): SubmitAcceptedView | null {
  if (!isObject(raw)) return null;
  const f = BACKEND_FIELDS.accepted;
  const requestId = pick(raw, f.requestId);
  if (!isRequestId(requestId)) return null;
  return {
    requestId,
    state: requestState(pick(raw, f.state)),
    capUsd: usd(pick(raw, f.capUsd)),
    dailyRemainingUsd: usd(pick(raw, f.dailyRemainingUsd)),
    replay: pick(raw, f.replay) === true
  };
}

export function normalizeStatus(raw: unknown, requestId: string): RequestStatusView | null {
  if (!isObject(raw)) return null;
  const f = BACKEND_FIELDS.status;
  const pilot = pick(raw, f.pilot);
  const lane = pick(raw, f.lane);
  return {
    requestId,
    state: requestState(pick(raw, f.state)),
    pilot: isPilot(pilot) ? pilot : null,
    lane: isLane(lane) ? lane : null,
    capUsd: usd(pick(raw, f.capUsd)),
    committedUsd: usd(pick(raw, f.committedUsd)),
    reservedUsd: usd(pick(raw, f.reservedUsd)),
    reasonCode: shortCode(pick(raw, f.reasonCode)),
    admittedAt: timestamp(pick(raw, f.admittedAt)),
    startedAt: timestamp(pick(raw, f.startedAt)),
    finishedAt: timestamp(pick(raw, f.finishedAt))
  };
}

// ---------------------------------------------------------------------------
// Safe error mapping
// ---------------------------------------------------------------------------

/** Backend error codes whose message is passed through to the browser. */
export const KNOWN_ERROR_STATUS = {
  rate_limited: 429,
  daily_spend_ceiling_reached: 429,
  run_in_progress: 409,
  duplicate: 409,
  idempotency_conflict: 409,
  cap_ack_mismatch: 409,
  spend_disabled: 503,
  staging_budget_exhausted: 503,
  reconciliation_required: 503,
  recipient_not_allowed: 403,
  invalid_recipient: 400,
  origin_not_allowed: 403,
  bad_client_ip: 400
} as const;

export type KnownErrorCode = keyof typeof KNOWN_ERROR_STATUS;

const KNOWN_ERROR_FALLBACK: Record<KnownErrorCode, string> = {
  rate_limited: 'Too many requests from this address. Try again later.',
  daily_spend_ceiling_reached: 'The daily staging spend ceiling has been reached. It resets at 00:00 UTC.',
  run_in_progress: 'Another staging run is in progress. Wait for it to finish.',
  duplicate: 'This request was already submitted.',
  idempotency_conflict: 'This submission key was already used for a different request. Submit again.',
  cap_ack_mismatch: "The acknowledged reservation cap does not match the backend's reservation cap for this lane.",
  spend_disabled: 'New runs are paused (staging admission is disabled). A run already in progress keeps going until it finishes or times out.',
  staging_budget_exhausted: 'The overall staging budget is exhausted.',
  reconciliation_required: 'An earlier run needs operator reconciliation; no new runs are accepted until then.',
  recipient_not_allowed: 'The recipient is not on the staging allowlist.',
  invalid_recipient: 'Enter a single valid email address.',
  origin_not_allowed: 'This origin is not allowed.',
  bad_client_ip: 'The client address could not be determined.'
};

/**
 * Wording for the public (production) API and the public /generate form, by error code. It never carries
 * budget figures, internal state or backend text. `default` covers every other code.
 */
export const PUBLIC_ERROR_COPY: Readonly<Record<string, string>> = {
  daily_spend_ceiling_reached: "Today's capacity is used up; please try again after 00:00 UTC.",
  staging_budget_exhausted: 'Generation is temporarily unavailable. Please try again later.',
  run_in_progress: 'Another request is being generated right now (runs take 20–70 minutes). Please try again later.',
  rate_limited: 'Too many requests for this email address or connection. Please try again later.',
  invalid_recipient: 'Enter a single valid email address.',
  spend_disabled: 'Generation is paused right now. Please try again later.',
  reconciliation_required: 'Generation is temporarily unavailable. Please try again later.',
  idempotency_conflict: 'This request could not be matched to your earlier attempt. Please contact Distributed Knowledge.',
  duplicate: 'This request was already received.',
  origin_not_allowed: 'Please send the request from the Distributed Knowledge website.',
  bad_client_ip: 'Your connection could not be identified. Please try again later.',
  invalid_request: 'Please check the form and try again.',
  body_too_large: 'Please check the form and try again.',
  unsupported_media_type: 'Please check the form and try again.',
  invalid_idempotency_key: 'Please reload the page and try again.',
  invalid_request_id: 'Please reload the page and try again.',
  not_found: 'This request is no longer known.',
  backend_timeout: 'Generation is temporarily unavailable. Please try again later.',
  backend_unavailable: 'Generation is temporarily unavailable. Please try again later.',
  backend_error: 'Generation is temporarily unavailable. Please try again later.',
  backend_auth_failed: 'Generation is temporarily unavailable. Please try again later.',
  staging_misconfigured: 'Generation is temporarily unavailable. Please try again later.',
  v4_unavailable: 'Generation is temporarily unavailable. Please try again later.',
  default: 'Something went wrong. Please try again later.'
};

/** Public deployments (not Vercel Preview) replace every error message with PUBLIC_ERROR_COPY. */
export function publicError(mapped: MappedError): MappedError {
  if (operatorPreview()) return mapped;
  const message = PUBLIC_ERROR_COPY[mapped.body.code] ?? PUBLIC_ERROR_COPY.default;
  const body: ApiErrorView = { code: mapped.body.code, message };
  if (mapped.body.retryAfterSeconds !== undefined) body.retryAfterSeconds = mapped.body.retryAfterSeconds;
  if (mapped.body.requestId !== undefined) body.requestId = mapped.body.requestId;
  return { status: mapped.status, body };
}

/** Public deployments omit every money and build figure from the config view (same shape, nulled). */
export function configForAudience(view: StagingConfigView): StagingConfigView {
  if (operatorPreview()) return view;
  return {
    ...view,
    recipient: null,
    dailyRemainingUsd: null,
    dailyCapUsd: null,
    totalRemainingUsd: null,
    totalCapUsd: null,
    dayUtc: null,
    laneCapsUsd: {},
    backendSha: null
  };
}

/** Public deployments omit the money fields of a request status / acceptance. */
export function statusForAudience(view: RequestStatusView): RequestStatusView {
  return operatorPreview() ? view : { ...view, capUsd: null, committedUsd: null, reservedUsd: null };
}

export function acceptedForAudience(view: SubmitAcceptedView): SubmitAcceptedView {
  return operatorPreview() ? view : { ...view, capUsd: null, dailyRemainingUsd: null };
}

const GENERIC_BACKEND_MESSAGE = 'The staging backend could not process this request. Try again later.';

function isKnownErrorCode(value: unknown): value is KnownErrorCode {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(KNOWN_ERROR_STATUS, value);
}

/**
 * Backend message for a known code, or null if it is not a short plain string
 * or it could reveal the backend address or the bearer.
 */
function safeBackendMessage(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const message = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  if (message === '' || message.length > 500) return null;
  const lowered = message.toLowerCase();
  if (lowered.includes('://')) return null;
  const base = envValue('DK_V4_STAGING_URL').toLowerCase();
  if (base !== '') {
    let host = '';
    try {
      host = new URL(base).hostname;
    } catch {
      host = '';
    }
    if (lowered.includes(base) || (host !== '' && lowered.includes(host))) return null;
  }
  const token = envValue('DK_V4_STAGING_TOKEN');
  if (token !== '' && message.includes(token)) return null;
  return message;
}

function retryAfter(value: unknown): number | undefined {
  const seconds = typeof value === 'string' && /^\d{1,6}$/.test(value) ? Number(value) : value;
  return typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 0 && seconds <= 172800
    ? seconds
    : undefined;
}

export interface MappedError {
  status: number;
  body: ApiErrorView;
}

export type BackendResult =
  | { kind: 'ok'; status: number; json: unknown }
  | { kind: 'http'; status: number; json: unknown }
  | { kind: 'timeout' }
  | { kind: 'unavailable' }
  | { kind: 'misconfigured' };

/** Maps any failed backend result to a browser-safe status and body. */
export function mapBackendFailure(result: Exclude<BackendResult, { kind: 'ok' }>, context: 'config' | 'submit' | 'status'): MappedError {
  if (result.kind === 'timeout') {
    return { status: 504, body: { code: 'backend_timeout', message: 'The staging backend did not answer in time. Try again later.' } };
  }
  if (result.kind === 'unavailable') {
    return { status: 502, body: { code: 'backend_unavailable', message: 'The staging backend is unreachable. Try again later.' } };
  }
  if (result.kind === 'misconfigured') {
    return { status: 503, body: { code: 'staging_misconfigured', message: 'The staging page is not configured correctly.' } };
  }
  const source = isObject(result.json) ? result.json : {};
  const f = BACKEND_FIELDS.error;
  const code = pick(source, f.code);
  if (isKnownErrorCode(code)) {
    let fallback = KNOWN_ERROR_FALLBACK[code];
    const backendCap = usd(pick(source, f.capUsd));
    if (code === 'cap_ack_mismatch' && backendCap) fallback = `${fallback} The backend reservation cap is $${backendCap}; reload the page and try again.`;
    const body: ApiErrorView = { code, message: safeBackendMessage(pick(source, f.message)) ?? fallback };
    const seconds = retryAfter(pick(source, f.retryAfterSeconds));
    if (seconds !== undefined) body.retryAfterSeconds = seconds;
    const existing = pick(source, f.requestId);
    if ((code === 'duplicate' || code === 'run_in_progress') && isRequestId(existing)) body.requestId = existing;
    return { status: KNOWN_ERROR_STATUS[code], body };
  }
  if (result.status === 401) {
    return { status: 502, body: { code: 'backend_auth_failed', message: 'The staging backend refused the site credentials. Check the Preview environment variables.' } };
  }
  if (context === 'status' && result.status === 404) {
    return { status: 404, body: { code: 'not_found', message: 'The backend does not know this request id.' } };
  }
  return { status: 502, body: { code: 'backend_error', message: GENERIC_BACKEND_MESSAGE } };
}

// ---------------------------------------------------------------------------
// Backend fetch
// ---------------------------------------------------------------------------

const BACKEND_TIMEOUT_MS = 15000;
const MAX_BACKEND_RESPONSE_BYTES = 64 * 1024;

/** Validated base URL with a trailing slash, or null. HTTPS only, except loopback. */
function backendBase(): URL | null {
  let base: URL;
  try {
    base = new URL(envValue('DK_V4_STAGING_URL'));
  } catch {
    return null;
  }
  if (base.username || base.password || base.search || base.hash) return null;
  const loopback = base.hostname === '127.0.0.1' || base.hostname === 'localhost' || base.hostname === '[::1]';
  if (base.protocol !== 'https:' && !(base.protocol === 'http:' && loopback)) return null;
  if (!base.pathname.endsWith('/')) base.pathname = `${base.pathname}/`;
  return base;
}

export interface BackendRequestOptions {
  method: 'GET' | 'POST';
  body?: string;
  clientIp?: string | null;
  idempotencyKey?: string;
}

/**
 * Calls the staging backend. Sends only the headers built here (bearer,
 * client IP, idempotency key, content type); browser cookies and other
 * incoming headers are never forwarded. Redirects are refused so the bearer
 * cannot follow one.
 */
export async function backendRequest(path: string, options: BackendRequestOptions): Promise<BackendResult> {
  const base = backendBase();
  const token = envValue('DK_V4_STAGING_TOKEN');
  if (!base || token === '' || /\s/.test(token)) return { kind: 'misconfigured' };
  const url = new URL(path, base);
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return { kind: 'misconfigured' };

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${token}`
  };
  if (options.clientIp) headers['x-dk-client-ip'] = options.clientIp;
  if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
  if (options.body !== undefined) headers['content-type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method,
      headers,
      body: options.body,
      cache: 'no-store',
      redirect: 'error',
      signal: AbortSignal.timeout(BACKEND_TIMEOUT_MS)
    });
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'timeout' };
    return { kind: 'unavailable' };
  }

  let json: unknown = null;
  try {
    const text = await response.text();
    if (text.length <= MAX_BACKEND_RESPONSE_BYTES && text !== '') json = JSON.parse(text);
  } catch (error) {
    if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) return { kind: 'timeout' };
    json = null;
  }
  return response.ok ? { kind: 'ok', status: response.status, json } : { kind: 'http', status: response.status, json };
}

// ---------------------------------------------------------------------------
// Request helpers for the route handlers
// ---------------------------------------------------------------------------

/** First entry of `x-forwarded-for` (set by Vercel's edge), if it is an IP. */
export function clientIpFrom(request: Request): string | null {
  const forwarded = request.headers.get('x-forwarded-for');
  if (!forwarded) return null;
  const first = forwarded.split(',')[0]?.trim() ?? '';
  return isIP(first) !== 0 ? first : null;
}

function firstHeaderValue(request: Request, name: string): string | null {
  const value = request.headers.get(name);
  if (!value) return null;
  const first = value.split(',')[0]?.trim() ?? '';
  return first === '' ? null : first;
}

/**
 * POST same-origin check: `Sec-Fetch-Site` must be exactly `same-origin` (a
 * missing header is refused) and `Origin` must be present and equal to this
 * request's own origin. The own origin is the parsed request URL, or scheme +
 * forwarded host / Host header (set by the browser or the platform, never by
 * page script).
 */
export function isSameOriginPost(request: Request & { nextUrl?: URL }): boolean {
  if (request.headers.get('sec-fetch-site') !== 'same-origin') return false;
  const origin = request.headers.get('origin');
  if (!origin) return false;
  const own = new Set<string>();
  const parsed = request.nextUrl ?? new URL(request.url);
  own.add(parsed.origin);
  const host = firstHeaderValue(request, 'x-forwarded-host') ?? firstHeaderValue(request, 'host');
  const proto = firstHeaderValue(request, 'x-forwarded-proto') ?? parsed.protocol.replace(/:$/, '');
  if (host && (proto === 'https' || proto === 'http')) own.add(`${proto}://${host}`.toLowerCase());
  return own.has(origin.toLowerCase());
}

/** GET requests: refuse when the browser says the request came from another site. */
export function isCrossSiteGet(request: Request): boolean {
  const fetchSite = request.headers.get('sec-fetch-site');
  return fetchSite === 'cross-site' || fetchSite === 'same-site';
}

export type LimitedBody = { ok: true; text: string } | { ok: false; reason: 'too_large' | 'unreadable' };

/** Reads the request body as UTF-8, refusing anything over `limit` bytes. */
export async function readBodyLimited(request: Request, limit: number): Promise<LimitedBody> {
  const declared = request.headers.get('content-length');
  if (declared !== null) {
    if (!/^\d+$/.test(declared)) return { ok: false, reason: 'unreadable' };
    if (Number(declared) > limit) return { ok: false, reason: 'too_large' };
  }
  if (!request.body) return { ok: true, text: '' };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, reason: 'too_large' };
      }
      chunks.push(value);
    }
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
}

export type SubmitBody = { pilot: PilotValue; lane: LaneValue; recipient: string };

const SUBMIT_KEYS = ['lane', 'pilot', 'recipient'];

/**
 * Strict browser body: exactly `pilot`, `lane`, `recipient` (the requester's email). The reservation cap
 * acknowledgement is not taken from the browser; the route supplies it from the backend config.
 */
export function parseSubmitBody(text: string): { ok: true; body: SubmitBody } | { ok: false; reason: 'shape' | 'recipient' } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'shape' };
  }
  if (!isObject(parsed)) return { ok: false, reason: 'shape' };
  const keys = Object.keys(parsed).sort();
  if (keys.length !== SUBMIT_KEYS.length || keys.some((key, index) => key !== SUBMIT_KEYS[index])) return { ok: false, reason: 'shape' };
  const { pilot, lane, recipient } = parsed;
  if (!isPilot(pilot) || !isLane(lane)) return { ok: false, reason: 'shape' };
  if (!isPublicRecipient(recipient)) return { ok: false, reason: 'recipient' };
  return { ok: true, body: { pilot, lane, recipient } };
}

export function backendSubmitBody(body: SubmitBody, ackCapUsd: string): string {
  const f = BACKEND_FIELDS.requestBody;
  return JSON.stringify({
    [f.pilot]: body.pilot,
    [f.lane]: body.lane,
    [f.recipient]: body.recipient,
    [f.ackCapUsd]: ackCapUsd
  });
}

// ---------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------

const NO_STORE = { 'cache-control': 'no-store', 'x-robots-tag': 'noindex' } as const;

export function jsonResponse(status: number, body: unknown, extraHeaders: Record<string, string> = {}): NextResponse {
  return NextResponse.json(body, { status, headers: { ...NO_STORE, ...extraHeaders } });
}

export function errorResponse(mapped: MappedError): NextResponse {
  const extra: Record<string, string> = {};
  if (mapped.body.retryAfterSeconds !== undefined) extra['retry-after'] = String(mapped.body.retryAfterSeconds);
  return jsonResponse(mapped.status, mapped.body, extra);
}

export function apiError(status: number, code: string, message: string): NextResponse {
  return jsonResponse(status, { code, message } satisfies ApiErrorView);
}

/** Response used when the staging feature is off: indistinguishable from a missing route. */
export function stagingNotFound(): Response {
  return new Response('Not Found', {
    status: 404,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

/** Any method a route does not implement: 404 when off, 405 when on. */
export function methodNotAllowed(allow: string): Response {
  if (!v4Enabled()) return stagingNotFound();
  return new Response(null, { status: 405, headers: { allow, 'cache-control': 'no-store' } });
}
