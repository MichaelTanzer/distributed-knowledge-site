import type { LaneOption } from '../../lib/v4Staging';
import {
  NOT_AVAILABLE_FOR_CASE,
  laneSelectable,
  type ConfigLaneView,
  type LaneChoice,
  type LaneValue,
  type PilotValue
} from '../../lib/v4Lanes';

/**
 * Parts of the v4 form that depend on the backend's lane offer, kept free of state so they can be rendered and
 * tested with a loaded config: the submit gate and the two provider controls (public select, operator radios).
 */

export interface SubmitGate {
  configReady: boolean;
  paused: boolean;
  reconciliation: boolean;
  backendBusy: boolean;
  pilot: PilotValue | '';
  /** The effective lane (lib/v4Lanes effectiveLane): '' once a selection is no longer selectable. */
  lane: LaneValue | '';
  configLanes: readonly ConfigLaneView[] | null;
  recipientValid: boolean;
  publicVariant: boolean;
  effectiveCap: string | null;
  acknowledged: boolean;
  submitting: boolean;
  storageOk: boolean | null;
  locksOk: boolean | null;
  blockingRecords: boolean;
  activeId: string | null;
}

/** True when a fresh submission may be sent. The lane must still be offered and available for the case. */
export function canSubmitForm(gate: SubmitGate): boolean {
  return (
    gate.configReady &&
    !gate.paused &&
    !gate.reconciliation &&
    !gate.backendBusy &&
    gate.pilot !== '' &&
    gate.lane !== '' &&
    laneSelectable(gate.lane, gate.pilot, gate.configLanes) &&
    gate.recipientValid &&
    (gate.publicVariant || (gate.effectiveCap !== null && gate.acknowledged)) &&
    !gate.submitting &&
    gate.storageOk === true &&
    gate.locksOk === true &&
    !gate.blockingRecords &&
    gate.activeId === null
  );
}

/** The public provider select: offered providers only, unavailable ones disabled with their reason. */
export function ProviderSelect({
  choices,
  value,
  disabled,
  onSelect
}: {
  choices: LaneChoice<LaneOption>[];
  /** The effective lane: '' when nothing selectable is selected. */
  value: LaneValue | '';
  disabled: boolean;
  onSelect: (value: LaneValue | '') => void;
}) {
  return (
    <label className="v4s-field" htmlFor="v4s-lane">
      <span className="v4s-label">Provider</span>
      <select
        disabled={disabled}
        id="v4s-lane"
        onChange={(event) => onSelect(event.target.value as LaneValue | '')}
        required
        value={value}
      >
        <option value="">Select a provider</option>
        {choices.map(({ option, model, disabled: unavailable }) => (
          <option disabled={unavailable} key={option.value} value={option.value}>
            {`${option.provider} · ${model} (about ${option.typicalRuntime.replace(/^~/, '')})${
              unavailable ? ` — ${NOT_AVAILABLE_FOR_CASE}` : ''
            }`}
          </option>
        ))}
      </select>
    </label>
  );
}

/** The operator lane radios: offered lanes only, unavailable ones disabled with their reason. */
export function LaneRadios({
  choices,
  value,
  disabled,
  caps,
  onSelect
}: {
  choices: LaneChoice<LaneOption>[];
  /** The effective lane: '' when nothing selectable is selected. */
  value: LaneValue | '';
  disabled: boolean;
  /** Backend caps by lane (operator view); the static cap is shown when absent. */
  caps: Partial<Record<LaneValue, string>>;
  onSelect: (value: LaneValue) => void;
}) {
  return (
    <fieldset className="v4s-lanes">
      <legend className="v4s-label">Lane</legend>
      {choices.map(({ option, model, disabled: unavailable }) => {
        const cap = caps[option.value] ?? option.capUsd;
        return (
          <label className="v4s-lane" data-unavailable={unavailable ? 'true' : undefined} key={option.value}>
            <input
              checked={value === option.value}
              disabled={disabled || unavailable}
              name="lane"
              onChange={() => onSelect(option.value)}
              required
              type="radio"
              value={option.value}
            />
            <span className="v4s-lane-body">
              <span className="v4s-lane-title">
                {option.provider} · {model}
              </span>
              {unavailable && <span className="v4s-lane-meta v4s-warn">{NOT_AVAILABLE_FOR_CASE}</span>}
              <span className="v4s-lane-meta">
                Reservation cap ${cap} per run (worst case per call, reserved before calls are made) · typical runtime{' '}
                {option.typicalRuntime}
              </span>
              {cap !== option.capUsd && (
                <span className="v4s-lane-meta v4s-warn">Backend reservation cap differs from the expected ${option.capUsd}.</span>
              )}
            </span>
          </label>
        );
      })}
    </fieldset>
  );
}
