/**
 * Lane and case values plus the "which providers may be offered" rules, shared by the server (lib/v4Staging.ts
 * and the /api/v4 routes) and the browser form. Client-safe: no Node or Next imports, no backend address, no
 * money figures.
 */

export type PilotValue = 'SL-002' | 'SL-028' | 'SL-035';
export type LaneValue = 'openai' | 'google' | 'xai' | 'anthropic';

export const PILOT_VALUES: readonly PilotValue[] = ['SL-002', 'SL-028', 'SL-035'];

/** Every lane the site knows, in display order. The backend config decides which of them are offered. */
export const LANE_VALUES: readonly LaneValue[] = ['openai', 'google', 'xai', 'anthropic'];

/**
 * The three lanes that predate per-lane availability data. They keep origin/main's behaviour wherever the
 * backend gives no usable per-lane data: while the config is loading or unavailable, when `lanes` is missing or
 * keyed by lane, and when one of them is listed more than once. Every other lane (anthropic, future lanes) is
 * offered only by one well-formed entry in the `lanes` array.
 */
export const LEGACY_LANE_VALUES: readonly LaneValue[] = ['openai', 'google', 'xai'];

/** Text shown on a provider that the backend marks unavailable for the selected case. */
export const NOT_AVAILABLE_FOR_CASE = 'Not available for this case';

/** A config-supplied model name is shown only if it starts with its lane's model family. */
export const LANE_MODEL_PREFIX: Readonly<Record<LaneValue, string>> = {
  openai: 'gpt-',
  google: 'gemini-',
  xai: 'grok-',
  anthropic: 'claude-'
};

export function isPilotValue(value: unknown): value is PilotValue {
  return typeof value === 'string' && (PILOT_VALUES as readonly string[]).includes(value);
}

export function isLaneValue(value: unknown): value is LaneValue {
  return typeof value === 'string' && (LANE_VALUES as readonly string[]).includes(value);
}

export function isLegacyLane(lane: LaneValue): boolean {
  return LEGACY_LANE_VALUES.includes(lane);
}

/**
 * The model id if it is plausible for this lane: a plain id (letters, digits, `.`, `_`, `:`, `-`; at most 64
 * characters) that starts with the lane's family prefix. Anything else gives null.
 */
export function plausibleModel(lane: LaneValue, value: unknown): string | null {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(value) && value.startsWith(LANE_MODEL_PREFIX[lane])
    ? value
    : null;
}

/** One lane as the backend config offers it, reduced to what the form needs (no caps, no reviewer, no timeouts). */
export interface ConfigLaneView {
  lane: LaneValue;
  /** The backend's generator model id, if plausible for the lane; null means "show the static name". */
  model: string | null;
  /** Case ids this lane must not be offered for (backend `unavailablePilots`). */
  unavailablePilots: PilotValue[];
}

/**
 * Validates a lanes view as the browser receives it from /api/v4/config (the server builds it with the same
 * rules, so a valid response passes unchanged). Fails closed:
 * - null or undefined: no per-lane data (the legacy three are offered, as on origin/main);
 * - anything else that is not an array: nothing is offered;
 * - an entry with an unknown lane, an implausible model, a non-legacy lane without a model, or an
 *   `unavailablePilots` that is not an array of known case ids: that lane is not offered;
 * - a lane listed more than once: that lane is not offered.
 */
export function sanitizeLaneViews(value: unknown): ConfigLaneView[] | null {
  if (value === null || value === undefined) return null;
  if (!Array.isArray(value)) return [];
  const counts = new Map<unknown, number>();
  for (const item of value) {
    const lane = typeof item === 'object' && item !== null ? (item as { lane?: unknown }).lane : undefined;
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  const views: ConfigLaneView[] = [];
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) continue;
    const { lane, model, unavailablePilots } = item as Record<string, unknown>;
    if (!isLaneValue(lane) || counts.get(lane) !== 1) continue;
    const modelOk = model === null ? isLegacyLane(lane) : plausibleModel(lane, model) !== null;
    if (!modelOk || !Array.isArray(unavailablePilots) || !unavailablePilots.every(isPilotValue)) continue;
    views.push({ lane, model: model as string | null, unavailablePilots: [...new Set(unavailablePilots)] });
  }
  return LANE_VALUES.flatMap((lane) => views.filter((view) => view.lane === lane));
}

/**
 * Lanes to offer: exactly those the backend config offers (in the site's order), or the legacy three when it
 * gives no per-lane data (`configLanes` null). A lane the site does not know is never offered.
 */
export function offeredLaneValues(configLanes: readonly ConfigLaneView[] | null): LaneValue[] {
  if (configLanes === null) return [...LEGACY_LANE_VALUES];
  const listed = new Set(configLanes.map((entry) => entry.lane));
  return LANE_VALUES.filter((lane) => listed.has(lane));
}

/** True when the backend config marks this lane unavailable for this case. */
export function isPairUnavailable(
  configLanes: readonly ConfigLaneView[] | null,
  lane: LaneValue,
  pilot: PilotValue | ''
): boolean {
  if (configLanes === null || pilot === '') return false;
  const entry = configLanes.find((item) => item.lane === lane);
  return entry !== undefined && entry.unavailablePilots.includes(pilot);
}

/** True when this lane may be submitted with this case: offered, and not an unavailable pair. */
export function laneSelectable(lane: LaneValue, pilot: PilotValue | '', configLanes: readonly ConfigLaneView[] | null): boolean {
  return offeredLaneValues(configLanes).includes(lane) && !isPairUnavailable(configLanes, lane, pilot);
}

/**
 * The lane the form shows and may submit: the selected one while it is selectable, else '' (a selection that is
 * no longer offered, or unavailable for the selected case, is cleared).
 */
export function effectiveLane(
  lane: LaneValue | '',
  pilot: PilotValue | '',
  configLanes: readonly ConfigLaneView[] | null
): LaneValue | '' {
  return lane !== '' && laneSelectable(lane, pilot, configLanes) ? lane : '';
}

/** The model name to offer for a lane: the backend config's when it has a plausible one, else the static name. */
export function laneModel(configLanes: readonly ConfigLaneView[] | null, lane: LaneValue, fallback: string): string {
  return plausibleModel(lane, configLanes?.find((item) => item.lane === lane)?.model) ?? fallback;
}

export interface LaneChoice<T> {
  option: T;
  /** Model name to display (backend config first, static fallback second). */
  model: string;
  /** Shown but not selectable: the backend marks this lane unavailable for the selected case. */
  disabled: boolean;
}

/** The provider choices the form renders, in order: offered lanes only, unavailable pairs disabled. */
export function laneChoices<T extends { value: LaneValue; model: string }>(
  lanes: readonly T[],
  configLanes: readonly ConfigLaneView[] | null,
  pilot: PilotValue | ''
): LaneChoice<T>[] {
  const offered = new Set(offeredLaneValues(configLanes));
  return lanes
    .filter((option) => offered.has(option.value))
    .map((option) => ({
      option,
      model: laneModel(configLanes, option.value, option.model),
      disabled: isPairUnavailable(configLanes, option.value, pilot)
    }));
}
