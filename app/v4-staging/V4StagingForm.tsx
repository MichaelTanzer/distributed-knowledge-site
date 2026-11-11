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

/** Last tracked request id (resumes polling after a reload). */
const STORAGE_KEY = 'dkV4Staging.lastRequestId';
/**
 * Recovery records for submissions whose outcome is not yet known, one per idempotency key:
 * `dkV4Staging.pending.<key>` = {key, pilot, lane, ack_cap_usd, createdAt}. A record is written (and
 * read back) before its POST leaves and is removed only when that submission resolves. Records of
 * other tabs are never overwritten or removed.
 */
const PENDING_PREFIX = 'dkV4Staging.pending.';
/** Added to a refusal's message when the record is kept because an earlier attempt's outcome is unknown. */
const UNCERTAIN_KEPT_MESSAGE =
  'An earlier attempt of this submission has an unknown outcome, so this answer does not settle it: it stays recorded and keeps blocking new runs. Use “Retry the same submission” later; only an accepted or replayed answer clears it.';
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
const STORAGE_REQUIRED_MESSAGE = "Can't save submission state in this browser; enable site storage to start a paid run.";
/** One origin-wide Web Lock serialises every read-modify-write of the recovery records across tabs. */
const LOCK_NAME = 'dkV4Staging.records';
const LOCK_TIMEOUT_MS = 10_000;
const LOCKS_MESSAGE = "This browser can't safely coordinate paid runs across tabs; use a current Chrome, Edge, Firefox or Safari.";
const LOCK_UNAVAILABLE_MESSAGE =
  'Could not coordinate with other tabs in time (the submission lock was not granted), so nothing was sent. Try again.';
const RECORD_GONE_MESSAGE =
  "This submission's record is no longer stored (it may have been resolved in another tab), so nothing was sent. Reload the page to see the current state.";
const RECORD_UNREADABLE_MESSAGE =
  "This submission's stored record can't be read safely, so nothing was sent and new runs stay blocked. An operator must check the backend before this browser's site data is cleared.";
const UNRESOLVED_MESSAGE =
  'An earlier submission from this browser has an unknown outcome. Retry it first: it reuses the same request key, so it cannot start a second run. New runs are blocked until it resolves.';
const ACK_PATTERN = /^\d{1,4}\.\d{2}$/;

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

interface PendingSubmission {
  key: string;
  pilot: PilotValue;
  lane: LaneValue;
  ack_cap_usd: string;
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
  pilots: PilotOption[];
  lanes: LaneOption[];
  requestIdPattern: string;
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

/** True when localStorage accepts a write that reads back unchanged. */
function storageWritable(): boolean {
  try {
    const probe = 'dkV4Staging.probe';
    window.localStorage.setItem(probe, '1');
    const ok = window.localStorage.getItem(probe) === '1';
    window.localStorage.removeItem(probe);
    return ok;
  } catch {
    return false;
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
 * Strict parse: every field present and valid, uncertain === true, attempts a positive safe integer, and the
 * record's key equal to the key of the slot it was read from (otherwise the slot is malformed).
 */
function parseRecord(raw: string, slotKey: string, pilots: PilotOption[], lanes: LaneOption[]): PendingSubmission | null {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  const { key, pilot, lane, ack_cap_usd: ack, createdAt, uncertain, attempts } = parsed;
  const pilotOk = pilots.find((option) => option.value === pilot);
  const laneOk = lanes.find((option) => option.value === lane);
  if (
    typeof key === 'string' &&
    key === slotKey &&
    UUID_PATTERN.test(key) &&
    pilotOk &&
    laneOk &&
    typeof ack === 'string' &&
    ACK_PATTERN.test(ack) &&
    typeof createdAt === 'number' &&
    Number.isFinite(createdAt) &&
    uncertain === true &&
    typeof attempts === 'number' &&
    Number.isSafeInteger(attempts) &&
    attempts >= 1
  ) {
    return { key, pilot: pilotOk.value, lane: laneOk.value, ack_cap_usd: ack, createdAt, uncertain: true, attempts };
  }
  return null;
}

function readSlot(key: string, pilots: PilotOption[], lanes: LaneOption[]): SlotRead {
  let raw: string | null;
  try {
    raw = window.localStorage.getItem(PENDING_PREFIX + key);
  } catch {
    return { kind: 'error' };
  }
  if (raw === null) return { kind: 'missing' };
  const record = parseRecord(raw, key, pilots, lanes);
  return record ? { kind: 'ok', record } : { kind: 'malformed' };
}

/** Writes one record and confirms it reads back byte-for-byte. Call only inside the records lock. */
function writeVerified(record: PendingSubmission): boolean {
  const serialized = JSON.stringify(record);
  try {
    window.localStorage.setItem(PENDING_PREFIX + record.key, serialized);
    return window.localStorage.getItem(PENDING_PREFIX + record.key) === serialized;
  } catch {
    return false;
  }
}

function removeSlot(key: string): boolean {
  try {
    window.localStorage.removeItem(PENDING_PREFIX + key);
    return true;
  } catch {
    return false;
  }
}

interface PendingScan {
  records: PendingSubmission[];
  /** Slots under the prefix that are unreadable or malformed (including key/slot mismatch); they block. */
  badSlots: string[];
  /** True when storage itself could not be read; it blocks. */
  error: boolean;
}

/** All recovery records in this browser (any tab), oldest first, plus any malformed slots. Read-only. */
function scanPending(pilots: PilotOption[], lanes: LaneOption[]): PendingScan {
  const scan: PendingScan = { records: [], badSlots: [], error: false };
  const names: string[] = [];
  try {
    const storage = window.localStorage;
    for (let index = 0; index < storage.length; index += 1) {
      const name = storage.key(index);
      if (name && name.startsWith(PENDING_PREFIX)) names.push(name);
    }
  } catch {
    scan.error = true;
    return scan;
  }
  for (const name of names) {
    const slot = readSlot(name.slice(PENDING_PREFIX.length), pilots, lanes);
    if (slot.kind === 'ok') scan.records.push(slot.record);
    else if (slot.kind === 'malformed') scan.badSlots.push(name);
    else if (slot.kind === 'error') scan.error = true;
  }
  scan.records.sort((a, b) => a.createdAt - b.createdAt);
  return scan;
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
async function withRecordsLock<T>(critical: () => T): Promise<Locked<T>> {
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
  | { kind: 'storage' };

/**
 * Inside the lock. A genuinely fresh submission: only when no unresolved, malformed or unreadable record
 * exists (checked in the same critical section) is its record written, at attempt 1.
 */
function beginFreshLocked(fresh: PendingSubmission, pilots: PilotOption[], lanes: LaneOption[]): Begin {
  const scan = scanPending(pilots, lanes);
  if (scan.error) return { kind: 'storage' };
  if (scan.records.length > 0 || scan.badSlots.length > 0) return { kind: 'unresolved', scan };
  const slot = readSlot(fresh.key, pilots, lanes);
  if (slot.kind === 'error') return { kind: 'storage' };
  if (slot.kind !== 'missing') return { kind: 'malformed' };
  const record: PendingSubmission = { ...fresh, uncertain: true, attempts: 1 };
  return writeVerified(record) ? { kind: 'ok', record, attempt: 1 } : { kind: 'storage' };
}

/**
 * Inside the lock. A retry continues the stored history: count + 1, uncertain stays true, body from storage.
 * A missing, malformed or unreadable record blocks (it is never recreated or reset).
 */
function beginRetryLocked(key: string, pilots: PilotOption[], lanes: LaneOption[]): Begin {
  const slot = readSlot(key, pilots, lanes);
  if (slot.kind === 'error') return { kind: 'storage' };
  if (slot.kind === 'missing') return { kind: 'missing' };
  if (slot.kind === 'malformed') return { kind: 'malformed' };
  const record: PendingSubmission = { ...slot.record, uncertain: true, attempts: slot.record.attempts + 1 };
  return writeVerified(record) ? { kind: 'ok', record, attempt: record.attempts } : { kind: 'storage' };
}

/**
 * Inside the lock. An outcome stayed unknown. The stored record already says uncertain with a count at least
 * this attempt's (only beginRetryLocked raises it), so nothing is rewritten: never a lower count.
 */
function keepUncertainLocked(key: string, pilots: PilotOption[], lanes: LaneOption[]): SlotRead['kind'] {
  return readSlot(key, pilots, lanes).kind;
}

/**
 * Inside the lock. Clears on resolution, deciding from the stored state only: 202 / 200 replay always; a
 * definitive refusal only when this dispatch was attempt 1 and the stored count is still exactly 1.
 */
function settleLocked(
  key: string,
  attempt: number,
  how: 'accepted' | 'refused',
  pilots: PilotOption[],
  lanes: LaneOption[]
): 'cleared' | 'kept' | 'gone' | 'unreadable' {
  const slot = readSlot(key, pilots, lanes);
  if (slot.kind === 'missing') return 'gone';
  if (slot.kind !== 'ok') return 'unreadable';
  if (how === 'accepted' || (attempt === 1 && slot.record.attempts === attempt)) return removeSlot(key) ? 'cleared' : 'unreadable';
  return 'kept';
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

export default function V4StagingForm({ pilots, lanes, requestIdPattern }: Props) {
  const idPattern = useMemo(() => new RegExp(requestIdPattern), [requestIdPattern]);
  const [configState, setConfigState] = useState<ConfigState>({ status: 'loading' });
  const [configRefreshing, setConfigRefreshing] = useState(false);
  const [pilot, setPilot] = useState<PilotValue | ''>('');
  const [lane, setLane] = useState<LaneValue | ''>('');
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

  const loadConfig = useCallback(async () => {
    setConfigRefreshing(true);
    try {
      const response = await fetch('/api/v4/config', { cache: 'no-store', headers: { accept: 'application/json' } });
      const payload = await readJson(response);
      if (response.ok && isConfigView(payload)) {
        setConfigState({ status: 'ready', config: payload });
      } else {
        const error = asApiError(payload, `Could not load the staging configuration (HTTP ${response.status}).`);
        setConfigState({ status: 'error', message: error.message });
      }
    } catch {
      setConfigState({ status: 'error', message: 'Could not reach the staging configuration endpoint.' });
    } finally {
      setConfigRefreshing(false);
    }
  }, []);

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
    const scan = scanPending(pilots, lanes);
    setPendingList(scan.records);
    setBadSlots(scan.badSlots);
    setScanError(scan.error);
    setStorageOk(storageWritable());
    setLocksOk(locksSupported());
  }, [idPattern, lanes, loadConfig, pilots, resetPolling]);

  const applyScan = useCallback((scan: PendingScan) => {
    setPendingList(scan.records);
    setBadSlots(scan.badSlots);
    setScanError(scan.error);
  }, []);
  const refreshPending = useCallback(() => applyScan(scanPending(pilots, lanes)), [applyScan, lanes, pilots]);

  // Another tab added or resolved a submission: refresh the unresolved list (blocks or unblocks this tab).
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key.startsWith(PENDING_PREFIX)) refreshPending();
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
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

  // Refresh the budget once a run stops (terminal or waiting for reconciliation).
  const finishedId = tracked && STOP_STATES.has(tracked.state) ? tracked.requestId : null;
  useEffect(() => {
    if (finishedId) void loadConfig();
  }, [finishedId, loadConfig]);

  const config = configState.status === 'ready' ? configState.config : null;
  const selectedLane = laneOption(lane);
  const backendCap = selectedLane && config ? config.laneCapsUsd[selectedLane.value] ?? null : null;
  const effectiveCap = selectedLane ? backendCap ?? selectedLane.capUsd : null;
  const paused = config?.spendState === 'admission_disabled';
  const reconciliation = config?.reconciliationRequired === true;
  const backendBusy = config?.runInProgress === true;
  const overDaily =
    effectiveCap !== null && config?.dailyRemainingUsd != null && Number(effectiveCap) > Number(config.dailyRemainingUsd);
  const submitting = inFlightKey !== null;
  /** Form controls are locked while a POST is in flight or any submission is unresolved or unreadable. */
  const blockingRecords = pendingList.length > 0 || badSlots.length > 0 || scanError;
  const locked = submitting || blockingRecords;
  const visiblePending = pendingList.filter((record) => record.key !== inFlightKey);

  const canSubmit =
    config !== null &&
    config.recipient !== null &&
    !paused &&
    !reconciliation &&
    !backendBusy &&
    pilot !== '' &&
    selectedLane !== undefined &&
    effectiveCap !== null &&
    acknowledged &&
    !submitting &&
    storageOk === true &&
    locksOk === true &&
    !blockingRecords &&
    activeId === null;

  function showError(code: string, message: string) {
    setSubmitState({ status: 'error', error: { code, message } });
  }

  /**
   * Sends one submission. Under the records lock (storage only) the attempt is recorded: a fresh submission
   * only if nothing unresolved exists, a retry by continuing the stored history. The fetch happens outside
   * the lock. Resolution is decided under the lock again, from the stored state only. Nothing is sent when
   * the lock, the storage read or the write-and-read-back fails. There is no way to discard a record.
   */
  async function send(input: { kind: 'fresh'; record: PendingSubmission } | { kind: 'retry'; key: string }) {
    if (inFlightRef.current !== null) return;
    const key = input.kind === 'fresh' ? input.record.key : input.key;
    inFlightRef.current = key;
    setInFlightKey(key);
    setSubmitState({ status: 'submitting' });
    try {
      const locked = await withRecordsLock(() =>
        input.kind === 'fresh' ? beginFreshLocked(input.record, pilots, lanes) : beginRetryLocked(input.key, pilots, lanes)
      );
      if (!locked.ok) {
        showError('lock_unavailable', locksSupported() ? LOCK_UNAVAILABLE_MESSAGE : LOCKS_MESSAGE);
        return;
      }
      const begun = locked.value;
      if (begun.kind === 'unresolved') {
        applyScan(begun.scan);
        showError('unresolved_submission', UNRESOLVED_MESSAGE);
        return;
      }
      if (begun.kind === 'missing') {
        showError('record_missing', RECORD_GONE_MESSAGE);
        return;
      }
      if (begun.kind === 'malformed') {
        showError('record_unreadable', RECORD_UNREADABLE_MESSAGE);
        return;
      }
      if (begun.kind === 'storage') {
        setStorageOk(false);
        showError('storage_unavailable', STORAGE_REQUIRED_MESSAGE);
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
        body: JSON.stringify({ pilot: submission.pilot, lane: submission.lane, ack_cap_usd: submission.ack_cap_usd })
      });
    } catch {
      await withRecordsLock(() => keepUncertainLocked(submission.key, pilots, lanes));
      showError(
        'network_error',
        'Network error: the outcome is unknown. Use “Retry the same submission”: it reuses the same request key, so the backend cannot start a second run for it.'
      );
      return;
    }

    const payload = await readJson(response);
    const accepted = isAcceptedView(payload, idPattern) ? payload : null;
    if (accepted && (response.status === 202 || (response.status === 200 && accepted.replay === true))) {
      // The key's outcome is established. If the lock is not granted the record simply stays (safe).
      await withRecordsLock(() => settleLocked(submission.key, attempt, 'accepted', pilots, lanes));
      startTracking(
        accepted.requestId,
        {
          state: accepted.state,
          pilot: submission.pilot,
          lane: submission.lane,
          capUsd: accepted.capUsd ?? submission.ack_cap_usd,
          note: accepted.replay ? 'The backend recognised this as a replay of your earlier submission.' : null
        },
        false
      );
      setAcknowledged(false);
      setSubmitState({ status: 'idle' });
      void loadConfig();
      return;
    }

    const error = asApiError(payload, `The request failed (HTTP ${response.status}). The outcome is unknown; retry the same submission.`);
    const outcomeUnknown = response.status >= 500 || error.code === 'unexpected_response' || response.ok;
    if (outcomeUnknown) {
      // 5xx, unreadable or unexpected answer: this dispatch's outcome is unknown too.
      await withRecordsLock(() => keepUncertainLocked(submission.key, pilots, lanes));
      setSubmitState({ status: 'error', error });
      return;
    }
    const isDuplicate = error.code === 'duplicate' && !!error.requestId && idPattern.test(error.requestId);
    const definitive = isDefinitiveRefusal(response.status, error);
    let cleared = false;
    if (definitive || isDuplicate) {
      const settled = await withRecordsLock(() => settleLocked(submission.key, attempt, 'refused', pilots, lanes));
      cleared = settled.ok && (settled.value === 'cleared' || settled.value === 'gone');
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
    setSubmitState({ status: 'error', error: kept ? { ...error, message: `${error.message} ${UNCERTAIN_KEPT_MESSAGE}` } : error });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (inFlightRef.current !== null) return;
    // canSubmit already implies a selected pilot (TypeScript narrows `pilot` through it). The authoritative
    // "nothing unresolved exists" check runs again inside the records lock (beginFreshLocked).
    if (!canSubmit || !selectedLane || effectiveCap === null) return;
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
        ack_cap_usd: effectiveCap,
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

  return (
    <main className="generate-shell">
      <div className="v4s-panel">
        <header className="v4s-header">
          <h1 className="v4s-title">DK v4 staging</h1>
          <p className="v4s-sub">Technical trial on a protected Preview. Output is not approved content.</p>
        </header>

        <section aria-label="Staging budget" className="v4s-budget">
          {configState.status === 'loading' && <p className="v4s-muted">Loading staging configuration…</p>}
          {configState.status === 'error' && <p className="notice error">{configState.message}</p>}
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
          {paused && (
            <p className="v4s-muted">A run already in progress keeps going until it finishes or times out.</p>
          )}
          {reconciliation && (
            <p className="notice error">
              An earlier run needs operator reconciliation, so no new runs are accepted until then.
            </p>
          )}
          {backendBusy && activeId === null && (
            <p className="v4s-muted">A staging run is in progress on the backend; submit again when it has finished.</p>
          )}
          {config && config.recipient === null && (
            <p className="notice error">The backend did not report an allowlisted recipient, so submission is disabled.</p>
          )}
          <button className="v4s-link" disabled={configRefreshing} onClick={() => void loadConfig()} type="button">
            {configRefreshing ? 'Refreshing…' : 'Refresh budget'}
          </button>
        </section>

        {(badSlots.length > 0 || scanError) && (
          <section aria-label="Unreadable submission record" className="v4s-pending v4s-bad">
            <h2 className="v4s-label">Submission record that can&apos;t be read safely</h2>
            <p className="v4s-message">
              {scanError
                ? 'Stored submission records could not be read.'
                : `Unreadable or mismatched record${badSlots.length > 1 ? 's' : ''}: ${badSlots.join(', ')}`}
            </p>
            <p className="v4s-muted">
              New runs are blocked from this browser. An operator must check the backend before this browser&apos;s site data is
              cleared.
            </p>
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
              <h2 className="v4s-label">Submission with an unknown outcome</h2>
              <p className="v4s-message">
                {pilotLabel(record.pilot)} · {recordLane ? `${recordLane.provider} · ${recordLane.model}` : record.lane} ·
                reservation cap ${record.ack_cap_usd} · first sent {new Date(record.createdAt).toLocaleString()}
              </p>
              <p className="v4s-muted">
                The backend may already have accepted it. It stays here until it resolves, and new runs are blocked from this
                browser until then. Retrying sends the same request key and body, so the backend returns the existing run
                instead of starting a second one.
              </p>
              <div className="v4s-actions">
                <button className="v4s-link" disabled={submitting || locksOk !== true} onClick={() => retryPending(record)} type="button">
                  Retry the same submission
                </button>
              </div>
            </section>
          );
        })}

        <form className="v4s-form" onSubmit={submit}>
          <label className="v4s-field" htmlFor="v4s-pilot">
            <span className="v4s-label">Pilot</span>
            <select
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
              <option value="">Select a pilot</option>
              {pilots.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>

          <fieldset className="v4s-lanes">
            <legend className="v4s-label">Lane</legend>
            {lanes.map((option) => {
              const cap = config?.laneCapsUsd[option.value] ?? option.capUsd;
              return (
                <label className="v4s-lane" key={option.value}>
                  <input
                    checked={lane === option.value}
                    disabled={locked}
                    name="lane"
                    onChange={() => {
                      if (locked || inFlightRef.current !== null) return;
                      setLane(option.value);
                      setAcknowledged(false);
                      setSubmitState({ status: 'idle' });
                    }}
                    required
                    type="radio"
                    value={option.value}
                  />
                  <span className="v4s-lane-body">
                    <span className="v4s-lane-title">
                      {option.provider} · {option.model}
                    </span>
                    <span className="v4s-lane-meta">
                      Reservation cap ${cap} per run (worst case per call, reserved before calls are made) · typical runtime{' '}
                      {option.typicalRuntime}
                    </span>
                    {cap !== option.capUsd && (
                      <span className="v4s-lane-meta v4s-warn">
                        Backend reservation cap differs from the expected ${option.capUsd}.
                      </span>
                    )}
                  </span>
                </label>
              );
            })}
          </fieldset>

          <label className="v4s-field" htmlFor="v4s-recipient">
            <span className="v4s-label">Recipient</span>
            <input
              id="v4s-recipient"
              placeholder={config ? 'No allowlisted recipient reported' : 'Loading…'}
              readOnly
              type="text"
              value={config?.recipient ?? ''}
            />
            <span className="v4s-muted">From the backend allowlist. Not editable.</span>
          </label>

          {overDaily && (
            <p className="notice error">
              This lane&apos;s reservation cap is above today&apos;s remaining budget, so the backend will probably refuse
              it until 00:00 UTC.
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

          {storageOk === false && <p className="notice error">{STORAGE_REQUIRED_MESSAGE}</p>}
          {locksOk === false && <p className="notice error v4s-locks">{LOCKS_MESSAGE}</p>}
          {visiblePending.length > 0 && <p className="v4s-muted">Retry the earlier submission first; new runs are blocked until it resolves.</p>}
          {activeId !== null && <p className="v4s-muted">A run is being tracked below; submit again when it has finished.</p>}

          {submitError && (
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
          )}

          <p className="v4s-muted v4s-footnote">
            Reservation caps are enforced on worst-case reservations made before each provider call; they are not a hard
            maximum. Settlement uses actual usage, so in rare cases a run can bill more than its reservation cap and a day can
            end slightly above the daily ceiling; further runs are then refused.
          </p>
        </form>

        {tracked && (
          <section aria-live="polite" className="v4s-status">
            <h2 className="v4s-label">Request status</h2>
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
                  <span className={`v4s-state v4s-state-${tracked.state}`}>{STATE_LABELS[tracked.state]}</span>
                </dd>
              </div>
              <div>
                <dt>Pilot</dt>
                <dd>{pilotLabel(tracked.pilot)}</dd>
              </div>
              <div>
                <dt>Lane</dt>
                <dd>{trackedLane ? `${trackedLane.provider} · ${trackedLane.model}` : '—'}</dd>
              </div>
              <div>
                <dt>Committed</dt>
                <dd>
                  {money(tracked.committedUsd)}
                  {tracked.capUsd !== null && <> (reservation cap {money(tracked.capUsd)})</>}
                </dd>
              </div>
              {tracked.reservedUsd !== null && activeId !== null && (
                <div>
                  <dt>Reserved</dt>
                  <dd>{money(tracked.reservedUsd)}</dd>
                </div>
              )}
              <div>
                <dt>Reason code</dt>
                <dd>{tracked.reasonCode ?? '—'}</dd>
              </div>
              {tracked.admittedAt && (
                <div>
                  <dt>Admitted</dt>
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
              <p className="v4s-muted">Typical runtime for this lane: {trackedLane.typicalRuntime}.</p>
            )}
            {tracked.reasonCode && REASON_MESSAGES.has(tracked.reasonCode) && (
              <p className="v4s-muted v4s-reason">{REASON_MESSAGES.get(tracked.reasonCode)}</p>
            )}
            {tracked.state === 'interrupted_unreconciled' && (
              <p className="notice error">Needs operator reconciliation; no further runs can start until it is resolved.</p>
            )}
            {tracked.pollError && (
              <p className="notice error">
                {tracked.pollError}
                {pollingActive && pollFailures > 0 && ` Retrying in 30 s (failure ${pollFailures} of ${MAX_POLL_FAILURES}).`}
              </p>
            )}
            {pollHalt === 'errors' && (
              <p className="notice error">
                Automatic status checks stopped after {MAX_POLL_FAILURES} failed checks in a row.
              </p>
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
        )}
      </div>
    </main>
  );
}
