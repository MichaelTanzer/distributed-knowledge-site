'use client';

import { FormEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  ApiErrorView,
  LaneOption,
  LaneValue,
  PilotOption,
  PilotValue,
  RequestState,
  RequestStatusView,
  StagingConfigView,
  SubmitAcceptedView
} from '../../lib/v4Staging';
import { effectiveLane, laneChoices, sanitizeLaneViews, type ConfigLaneView } from '../../lib/v4Lanes';
import { LaneRadios, ProviderSelect, canSubmitForm } from './formParts';

/** Last tracked request id (resumes polling after a reload). */
const STORAGE_KEY = 'dkV4Staging.lastRequestId';
/**
 * Recovery records for submissions whose outcome is not yet known, one per idempotency key, in IndexedDB
 * (database `dkV4Staging`, object store `pending`, out-of-line key = idempotency key, value = JSON string
 * {key, pilot, lane, recipient, createdAt, uncertain, attempts}). IndexedDB, not localStorage: under a Web
 * Lock a tab granted the lock right after another tab's write can read a stale localStorage value
 * (per-process cache), while IndexedDB transactions read committed data. Shown to people as
 * `dkV4Staging.pending.<key>`.
 */
const PENDING_PREFIX = 'dkV4Staging.pending.';
const DB_NAME = 'dkV4Staging';
const DB_VERSION = 1;
const RECORDS_STORE = 'pending';
const PROBE_STORE = 'probe';
/** Cross-tab notice that the records changed (IndexedDB fires no storage event). */
const RECORDS_CHANNEL = 'dkV4Staging.records';
const POLL_INTERVAL_MS = 30_000;
const POLL_TIMEOUT_MS = 15_000;
const MAX_POLL_FAILURES = 10;
const MAX_POLL_WINDOW_MS = 3 * 60 * 60 * 1000;
const TERMINAL_STATES: ReadonlySet<RequestState> = new Set<RequestState>(['delivered', 'failed', 'interrupted']);
/** Automatic polling stops at these states: terminal, or waiting for an operator. */
const STOP_STATES: ReadonlySet<RequestState> = new Set<RequestState>([...TERMINAL_STATES, 'interrupted_unreconciled']);
/** Refusals that depend on the idempotency key itself: the pending submission is kept. */
const KEY_DEPENDENT_CODES: ReadonlySet<string> = new Set(['invalid_idempotency_key', 'idempotency_conflict']);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
/** One origin-wide Web Lock serialises every read-modify-write of the recovery records across tabs. */
const LOCK_NAME = 'dkV4Staging.records';
const LOCK_TIMEOUT_MS = 10_000;
/** Codes generated in the browser (their message comes from COPY, never from a server). */
const CLIENT_CODES: ReadonlySet<string> = new Set([
  'storage_unavailable',
  'lock_unavailable',
  'unresolved_submission',
  'record_missing',
  'record_unreadable',
  'network_error',
  'no_uuid',
  'attempts_exhausted'
]);

type Variant = 'operator' | 'public';

/** Wording per page. The operator page (/v4-staging) keeps its technical copy; /generate is for the public. */
const COPY = {
  operator: {
    storage: "Can't save submission state in this browser; enable site storage to start a paid run.",
    locks: "This browser can't safely coordinate paid runs across tabs; use a current Chrome, Edge, Firefox or Safari.",
    lockUnavailable: 'Could not coordinate with other tabs in time (the submission lock was not granted), so nothing was sent. Try again.',
    unresolved:
      'An earlier submission from this browser has an unknown outcome. Retry it first: it reuses the same request key, so it cannot start a second run. New runs are blocked until it resolves.',
    kept:
      'An earlier attempt of this submission has an unknown outcome, so this answer does not settle it: it stays recorded and keeps blocking new runs. Use “Retry the same submission” later; only an accepted or replayed answer clears it.',
    recordGone:
      "This submission's record is no longer stored (it may have been resolved in another tab), so nothing was sent. Reload the page to see the current state.",
    recordUnreadable:
      "This submission's stored record can't be read safely, so nothing was sent and new runs stay blocked. An operator must check the backend before this browser's site data is cleared.",
    attemptsExhausted:
      "This submission's retry count can't be raised any further, so nothing was sent and new runs stay blocked. An operator must check the backend before this browser's site data is cleared.",
    network:
      'Network error: the outcome is unknown. Use “Retry the same submission”: it reuses the same request key, so the backend cannot start a second run for it.',
    pendingNote: 'Retry the earlier submission first; new runs are blocked until it resolves.',
    badTitle: "Submission record that can't be read safely",
    badNote: "New runs are blocked from this browser. An operator must check the backend before this browser's site data is cleared.",
    pendingTitle: 'Submission with an unknown outcome',
    pendingNoteLong:
      'The backend may already have accepted it. It stays here until it resolves, and new runs are blocked from this browser until then. Retrying sends the same request key and body, so the backend returns the existing run instead of starting a second one.'
  },
  public: {
    storage: "This browser can't save request state; enable site storage to send a request.",
    locks: "This browser can't safely coordinate requests across tabs; please use a current Chrome, Edge, Firefox or Safari.",
    lockUnavailable: 'Could not coordinate with other tabs in time, so nothing was sent. Please try again.',
    unresolved:
      'An earlier request from this browser has an unknown outcome. Retry it first: it reuses the same request key, so it cannot start a second run. New requests are blocked until it resolves.',
    kept:
      'An earlier attempt of this request has an unknown outcome, so this answer does not settle it: it stays recorded and blocks new requests. Use “Retry the same submission” later; only an accepted or replayed answer clears it.',
    recordGone:
      "This request's record is no longer stored (it may have been resolved in another tab), so nothing was sent. Reload the page to see the current state.",
    recordUnreadable:
      "This request's stored record can't be read safely, so nothing was sent and new requests stay blocked. Please contact Distributed Knowledge before clearing this site's data.",
    attemptsExhausted:
      "This request can't be retried from this browser any more, so nothing was sent and new requests stay blocked. Please contact Distributed Knowledge before clearing this site's data.",
    network:
      'Network error: the outcome is unknown. Use “Retry the same submission”: it reuses the same request key, so the backend cannot start a second run for it.',
    pendingNote: 'Retry the earlier request first; new requests are blocked until it resolves.',
    badTitle: "Request record that can't be read safely",
    badNote: "New requests are blocked from this browser. Please contact Distributed Knowledge before clearing this site's data.",
    pendingTitle: 'Request with an unknown outcome',
    pendingNoteLong:
      'It may already have been accepted. It stays here until it resolves, and new requests are blocked from this browser until then. Retrying sends the same request again, so it cannot start a second run.'
  }
} as const;

/** Plain-language notes for backend reason codes (shown under the status). */
const REASON_MESSAGES: ReadonlyMap<string, string> = new Map([
  ['blocked_before_launch', 'Not started: another run was still finishing. No charge.']
]);

const STATE_LABELS: Record<RequestState, string> = {
  queued: 'Queued',
  running: 'Running',
  delivered: 'Delivered',
  failed: 'Failed',
  interrupted: 'Interrupted',
  interrupted_unreconciled: 'Interrupted, needs reconciliation',
  unknown: 'Unknown'
};

type ConfigState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; config: StagingConfigView };

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; error: ApiErrorView };

type PollOutcome = 'ok' | 'error' | 'gone' | 'skipped';

/** What the record layer needs to validate a stored record. */
interface Catalog {
  pilots: PilotOption[];
  lanes: LaneOption[];
  recipientRe: RegExp;
}

interface PendingSubmission {
  key: string;
  pilot: PilotValue;
  lane: LaneValue;
  /** The requester's email (the expert packet goes there); part of the request body the key is bound to. */
  recipient: string;
  createdAt: number;
  /**
   * Written as true before every fetch (the first one too) and never downgraded: a dispatch of this key
   * may be outstanding. Only an answer received for that dispatch, in the page that sent it, can settle it.
   */
  uncertain: boolean;
  /**
   * Dispatches of this key so far, across reloads and tabs (re-read and incremented before each fetch). A
   * definitive key-independent 4xx clears the record only when the answering dispatch was attempt 1 and the
   * stored count is still 1; otherwise only 202 or 200 with replay: true clears it.
   */
  attempts: number;
}

interface TrackedRequest {
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
  checkedAt: number | null;
  pollError: string | null;
  note: string | null;
  /** True when polling must stop for a reason other than the state (backend no longer knows the id). */
  stopped: boolean;
}

interface Props {
  /** `operator`: the Preview-only /v4-staging page. `public`: the v4 form on /generate. */
  variant: Variant;
  pilots: PilotOption[];
  /**
   * Every lane the site knows: recovery records and statuses are read against all of them. The provider choice
   * shows only the lanes the backend config lists (the fallback three while the config is unavailable).
   */
  lanes: LaneOption[];
  requestIdPattern: string;
  /** Same strict single-address pattern the API enforces. */
  recipientPattern: string;
  /** Public variant: wording per server error code (`default` for anything else); no budget figures. */
  errorCopy?: Record<string, string>;
}

function storageGet(key: string): string | null {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function storageSet(key: string, value: string): void {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage unavailable (private mode, blocked site data): kept in memory for this page only.
  }
}

function storageRemove(key: string): void {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Nothing stored or storage unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Result of reading one record slot: "absent", "corrupt" and "storage failed" are never conflated. */
type SlotRead =
  | { kind: 'missing' }
  | { kind: 'ok'; record: PendingSubmission }
  | { kind: 'malformed' }
  | { kind: 'error' };

/**
 * Strict parse: a JSON string with every field present and valid (recipient a single strict address),
 * uncertain === true, attempts a positive safe integer, and the record's key equal to the key of the slot it
 * was read from (otherwise malformed).
 */
function parseRecord(raw: unknown, slotKey: string, catalog: Catalog): PendingSubmission | null {
  if (typeof raw !== 'string') return null;
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { key, pilot, lane, recipient, createdAt, uncertain, attempts } = parsed;
  const pilotOk = catalog.pilots.find((option) => option.value === pilot);
  const laneOk = catalog.lanes.find((option) => option.value === lane);
  if (
    typeof key === 'string' &&
    key === slotKey &&
    UUID_PATTERN.test(key) &&
    pilotOk &&
    laneOk &&
    typeof recipient === 'string' &&
    catalog.recipientRe.test(recipient) &&
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    uncertain === true &&
    typeof attempts === 'number' &&
    Number.isSafeInteger(attempts) &&
    attempts >= 1
  ) {
    return { key, pilot: pilotOk.value, lane: laneOk.value, recipient, createdAt, uncertain: true, attempts };
  }
  return null;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openRecordsDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  const opening = new Promise<IDBDatabase>((resolve, reject) => {
    let request: IDBOpenDBRequest;
    try {
      request = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (error) {
      reject(error);
      return;
    }
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(RECORDS_STORE)) db.createObjectStore(RECORDS_STORE);
      if (!db.objectStoreNames.contains(PROBE_STORE)) db.createObjectStore(PROBE_STORE);
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('indexedDB open blocked'));
  });
  dbPromise = opening;
  opening.catch(() => {
    dbPromise = null;
  });
  return opening;
}

function idbRequest<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Runs `body` in one IndexedDB transaction on `storeName` and resolves after the transaction committed.
 * `body` may only await requests of that transaction. Any error aborts the transaction and rejects.
 */
async function inTransaction<T>(
  storeName: string,
  mode: IDBTransactionMode,
  body: (store: IDBObjectStore) => Promise<T>
): Promise<T> {
  const db = await openRecordsDb();
  const tx = db.transaction(storeName, mode);
  const done = new Promise<void>((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(tx.error ?? new Error('transaction aborted'));
    tx.onerror = () => reject(tx.error ?? new Error('transaction error'));
  });
  done.catch(() => undefined);
  let value: T;
  try {
    value = await body(tx.objectStore(storeName));
  } catch (error) {
    try {
      tx.abort();
    } catch {
      // already finished
    }
    throw error;
  }
  await done;
  return value;
}

async function readSlotIn(store: IDBObjectStore, key: string, catalog: Catalog): Promise<SlotRead> {
  let raw: unknown;
  try {
    raw = await idbRequest(store.get(key));
  } catch {
    return { kind: 'error' };
  }
  if (raw === undefined) return { kind: 'missing' };
  const record = parseRecord(raw, key, catalog);
  return record ? { kind: 'ok', record } : { kind: 'malformed' };
}

/** Puts one record and reads it back inside the same transaction (commit is awaited by the caller). */
async function writeRecordIn(store: IDBObjectStore, record: PendingSubmission): Promise<boolean> {
  const serialized = JSON.stringify(record);
  await idbRequest(store.put(serialized, record.key));
  return (await idbRequest(store.get(record.key))) === serialized;
}

interface PendingScan {
  records: PendingSubmission[];
  /** Slots that are unreadable or malformed (including key/slot mismatch); they block. */
  badSlots: string[];
  /** True when the store itself could not be read; it blocks. */
  error: boolean;
}

async function scanIn(store: IDBObjectStore, catalog: Catalog): Promise<PendingScan> {
  const scan: PendingScan = { records: [], badSlots: [], error: false };
  const keys = await idbRequest(store.getAllKeys());
  const values = await idbRequest(store.getAll());
  keys.forEach((slotKey, index) => {
    const name = PENDING_PREFIX + String(slotKey);
    if (typeof slotKey !== 'string') {
      scan.badSlots.push(name);
      return;
    }
    const record = parseRecord(values[index], slotKey, catalog);
    if (record) scan.records.push(record);
    else scan.badSlots.push(name);
  });
  scan.records.sort((a, b) => a.createdAt - b.createdAt);
  return scan;
}

/** All recovery records (any tab), oldest first, plus malformed slots. Read-only; for display. */
async function scanPending(catalog: Catalog): Promise<PendingScan> {
  try {
    return await inTransaction(RECORDS_STORE, 'readonly', (store) => scanIn(store, catalog));
  } catch {
    return { records: [], badSlots: [], error: true };
  }
}

/** True when IndexedDB opens and accepts a committed write (in a separate probe store). */
async function recordsStoreUsable(): Promise<boolean> {
  try {
    await inTransaction(PROBE_STORE, 'readwrite', async (store) => {
      await idbRequest(store.put(1, 'probe'));
      await idbRequest(store.delete('probe'));
    });
    return true;
  } catch {
    return false;
  }
}

function notifyRecordsChanged(): void {
  try {
    const channel = new BroadcastChannel(RECORDS_CHANNEL);
    channel.postMessage('changed');
    channel.close();
  } catch {
    // No BroadcastChannel: other tabs still re-check inside the lock before any submission.
  }
}

function locksSupported(): boolean {
  try {
    return typeof navigator !== 'undefined' && !!navigator.locks && typeof navigator.locks.request === 'function';
  } catch {
    return false;
  }
}

type Locked<T> = { ok: true; value: T } | { ok: false };

/**
 * Runs `critical` (storage operations only, never a fetch) while holding the origin-wide records lock, so
 * record mutations in all tabs are serialised. Fails closed: no Web Locks, a timeout or an error -> ok:false.
 */
async function withRecordsLock<T>(critical: () => Promise<T>): Promise<Locked<T>> {
  if (!locksSupported()) return { ok: false };
  try {
    const value = (await navigator.locks.request(
      LOCK_NAME,
      { mode: 'exclusive', signal: timeoutSignal(LOCK_TIMEOUT_MS) },
      async () => critical()
    )) as T;
    return { ok: true, value };
  } catch {
    return { ok: false };
  }
}

type Begin =
  | { kind: 'ok'; record: PendingSubmission; attempt: number }
  | { kind: 'unresolved'; scan: PendingScan }
  | { kind: 'missing' }
  | { kind: 'malformed' }
  | { kind: 'exhausted' }
  | { kind: 'storage' };

/**
 * Inside the lock, one readwrite transaction. A genuinely fresh submission: only when no unresolved,
 * malformed or unreadable record exists (checked in the same transaction) is its record written, at attempt 1.
 */
async function beginFreshLocked(fresh: PendingSubmission, catalog: Catalog): Promise<Begin> {
  try {
    return await inTransaction(RECORDS_STORE, 'readwrite', async (store): Promise<Begin> => {
      const scan = await scanIn(store, catalog);
      if (scan.records.length > 0 || scan.badSlots.length > 0) return { kind: 'unresolved', scan };
      const slot = await readSlotIn(store, fresh.key, catalog);
      if (slot.kind === 'error') throw new Error('read failed');
      if (slot.kind !== 'missing') return { kind: 'malformed' };
      const record: PendingSubmission = { ...fresh, uncertain: true, attempts: 1 };
      if (!(await writeRecordIn(store, record))) throw new Error('read-back mismatch');
      return { kind: 'ok', record, attempt: 1 };
    });
  } catch {
    return { kind: 'storage' };
  }
}

/**
 * Inside the lock, one readwrite transaction. A retry continues the stored history: count + 1, uncertain
 * stays true, body from storage. A missing, malformed or unreadable record blocks (never recreated or reset).
 */
async function beginRetryLocked(key: string, catalog: Catalog): Promise<Begin> {
  try {
    return await inTransaction(RECORDS_STORE, 'readwrite', async (store): Promise<Begin> => {
      const slot = await readSlotIn(store, key, catalog);
      if (slot.kind === 'error') throw new Error('read failed');
      if (slot.kind === 'missing') return { kind: 'missing' };
      if (slot.kind === 'malformed') return { kind: 'malformed' };
      // The count must stay a safe integer (the parser rejects anything else): no write, no dispatch.
      if (!(slot.record.attempts + 1 <= Number.MAX_SAFE_INTEGER)) return { kind: 'exhausted' };
      const record: PendingSubmission = { ...slot.record, uncertain: true, attempts: slot.record.attempts + 1 };
      if (!(await writeRecordIn(store, record))) throw new Error('read-back mismatch');
      return { kind: 'ok', record, attempt: record.attempts };
    });
  } catch {
    return { kind: 'storage' };
  }
}

/**
 * Inside the lock. An outcome stayed unknown. The stored record already says uncertain with a count at least
 * this attempt's (only beginRetryLocked raises it), so nothing is rewritten: never a lower count.
 */
async function keepUncertainLocked(key: string, catalog: Catalog): Promise<SlotRead['kind']> {
  try {
    return await inTransaction(RECORDS_STORE, 'readonly', async (store) => (await readSlotIn(store, key, catalog)).kind);
  } catch {
    return 'error';
  }
}

/**
 * Inside the lock, one readwrite transaction. Clears on resolution, deciding from the stored state only:
 * 202 / 200 replay always; a definitive refusal only when this dispatch was attempt 1 and the stored count is
 * still exactly 1.
 */
async function settleLocked(
  key: string,
  attempt: number,
  how: 'accepted' | 'refused',
  catalog: Catalog
): Promise<'cleared' | 'kept' | 'gone' | 'unreadable'> {
  try {
    return await inTransaction(RECORDS_STORE, 'readwrite', async (store) => {
      const slot = await readSlotIn(store, key, catalog);
      if (slot.kind === 'missing') return 'gone' as const;
      if (slot.kind !== 'ok') return 'unreadable' as const;
      if (how === 'accepted' || (attempt === 1 && slot.record.attempts === attempt)) {
        await idbRequest(store.delete(key));
        return 'cleared' as const;
      }
      return 'kept' as const;
    });
  } catch {
    return 'unreadable';
  }
}

/** 15 s abort for one fetch; falls back to a timer where AbortSignal.timeout is missing. */
function timeoutSignal(ms: number): AbortSignal | undefined {
  if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') return AbortSignal.timeout(ms);
  if (typeof AbortController === 'undefined') return undefined;
  const controller = new AbortController();
  window.setTimeout(() => controller.abort(), ms);
  return controller.signal;
}

async function readJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function asApiError(payload: unknown, fallback: string): ApiErrorView {
  if (isRecord(payload) && typeof payload.code === 'string' && typeof payload.message === 'string') {
    const error: ApiErrorView = { code: payload.code, message: payload.message };
    if (typeof payload.retryAfterSeconds === 'number') error.retryAfterSeconds = payload.retryAfterSeconds;
    if (typeof payload.requestId === 'string') error.requestId = payload.requestId;
    return error;
  }
  return { code: 'unexpected_response', message: fallback };
}

/** A 4xx from the staging routes that settles the submission without depending on its key. */
function isDefinitiveRefusal(status: number, error: ApiErrorView): boolean {
  return status >= 400 && status < 500 && error.code !== 'unexpected_response' && !KEY_DEPENDENT_CODES.has(error.code);
}

function isConfigView(payload: unknown): payload is StagingConfigView {
  return isRecord(payload) && typeof payload.spendState === 'string' && isRecord(payload.laneCapsUsd);
}

/**
 * The lanes the backend offers, validated again in the browser with the server's rules (lib/v4Lanes.ts). null
 * while the config is loading or unavailable, or when it has no per-lane data: the legacy three are offered.
 */
function configLanesOf(config: StagingConfigView | null): ConfigLaneView[] | null {
  return config === null ? null : sanitizeLaneViews(config.lanes);
}

function isAcceptedView(payload: unknown, pattern: RegExp): payload is SubmitAcceptedView {
  return isRecord(payload) && typeof payload.requestId === 'string' && pattern.test(payload.requestId);
}

function isStatusView(payload: unknown): payload is RequestStatusView {
  return isRecord(payload) && typeof payload.requestId === 'string' && typeof payload.state === 'string';
}

function parseTime(value: string | null): number | null {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function newTracked(requestId: string, fields: Partial<TrackedRequest> = {}): TrackedRequest {
  return {
    requestId,
    state: 'unknown',
    pilot: null,
    lane: null,
    capUsd: null,
    committedUsd: null,
    reservedUsd: null,
    reasonCode: null,
    admittedAt: null,
    startedAt: null,
    finishedAt: null,
    checkedAt: null,
    pollError: null,
    note: null,
    stopped: false,
    ...fields
  };
}

function formatRetry(seconds: number): string {
  if (seconds < 90) return `${seconds} s`;
  const minutes = Math.ceil(seconds / 60);
  return minutes < 90 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
}

function money(value: string | null): string {
  return value === null ? '—' : `$${value}`;
}

export default function V4StagingForm({ variant, pilots, lanes, requestIdPattern, recipientPattern, errorCopy }: Props) {
  const isPublic = variant === 'public';
  const copy = COPY[variant];
  const idPattern = useMemo(() => new RegExp(requestIdPattern), [requestIdPattern]);
  const catalog = useMemo<Catalog>(() => ({ pilots, lanes, recipientRe: new RegExp(recipientPattern) }), [pilots, lanes, recipientPattern]);
  const [configState, setConfigState] = useState<ConfigState>({ status: 'loading' });
  const [configRefreshing, setConfigRefreshing] = useState(false);
  const [pilot, setPilot] = useState<PilotValue | ''>('');
  const [lane, setLane] = useState<LaneValue | ''>('');
  const [recipient, setRecipient] = useState('');
  const [acknowledged, setAcknowledged] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' });
  const [pendingList, setPendingList] = useState<PendingSubmission[]>([]);
  const [badSlots, setBadSlots] = useState<string[]>([]);
  const [scanError, setScanError] = useState(false);
  /** null until checked on mount; false blocks paid submissions and retries (no cross-tab coordination). */
  const [locksOk, setLocksOk] = useState<boolean | null>(null);
  /** Key of the POST currently in flight from this tab; independent of the editable form fields. */
  const [inFlightKey, setInFlightKey] = useState<string | null>(null);
  const inFlightRef = useRef<string | null>(null);
  /** null until checked on mount; false blocks paid submissions (their key could not be recovered). */
  const [storageOk, setStorageOk] = useState<boolean | null>(null);
  const [tracked, setTracked] = useState<TrackedRequest | null>(null);
  const [pollHalt, setPollHalt] = useState<'errors' | 'time' | null>(null);
  const [pollFailures, setPollFailures] = useState(0);
  const pollImmediatelyRef = useRef(false);
  const pollInFlightRef = useRef(false);
  const pollFailuresRef = useRef(0);
  /** Start of the 3 h automatic-polling window: admission time if known, else tracking start or last resume. */
  const pollWindowRef = useRef<{ localStart: number; admittedMs: number | null; resumed: boolean }>({
    localStart: 0,
    admittedMs: null,
    resumed: false
  });

  const pilotLabel = useCallback(
    (value: PilotValue | null) => pilots.find((option) => option.value === value)?.label ?? '—',
    [pilots]
  );
  const laneOption = useCallback((value: LaneValue | null | '') => lanes.find((option) => option.value === value), [lanes]);

  /** Server error -> text shown. The public page never shows a server message (it could carry figures). */
  const shownError = useCallback(
    (error: ApiErrorView): ApiErrorView => {
      if (!isPublic || !errorCopy || CLIENT_CODES.has(error.code)) return error;
      return { ...error, message: errorCopy[error.code] ?? errorCopy.default ?? 'Something went wrong. Please try again later.' };
    },
    [errorCopy, isPublic]
  );

  const loadConfig = useCallback(async () => {
    setConfigRefreshing(true);
    try {
      const response = await fetch('/api/v4/config', { cache: 'no-store', headers: { accept: 'application/json' } });
      const payload = await readJson(response);
      if (response.ok && isConfigView(payload)) {
        setConfigState({ status: 'ready', config: payload });
      } else {
        const error = shownError(asApiError(payload, `Could not load the staging configuration (HTTP ${response.status}).`));
        setConfigState({ status: 'error', message: error.message });
      }
    } catch {
      setConfigState({
        status: 'error',
        message: isPublic ? 'Generation is temporarily unavailable. Please try again later.' : 'Could not reach the staging configuration endpoint.'
      });
    } finally {
      setConfigRefreshing(false);
    }
  }, [isPublic, shownError]);

  /** One status check, aborted after 15 s; never runs two at once. */
  const pollStatus = useCallback(async (requestId: string): Promise<PollOutcome> => {
    if (pollInFlightRef.current) return 'skipped';
    pollInFlightRef.current = true;
    const update = (fields: Partial<TrackedRequest>) =>
      setTracked((previous) => (previous && previous.requestId === requestId ? { ...previous, ...fields } : previous));
    try {
      const response = await fetch(`/api/v4/requests/${encodeURIComponent(requestId)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' },
        signal: timeoutSignal(POLL_TIMEOUT_MS)
      });
      const payload = await readJson(response);
      if (response.ok && isStatusView(payload)) {
        pollWindowRef.current.admittedMs = parseTime(payload.admittedAt) ?? pollWindowRef.current.admittedMs;
        update({
          state: payload.state,
          pilot: payload.pilot,
          lane: payload.lane,
          capUsd: payload.capUsd,
          committedUsd: payload.committedUsd,
          reservedUsd: payload.reservedUsd,
          reasonCode: payload.reasonCode,
          admittedAt: payload.admittedAt,
          startedAt: payload.startedAt,
          finishedAt: payload.finishedAt,
          checkedAt: Date.now(),
          pollError: null
        });
        return 'ok';
      }
      const error = asApiError(payload, `Status check failed (HTTP ${response.status}).`);
      if (response.status === 404 && error.code === 'not_found') {
        storageRemove(STORAGE_KEY);
        update({ checkedAt: Date.now(), pollError: error.message, stopped: true });
        return 'gone';
      }
      update({ checkedAt: Date.now(), pollError: error.message });
      return 'error';
    } catch (error) {
      const timedOut = error instanceof DOMException && (error.name === 'TimeoutError' || error.name === 'AbortError');
      update({
        checkedAt: Date.now(),
        pollError: timedOut ? 'Status check timed out after 15 s.' : 'Status check failed (network error).'
      });
      return 'error';
    } finally {
      pollInFlightRef.current = false;
    }
  }, []);

  const resetPolling = useCallback((resumed: boolean) => {
    pollFailuresRef.current = 0;
    setPollFailures(0);
    pollWindowRef.current = {
      localStart: Date.now(),
      admittedMs: resumed ? pollWindowRef.current.admittedMs : null,
      resumed
    };
    setPollHalt(null);
  }, []);

  const startTracking = useCallback(
    (requestId: string, fields: Partial<TrackedRequest>, pollNow: boolean) => {
      storageSet(STORAGE_KEY, requestId);
      pollImmediatelyRef.current = pollNow;
      resetPolling(false);
      setTracked(newTracked(requestId, fields));
    },
    [resetPolling]
  );

  // First load: configuration, a request remembered by this browser, and any unresolved submission.
  useEffect(() => {
    void loadConfig();
    const stored = storageGet(STORAGE_KEY);
    if (stored && idPattern.test(stored)) {
      pollImmediatelyRef.current = true;
      resetPolling(false);
      setTracked(newTracked(stored, { note: 'Resumed from the last request made in this browser.' }));
    } else if (stored) {
      storageRemove(STORAGE_KEY);
    }
    void scanPending(catalog).then((scan) => {
      setPendingList(scan.records);
      setBadSlots(scan.badSlots);
      setScanError(scan.error);
    });
    void recordsStoreUsable().then(setStorageOk);
    setLocksOk(locksSupported());
  }, [catalog, idPattern, loadConfig, resetPolling]);

  const applyScan = useCallback((scan: PendingScan) => {
    setPendingList(scan.records);
    setBadSlots(scan.badSlots);
    setScanError(scan.error);
  }, []);
  const refreshPending = useCallback(() => {
    void scanPending(catalog).then(applyScan);
  }, [applyScan, catalog]);

  // Another tab added or resolved a submission: refresh the unresolved list (blocks or unblocks this tab).
  useEffect(() => {
    let channel: BroadcastChannel | null = null;
    try {
      channel = new BroadcastChannel(RECORDS_CHANNEL);
      channel.onmessage = () => refreshPending();
    } catch {
      channel = null;
    }
    return () => channel?.close();
  }, [refreshPending]);

  const activeId = tracked && !tracked.stopped && !STOP_STATES.has(tracked.state) ? tracked.requestId : null;

  // Automatic polling: the next check is scheduled only after the previous one finished. Stops after
  // MAX_POLL_FAILURES consecutive failures or MAX_POLL_WINDOW_MS after admission, whichever comes first.
  useEffect(() => {
    if (!activeId || pollHalt !== null) return;
    let cancelled = false;
    let timer: number | undefined;
    const tick = async () => {
      const outcome = await pollStatus(activeId);
      if (cancelled || outcome === 'gone') return;
      if (outcome === 'error') {
        pollFailuresRef.current += 1;
        setPollFailures(pollFailuresRef.current);
      } else if (outcome === 'ok') {
        pollFailuresRef.current = 0;
        setPollFailures(0);
      }
      if (pollFailuresRef.current >= MAX_POLL_FAILURES) {
        setPollHalt('errors');
        return;
      }
      const window_ = pollWindowRef.current;
      const base = !window_.resumed && window_.admittedMs !== null ? window_.admittedMs : window_.localStart;
      if (Date.now() >= base + MAX_POLL_WINDOW_MS) {
        setPollHalt('time');
        return;
      }
      timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    };
    if (pollImmediatelyRef.current) {
      pollImmediatelyRef.current = false;
      void tick();
    } else {
      timer = window.setTimeout(() => void tick(), POLL_INTERVAL_MS);
    }
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [activeId, pollHalt, pollStatus]);

  // Refresh the configuration once a run stops (terminal or waiting for reconciliation).
  const finishedId = tracked && STOP_STATES.has(tracked.state) ? tracked.requestId : null;
  useEffect(() => {
    if (finishedId) void loadConfig();
  }, [finishedId, loadConfig]);

  const config = configState.status === 'ready' ? configState.config : null;
  /** Lanes the backend offers; null while loading or when the config is unavailable (legacy three offered). */
  const configLanes = useMemo(() => configLanesOf(config), [config]);
  /** Offered providers only; a provider the backend marks unavailable for the selected case is disabled. */
  const choices = laneChoices(lanes, configLanes, pilot);
  /** The selected lane while it is selectable, else '': this is what the controls show and a submission uses. */
  const shownLane = effectiveLane(lane, pilot, configLanes);

  // A selected provider that is no longer offered, or is unavailable for the selected case, is cleared (and stays
  // cleared if the case changes back).
  useEffect(() => {
    if (lane !== '' && shownLane === '') {
      setLane('');
      setAcknowledged(false);
    }
  }, [lane, shownLane]);

  const selectedLane = laneOption(shownLane);
  const backendCap = selectedLane && config ? config.laneCapsUsd[selectedLane.value] ?? null : null;
  const effectiveCap = selectedLane ? backendCap ?? selectedLane.capUsd : null;
  const paused = config?.spendState === 'admission_disabled';
  const reconciliation = config?.reconciliationRequired === true;
  const backendBusy = config?.runInProgress === true;
  const overDaily =
    !isPublic && effectiveCap !== null && config?.dailyRemainingUsd != null && Number(effectiveCap) > Number(config.dailyRemainingUsd);
  const submitting = inFlightKey !== null;
  /** Form controls are locked while a POST is in flight or any submission is unresolved or unreadable. */
  const blockingRecords = pendingList.length > 0 || badSlots.length > 0 || scanError;
  const locked = submitting || blockingRecords;
  const visiblePending = pendingList.filter((record) => record.key !== inFlightKey);
  const trimmedRecipient = recipient.trim();
  const recipientValid = catalog.recipientRe.test(trimmedRecipient);

  const canSubmit = canSubmitForm({
    configReady: config !== null,
    paused,
    reconciliation,
    backendBusy,
    pilot,
    lane: selectedLane?.value ?? '',
    configLanes,
    recipientValid,
    publicVariant: isPublic,
    effectiveCap,
    acknowledged,
    submitting,
    storageOk,
    locksOk,
    blockingRecords,
    activeId
  });

  function showError(code: string, message: string) {
    setSubmitState({ status: 'error', error: { code, message } });
  }

  /**
   * Sends one submission. Under the records lock (storage only) the attempt is recorded: a fresh submission
   * only if nothing unresolved exists, a retry by continuing the stored history (its stored body, including
   * the stored email, never the current form values). The fetch happens outside the lock. Resolution is
   * decided under the lock again, from the stored state only. Nothing is sent when the lock, the storage read
   * or the write-and-read-back fails. There is no way to discard a record.
   */
  async function send(input: { kind: 'fresh'; record: PendingSubmission } | { kind: 'retry'; key: string }) {
    if (inFlightRef.current !== null) return;
    const key = input.kind === 'fresh' ? input.record.key : input.key;
    inFlightRef.current = key;
    setInFlightKey(key);
    setSubmitState({ status: 'submitting' });
    try {
      const locked = await withRecordsLock(() =>
        input.kind === 'fresh' ? beginFreshLocked(input.record, catalog) : beginRetryLocked(input.key, catalog)
      );
      if (locked.ok && locked.value.kind === 'ok') notifyRecordsChanged();
      if (!locked.ok) {
        showError('lock_unavailable', locksSupported() ? copy.lockUnavailable : copy.locks);
        return;
      }
      const begun = locked.value;
      if (begun.kind === 'unresolved') {
        applyScan(begun.scan);
        showError('unresolved_submission', copy.unresolved);
        return;
      }
      if (begun.kind === 'missing') {
        showError('record_missing', copy.recordGone);
        return;
      }
      if (begun.kind === 'malformed') {
        showError('record_unreadable', copy.recordUnreadable);
        return;
      }
      if (begun.kind === 'exhausted') {
        showError('attempts_exhausted', copy.attemptsExhausted);
        return;
      }
      if (begun.kind === 'storage') {
        setStorageOk(false);
        showError('storage_unavailable', copy.storage);
        return;
      }
      refreshPending();
      await dispatch(begun.record, begun.attempt);
    } finally {
      inFlightRef.current = null;
      setInFlightKey(null);
      refreshPending();
    }
  }

  async function dispatch(submission: PendingSubmission, attempt: number) {
    let response: Response;
    try {
      response = await fetch('/api/v4/requests', {
        method: 'POST',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': submission.key },
        body: JSON.stringify({ pilot: submission.pilot, lane: submission.lane, recipient: submission.recipient })
      });
    } catch {
      await withRecordsLock(() => keepUncertainLocked(submission.key, catalog));
      showError('network_error', copy.network);
      return;
    }

    const payload = await readJson(response);
    const accepted = isAcceptedView(payload, idPattern) ? payload : null;
    if (accepted && (response.status === 202 || (response.status === 200 && accepted.replay === true))) {
      // The key's outcome is established. If the lock is not granted the record simply stays (safe).
      const settled = await withRecordsLock(() => settleLocked(submission.key, attempt, 'accepted', catalog));
      if (settled.ok && settled.value === 'cleared') notifyRecordsChanged();
      startTracking(
        accepted.requestId,
        {
          state: accepted.state,
          pilot: submission.pilot,
          lane: submission.lane,
          capUsd: accepted.capUsd,
          note: accepted.replay ? 'Recognised as a replay of your earlier submission (no second run).' : null
        },
        false
      );
      setAcknowledged(false);
      setSubmitState({ status: 'idle' });
      void loadConfig();
      return;
    }

    const error = shownError(
      asApiError(payload, `The request failed (HTTP ${response.status}). The outcome is unknown; retry the same submission.`)
    );
    // The backend no longer offers this lane or this lane/case pair: reload its list so the choice updates.
    if (error.code === 'lane_pilot_unavailable' || error.code === 'lane_unavailable') void loadConfig();
    const outcomeUnknown = response.status >= 500 || error.code === 'unexpected_response' || response.ok;
    if (outcomeUnknown) {
      // 5xx, unreadable or unexpected answer: this dispatch's outcome is unknown too.
      await withRecordsLock(() => keepUncertainLocked(submission.key, catalog));
      setSubmitState({ status: 'error', error });
      return;
    }
    const isDuplicate = error.code === 'duplicate' && !!error.requestId && idPattern.test(error.requestId);
    const definitive = isDefinitiveRefusal(response.status, error);
    let cleared = false;
    if (definitive || isDuplicate) {
      const settled = await withRecordsLock(() => settleLocked(submission.key, attempt, 'refused', catalog));
      cleared = settled.ok && (settled.value === 'cleared' || settled.value === 'gone');
      if (settled.ok && settled.value === 'cleared') notifyRecordsChanged();
    }
    if (isDuplicate && cleared && error.requestId) {
      startTracking(error.requestId, { pilot: submission.pilot, lane: submission.lane, note: error.message }, true);
      setSubmitState({ status: 'idle' });
      return;
    }
    if (cleared) {
      // The key's only dispatch, answer received in this page, stored count still 1: the refusal settles it.
      setSubmitState({ status: 'error', error });
      return;
    }
    // Other attempts exist, the refusal depends on the key, or the lock was not granted: keep, keep blocking.
    const kept = definitive || attempt > 1;
    setSubmitState({ status: 'error', error: kept ? { ...error, message: `${error.message} ${copy.kept}` } : error });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current !== null) return;
    // canSubmit already implies a selected pilot and a selectable lane (`pilot === ''` is repeated for TypeScript).
    // The authoritative "nothing unresolved exists" check runs again inside the records lock (beginFreshLocked).
    if (!canSubmit || !selectedLane || pilot === '') return;
    if (typeof crypto === 'undefined' || typeof crypto.randomUUID !== 'function') {
      showError('no_uuid', 'This browser cannot generate a request key.');
      return;
    }
    await send({
      kind: 'fresh',
      record: {
        key: crypto.randomUUID(),
        pilot,
        lane: selectedLane.value,
        recipient: trimmedRecipient,
        createdAt: Date.now(),
        uncertain: true,
        attempts: 1
      }
    });
  }

  function retryPending(record: PendingSubmission) {
    if (inFlightRef.current === null && locksOk === true) void send({ kind: 'retry', key: record.key });
  }

  function dismissTracked() {
    storageRemove(STORAGE_KEY);
    setTracked(null);
    setPollHalt(null);
  }

  function resumePolling() {
    pollImmediatelyRef.current = true;
    resetPolling(true);
  }

  const submitError = submitState.status === 'error' ? submitState.error : null;
  const trackedLane = tracked ? laneOption(tracked.lane) : undefined;
  const pollingActive = activeId !== null && pollHalt === null;
  const stateLabel = (state: RequestState) =>
    isPublic && state === 'interrupted_unreconciled' ? STATE_LABELS.interrupted : STATE_LABELS[state];

  const availability = (
    <>
      {configState.status === 'loading' && <p className="v4s-muted">{isPublic ? 'Loading…' : 'Loading staging configuration…'}</p>}
      {configState.status === 'error' && <p className="notice error">{configState.message}</p>}
      {isPublic && paused && <p className="notice error v4s-availability">Generation is paused right now. Please try again later.</p>}
      {isPublic && reconciliation && (
        <p className="notice error v4s-availability">Generation is temporarily unavailable. Please try again later.</p>
      )}
      {isPublic && backendBusy && activeId === null && (
        <p className="notice error v4s-availability">
          Another request is being generated right now (runs take 20–70 minutes). Please try again later.
        </p>
      )}
    </>
  );

  const recordPanels = (
    <>
      {(badSlots.length > 0 || scanError) && (
        <section aria-label="Unreadable submission record" className="v4s-pending v4s-bad">
          <h2 className="v4s-label">{copy.badTitle}</h2>
          <p className="v4s-message">
            {scanError
              ? 'Stored records could not be read.'
              : `Unreadable or mismatched record${badSlots.length > 1 ? 's' : ''}: ${badSlots.join(', ')}`}
          </p>
          <p className="v4s-muted">{copy.badNote}</p>
        </section>
      )}
      {visiblePending.map((record) => {
        const recordLane = laneOption(record.lane);
        return (
          <section
            aria-label="Unresolved submission"
            className="v4s-pending"
            data-attempts={record.attempts}
            data-key={record.key}
            key={record.key}
          >
            <h2 className="v4s-label">{copy.pendingTitle}</h2>
            <p className="v4s-message">
              {pilotLabel(record.pilot)} · {recordLane ? `${recordLane.provider} · ${recordLane.model}` : record.lane} · for{' '}
              {record.recipient} · first sent {new Date(record.createdAt).toLocaleString()}
            </p>
            <p className="v4s-muted">{copy.pendingNoteLong}</p>
            <div className="v4s-actions">
              <button className="v4s-link" disabled={submitting || locksOk !== true} onClick={() => retryPending(record)} type="button">
                Retry the same submission
              </button>
            </div>
          </section>
        );
      })}
    </>
  );

  const recipientField = (
    <label className="v4s-field" htmlFor="v4s-recipient">
      <span className="v4s-label">{isPublic ? 'Your email' : 'Recipient'}</span>
      <input
        autoComplete="email"
        disabled={locked}
        id="v4s-recipient"
        inputMode="email"
        maxLength={254}
        onChange={(event) => {
          if (locked || inFlightRef.current !== null) return;
          setRecipient(event.target.value);
          setSubmitState({ status: 'idle' });
        }}
        placeholder="Your email address"
        required
        type="email"
        value={recipient}
      />
      {trimmedRecipient !== '' && !recipientValid && (
        <span className="notice error v4s-recipient-hint">
          Enter one email address: only letters, digits and . _ % + - before the domain (not starting with - or .), and no
          spaces, commas or other punctuation.
        </span>
      )}
      <span className="v4s-muted">
        {isPublic
          ? 'The expert packet is emailed to this address.'
          : 'The expert packet is emailed here; the internal packet and notices go to the operator only.'}
      </span>
    </label>
  );

  const pilotDescription = pilots.find((option) => option.value === pilot)?.description;
  const pilotField = (
    <div className="v4s-kiq">
      <label className="v4s-field" htmlFor="v4s-pilot">
        <span className="v4s-label">{isPublic ? 'KIQ' : 'Pilot'}</span>
        <select
          aria-describedby="v4s-pilot-description"
          disabled={locked}
          id="v4s-pilot"
          onChange={(event) => {
            if (locked || inFlightRef.current !== null) return;
            setPilot(event.target.value as PilotValue | '');
            setSubmitState({ status: 'idle' });
          }}
          required
          value={pilot}
        >
          <option value="">{isPublic ? 'Select a KIQ' : 'Select a pilot'}</option>
          {pilots.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </label>
      {/* Outside the label so it describes the select instead of becoming part of its name. */}
      <div aria-live="polite" className="v4s-case" data-pilot={pilotDescription ? pilot : ''} id="v4s-pilot-description">
        {pilotDescription && (
          <>
            <p className="v4s-case-title">{pilotDescription.title}</p>
            <p className="v4s-case-summary">{pilotDescription.summary}</p>
          </>
        )}
      </div>
    </div>
  );

  const statusPanel = tracked && (
    <section aria-live="polite" className="v4s-status">
      <h2 className="v4s-label">{isPublic ? 'Your request' : 'Request status'}</h2>
      {tracked.note && <p className="v4s-muted">{tracked.note}</p>}
      <dl className="v4s-facts">
        <div>
          <dt>Request id</dt>
          <dd>
            <code>{tracked.requestId}</code>
          </dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            <span className={`v4s-state v4s-state-${tracked.state}`}>{stateLabel(tracked.state)}</span>
          </dd>
        </div>
        <div>
          <dt>{isPublic ? 'KIQ' : 'Pilot'}</dt>
          <dd>{pilotLabel(tracked.pilot)}</dd>
        </div>
        <div>
          <dt>{isPublic ? 'Provider' : 'Lane'}</dt>
          <dd>{trackedLane ? `${trackedLane.provider} · ${trackedLane.model}` : '—'}</dd>
        </div>
        {!isPublic && (
          <div>
            <dt>Committed</dt>
            <dd>
              {money(tracked.committedUsd)}
              {tracked.capUsd !== null && <> (reservation cap {money(tracked.capUsd)})</>}
            </dd>
          </div>
        )}
        {!isPublic && tracked.reservedUsd !== null && activeId !== null && (
          <div>
            <dt>Reserved</dt>
            <dd>{money(tracked.reservedUsd)}</dd>
          </div>
        )}
        {!isPublic && (
          <div>
            <dt>Reason code</dt>
            <dd>{tracked.reasonCode ?? '—'}</dd>
          </div>
        )}
        {tracked.admittedAt && (
          <div>
            <dt>{isPublic ? 'Accepted' : 'Admitted'}</dt>
            <dd>{tracked.admittedAt}</dd>
          </div>
        )}
        {tracked.startedAt && (
          <div>
            <dt>Started</dt>
            <dd>{tracked.startedAt}</dd>
          </div>
        )}
        {tracked.finishedAt && (
          <div>
            <dt>Finished</dt>
            <dd>{tracked.finishedAt}</dd>
          </div>
        )}
        <div>
          <dt>Last checked</dt>
          <dd>
            {tracked.checkedAt ? new Date(tracked.checkedAt).toLocaleTimeString() : 'not yet'}
            {pollingActive && ' · checks every 30 s'}
          </dd>
        </div>
      </dl>
      {tracked.state === 'running' && trackedLane && (
        <p className="v4s-muted">Typical runtime for this {isPublic ? 'provider' : 'lane'}: {trackedLane.typicalRuntime}.</p>
      )}
      {isPublic && tracked.state === 'delivered' && <p className="v4s-muted">The expert packet has been emailed to you.</p>}
      {tracked.reasonCode && REASON_MESSAGES.has(tracked.reasonCode) && (
        <p className="v4s-muted v4s-reason">{REASON_MESSAGES.get(tracked.reasonCode)}</p>
      )}
      {tracked.state === 'interrupted_unreconciled' && (
        <p className="notice error">
          {isPublic
            ? 'This request was interrupted. Distributed Knowledge will follow up.'
            : 'Needs operator reconciliation; no further runs can start until it is resolved.'}
        </p>
      )}
      {tracked.pollError && (
        <p className="notice error">
          {tracked.pollError}
          {pollingActive && pollFailures > 0 && ` Retrying in 30 s (failure ${pollFailures} of ${MAX_POLL_FAILURES}).`}
        </p>
      )}
      {pollHalt === 'errors' && (
        <p className="notice error">Automatic status checks stopped after {MAX_POLL_FAILURES} failed checks in a row.</p>
      )}
      {pollHalt === 'time' && (
        <p className="notice error">Automatic status checks stopped 3 hours after the request was admitted.</p>
      )}
      <div className="v4s-actions">
        {activeId !== null && pollHalt !== null && (
          <button className="v4s-link" onClick={resumePolling} type="button">
            Resume status checks
          </button>
        )}
        {(pollingActive || tracked.state === 'interrupted_unreconciled') && (
          <button className="v4s-link" onClick={() => void pollStatus(tracked.requestId)} type="button">
            Check now
          </button>
        )}
        {!pollingActive && (
          <button className="v4s-link" onClick={dismissTracked} type="button">
            Dismiss
          </button>
        )}
      </div>
    </section>
  );

  const errorBox = submitError && (
    <div className="notice error" role="alert">
      <p className="v4s-message">{submitError.message}</p>
      {submitError.retryAfterSeconds !== undefined && (
        <p className="v4s-message">Retry after about {formatRetry(submitError.retryAfterSeconds)}.</p>
      )}
      {submitError.code === 'run_in_progress' && submitError.requestId && idPattern.test(submitError.requestId) && !tracked && (
        <button
          className="v4s-link"
          onClick={() => {
            if (submitError.requestId) startTracking(submitError.requestId, {}, true);
            setSubmitState({ status: 'idle' });
          }}
          type="button"
        >
          Show the run in progress
        </button>
      )}
    </div>
  );

  const blockedNotes = (
    <>
      {storageOk === false && <p className="notice error">{copy.storage}</p>}
      {locksOk === false && <p className="notice error v4s-locks">{copy.locks}</p>}
      {visiblePending.length > 0 && <p className="v4s-muted">{copy.pendingNote}</p>}
      {activeId !== null && (
        <p className="v4s-muted">
          {isPublic ? 'Your request is being tracked below.' : 'A run is being tracked below; submit again when it has finished.'}
        </p>
      )}
    </>
  );

  if (isPublic) {
    return (
      <main className="generate-shell">
        <div className="v4s-panel">
          <img alt="DK Team" className="generate-image" src="/assets/dk-team.jpg" />
          <p className="v4s-notice">
            DK v4 technical preview: packets are technical-trial output with some placeholder names; the expert packet is
            emailed to you.
          </p>
          {availability}
          {recordPanels}
          <form className="v4s-form" data-config={configState.status} onSubmit={submit}>
            {recipientField}
            {pilotField}
            <ProviderSelect
              choices={choices}
              disabled={locked}
              onSelect={(value) => {
                if (locked || inFlightRef.current !== null) return;
                setLane(value);
                setSubmitState({ status: 'idle' });
              }}
              value={shownLane}
            />
            <button className="v4s-submit" disabled={!canSubmit} type="submit">
              {submitting ? 'Sending…' : 'Generate'}
            </button>
            {blockedNotes}
            {errorBox}
          </form>
          {statusPanel}
        </div>
      </main>
    );
  }

  return (
    <main className="generate-shell">
      <div className="v4s-panel">
        <header className="v4s-header">
          <h1 className="v4s-title">DK v4 staging</h1>
          <p className="v4s-sub">Technical trial on a protected Preview. Output is not approved content.</p>
        </header>

        <section aria-label="Staging budget" className="v4s-budget">
          {availability}
          {config && (
            <dl className="v4s-facts">
              <div>
                <dt>Today (UTC{config.dayUtc ? ` ${config.dayUtc}` : ''})</dt>
                <dd>
                  {money(config.dailyRemainingUsd)} remaining
                  {config.dailyCapUsd !== null && <> of {money(config.dailyCapUsd)}</>}
                </dd>
              </div>
              <div>
                <dt>Staging total</dt>
                <dd>
                  {money(config.totalRemainingUsd)} remaining
                  {config.totalCapUsd !== null && <> of {money(config.totalCapUsd)}</>}
                </dd>
              </div>
              <div>
                <dt>New runs</dt>
                <dd>
                  {config.spendState === 'enabled' && 'Accepted'}
                  {config.spendState === 'admission_disabled' && <strong className="v4s-warn">New runs are paused</strong>}
                  {config.spendState === 'unknown' && 'Unknown'}
                </dd>
              </div>
            </dl>
          )}
          {paused && <p className="v4s-muted">A run already in progress keeps going until it finishes or times out.</p>}
          {reconciliation && (
            <p className="notice error">An earlier run needs operator reconciliation, so no new runs are accepted until then.</p>
          )}
          {backendBusy && activeId === null && (
            <p className="v4s-muted">A staging run is in progress on the backend; submit again when it has finished.</p>
          )}
          <button className="v4s-link" disabled={configRefreshing} onClick={() => void loadConfig()} type="button">
            {configRefreshing ? 'Refreshing…' : 'Refresh budget'}
          </button>
        </section>

        {recordPanels}

        <form className="v4s-form" data-config={configState.status} onSubmit={submit}>
          {pilotField}

          <LaneRadios
            caps={config?.laneCapsUsd ?? {}}
            choices={choices}
            disabled={locked}
            onSelect={(value) => {
              if (locked || inFlightRef.current !== null) return;
              setLane(value);
              setAcknowledged(false);
              setSubmitState({ status: 'idle' });
            }}
            value={shownLane}
          />

          {recipientField}

          {overDaily && (
            <p className="notice error">
              This lane&apos;s reservation cap is above today&apos;s remaining budget, so the backend will probably refuse it until
              00:00 UTC.
            </p>
          )}

          <label className="v4s-ack">
            <input
              checked={acknowledged}
              disabled={effectiveCap === null || locked}
              onChange={(event) => {
                if (!locked) setAcknowledged(event.target.checked);
              }}
              type="checkbox"
            />
            <span>
              {effectiveCap === null
                ? 'Select a lane to see its reservation cap.'
                : `I understand that this run reserves up to $${effectiveCap} of metered API budget before calls are made (worst case per call), and that actual billed usage can exceed the reservation in rare cases.`}
            </span>
          </label>

          <button className="v4s-submit" disabled={!canSubmit} type="submit">
            {submitting ? 'Submitting…' : 'Start run'}
          </button>

          {blockedNotes}
          {errorBox}

          <p className="v4s-muted v4s-footnote">
            Reservation caps are enforced on worst-case reservations made before each provider call; they are not a hard
            maximum. Settlement uses actual usage, so in rare cases a run can bill more than its reservation cap and a day can
            end slightly above the daily ceiling; further runs are then refused.
          </p>
        </form>

        {statusPanel}
      </div>
    </main>
  );
}
