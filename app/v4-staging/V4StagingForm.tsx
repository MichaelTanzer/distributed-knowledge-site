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

const STORAGE_KEY = 'dkV4Staging.lastRequestId';
const POLL_INTERVAL_MS = 30_000;
const TERMINAL_STATES: ReadonlySet<RequestState> = new Set<RequestState>(['delivered', 'failed', 'interrupted']);
/** Outcomes where the backend may or may not have accepted the request. */
const INDETERMINATE_CODES: ReadonlySet<string> = new Set([
  'network_error',
  'unexpected_response',
  'backend_error',
  'backend_timeout',
  'backend_unavailable'
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
  /** True when polling must stop for a reason other than a terminal state. */
  stopped: boolean;
}

interface Props {
  pilots: PilotOption[];
  lanes: LaneOption[];
  requestIdPattern: string;
}

function readStoredId(pattern: RegExp): string | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);
    return value && pattern.test(value) ? value : null;
  } catch {
    return null;
  }
}

function storeId(requestId: string) {
  try {
    window.localStorage.setItem(STORAGE_KEY, requestId);
  } catch {
    // Storage unavailable (private mode, blocked site data): polling still works until reload.
  }
}

function clearStoredId() {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing stored or storage unavailable.
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
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

function isConfigView(payload: unknown): payload is StagingConfigView {
  return isRecord(payload) && typeof payload.spendState === 'string' && isRecord(payload.laneCapsUsd);
}

function isAcceptedView(payload: unknown, pattern: RegExp): payload is SubmitAcceptedView {
  return isRecord(payload) && typeof payload.requestId === 'string' && pattern.test(payload.requestId);
}

function isStatusView(payload: unknown): payload is RequestStatusView {
  return isRecord(payload) && typeof payload.requestId === 'string' && typeof payload.state === 'string';
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
  const [tracked, setTracked] = useState<TrackedRequest | null>(null);
  const pollImmediatelyRef = useRef(false);
  /** Key reused only when the previous attempt for the same selection had an unknown outcome. */
  const retryKeyRef = useRef<{ key: string; signature: string } | null>(null);

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

  const pollStatus = useCallback(async (requestId: string) => {
    const update = (fields: Partial<TrackedRequest>) =>
      setTracked((previous) => (previous && previous.requestId === requestId ? { ...previous, ...fields } : previous));
    try {
      const response = await fetch(`/api/v4/requests/${encodeURIComponent(requestId)}`, {
        cache: 'no-store',
        headers: { accept: 'application/json' }
      });
      const payload = await readJson(response);
      if (response.ok && isStatusView(payload)) {
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
        return;
      }
      const error = asApiError(payload, `Status check failed (HTTP ${response.status}).`);
      if (response.status === 404 && error.code === 'not_found') {
        clearStoredId();
        update({ checkedAt: Date.now(), pollError: error.message, stopped: true });
        return;
      }
      update({ checkedAt: Date.now(), pollError: `${error.message} Retrying every 30 s.` });
    } catch {
      update({ checkedAt: Date.now(), pollError: 'Status check failed (network error). Retrying every 30 s.' });
    }
  }, []);

  const startTracking = useCallback((requestId: string, fields: Partial<TrackedRequest>, pollNow: boolean) => {
    storeId(requestId);
    pollImmediatelyRef.current = pollNow;
    setTracked(newTracked(requestId, fields));
  }, []);

  // First load: configuration, and resume a request remembered by this browser.
  useEffect(() => {
    void loadConfig();
    const stored = readStoredId(idPattern);
    if (stored) {
      pollImmediatelyRef.current = true;
      setTracked(newTracked(stored, { note: 'Resumed from the last request made in this browser.' }));
    }
  }, [idPattern, loadConfig]);

  const activeId = tracked && !tracked.stopped && !TERMINAL_STATES.has(tracked.state) ? tracked.requestId : null;

  // Poll every 30 s while the tracked request is not finished.
  useEffect(() => {
    if (!activeId) return;
    if (pollImmediatelyRef.current) {
      pollImmediatelyRef.current = false;
      void pollStatus(activeId);
    }
    const handle = window.setInterval(() => void pollStatus(activeId), POLL_INTERVAL_MS);
    return () => window.clearInterval(handle);
  }, [activeId, pollStatus]);

  // Refresh the budget once a run reaches a final state.
  const finishedId = tracked && TERMINAL_STATES.has(tracked.state) ? tracked.requestId : null;
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
    submitState.status !== 'submitting' &&
    activeId === null;

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // canSubmit already implies a selected pilot (TypeScript narrows `pilot` through it).
    if (!canSubmit || !selectedLane || effectiveCap === null) return;

    const signature = `${pilot}|${selectedLane.value}|${effectiveCap}`;
    let key: string;
    if (retryKeyRef.current && retryKeyRef.current.signature === signature) {
      key = retryKeyRef.current.key;
    } else if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      key = crypto.randomUUID();
    } else {
      setSubmitState({ status: 'error', error: { code: 'no_uuid', message: 'This browser cannot generate a request key.' } });
      return;
    }
    retryKeyRef.current = { key, signature };
    setSubmitState({ status: 'submitting' });

    let response: Response;
    try {
      response = await fetch('/api/v4/requests', {
        method: 'POST',
        cache: 'no-store',
        headers: { accept: 'application/json', 'content-type': 'application/json', 'idempotency-key': key },
        body: JSON.stringify({ pilot, lane: selectedLane.value, ack_cap_usd: effectiveCap })
      });
    } catch {
      setSubmitState({
        status: 'error',
        error: {
          code: 'network_error',
          message: 'Network error: the outcome is unknown. Submitting the same selection again reuses the same request key, so it cannot start a second run.'
        }
      });
      return;
    }

    const payload = await readJson(response);
    if ((response.status === 202 || response.status === 200) && isAcceptedView(payload, idPattern)) {
      retryKeyRef.current = null;
      startTracking(
        payload.requestId,
        {
          state: payload.state,
          pilot,
          lane: selectedLane.value,
          capUsd: payload.capUsd ?? effectiveCap,
          note: payload.replay ? 'The backend recognised this as a replay of your earlier submission.' : null
        },
        false
      );
      setAcknowledged(false);
      setSubmitState({ status: 'idle' });
      void loadConfig();
      return;
    }

    const error = asApiError(payload, `The request failed (HTTP ${response.status}). Check the status before resubmitting.`);
    if (!INDETERMINATE_CODES.has(error.code)) retryKeyRef.current = null;
    if (error.code === 'duplicate' && error.requestId && idPattern.test(error.requestId)) {
      startTracking(error.requestId, { pilot, lane: selectedLane.value, note: error.message }, true);
      setSubmitState({ status: 'idle' });
      return;
    }
    setSubmitState({ status: 'error', error });
  }

  function dismissTracked() {
    clearStoredId();
    setTracked(null);
  }

  const submitError = submitState.status === 'error' ? submitState.error : null;
  const trackedLane = tracked ? laneOption(tracked.lane) : undefined;

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

        <form className="v4s-form" onSubmit={submit}>
          <label className="v4s-field" htmlFor="v4s-pilot">
            <span className="v4s-label">Pilot</span>
            <select
              id="v4s-pilot"
              onChange={(event) => {
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
                    name="lane"
                    onChange={() => {
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
                      Spends up to ${cap} (worst case, reserved before each call) · typical runtime {option.typicalRuntime}
                    </span>
                    {cap !== option.capUsd && (
                      <span className="v4s-lane-meta v4s-warn">Backend cap differs from the expected ${option.capUsd}.</span>
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
              This lane&apos;s cap is above today&apos;s remaining budget, so the backend will probably refuse it until 00:00 UTC.
            </p>
          )}

          <label className="v4s-ack">
            <input
              checked={acknowledged}
              disabled={effectiveCap === null}
              onChange={(event) => setAcknowledged(event.target.checked)}
              type="checkbox"
            />
            <span>
              {effectiveCap === null
                ? 'Select a lane to see its cap.'
                : `I understand this run spends up to $${effectiveCap} of metered API budget (worst case, reserved before each call).`}
            </span>
          </label>

          <button className="v4s-submit" disabled={!canSubmit} type="submit">
            {submitState.status === 'submitting' ? 'Submitting…' : 'Start run'}
          </button>

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
            Caps are enforced on worst-case reservations made before each provider call. Settlement uses actual usage, so a
            day can end slightly above the daily ceiling; further runs are then refused.
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
                  {tracked.capUsd !== null && <> (cap {money(tracked.capUsd)})</>}
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
                  {activeId !== null && ' · checks every 30 s'}
                </dd>
              </div>
            </dl>
            {tracked.state === 'running' && trackedLane && (
              <p className="v4s-muted">Typical runtime for this lane: {trackedLane.typicalRuntime}.</p>
            )}
            {tracked.pollError && <p className="notice error">{tracked.pollError}</p>}
            <div className="v4s-actions">
              {activeId !== null && (
                <button className="v4s-link" onClick={() => void pollStatus(tracked.requestId)} type="button">
                  Check now
                </button>
              )}
              {activeId === null && (
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
