/**
 * Lane and case values plus the "which providers may be offered" rules, shared by the server (lib/v4Staging.ts
 * and the /api/v4 routes) and the browser form. Client-safe: no Node or Next imports, no backend address, no
 * money figures.
 */

export type PilotValue = 'SL-002' | 'SL-028' | 'SL-035';
export type LaneValue = 'openai' | 'google' | 'xai' | 'anthropic';

/** Every lane the site knows, in display order. The backend config decides which of them are offered. */
export const LANE_VALUES: readonly LaneValue[] = ['openai', 'google', 'xai', 'anthropic'];

/**
 * Lanes offered when the backend config is unavailable (loading, failed, or no `lanes` field): today's three.
 * Anthropic is never offered unless the backend config lists it.
 */
export const FALLBACK_LANE_VALUES: readonly LaneValue[] = ['openai', 'google', 'xai'];

/** Text shown on a provider that the backend marks unavailable for the selected case. */
export const NOT_AVAILABLE_FOR_CASE = 'Not available for this case';

/** One lane as the backend config lists it, reduced to what the form needs (no caps, no reviewer, no timeouts). */
export interface ConfigLaneView {
  lane: LaneValue;
  /** The backend's generator model id for this lane; null when absent or not a plain id (the static name is used). */
  model: string | null;
  /** Case ids this lane must not be offered for (backend `unavailablePilots`). */
  unavailablePilots: PilotValue[];
}

/**
 * Lanes to offer: exactly those the backend config lists (in the site's order), or the fallback three when the
 * config is unavailable (`configLanes` null). A lane the site does not know is never offered.
 */
export function offeredLaneValues(configLanes: readonly ConfigLaneView[] | null): LaneValue[] {
  if (configLanes === null) return [...FALLBACK_LANE_VALUES];
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

/** The model name to show for a lane: the backend config's when it has one, else the static fallback. */
export function laneModel(configLanes: readonly ConfigLaneView[] | null, lane: LaneValue, fallback: string): string {
  return configLanes?.find((item) => item.lane === lane)?.model ?? fallback;
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
