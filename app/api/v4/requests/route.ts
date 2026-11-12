import type { NextRequest } from 'next/server';
import {
  BACKEND_PATHS,
  acceptedForAudience,
  apiError,
  backendRequest,
  backendSubmitBody,
  clientIpFrom,
  errorResponse,
  isSameOriginPost,
  isUuid,
  jsonResponse,
  mapBackendFailure,
  methodNotAllowed,
  normalizeAccepted,
  normalizeConfig,
  operatorPreview,
  parseSubmitBody,
  publicError,
  readBodyLimited,
  stagingNotFound,
  v4Enabled
} from '../../../../lib/v4Staging';
import { isPairUnavailable, offeredLaneValues } from '../../../../lib/v4Lanes';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Two sequential backend calls (config, then submit), each bounded at 15 s. */
export const maxDuration = 40;

const MAX_BODY_BYTES = 2048;

/** Error response in the audience's wording (public deployments never echo backend text or figures). */
function refuse(status: number, code: string, message: string) {
  return errorResponse(publicError({ status, body: { code, message } }));
}

/**
 * POST /api/v4/requests → backend POST /v1/requests.
 * Browser body: exactly {pilot, lane, recipient}; recipient is the requester's email, validated strictly
 * here (400 invalid_recipient before any backend call). ack_cap_usd is supplied from the backend config, which
 * also decides whether the lane is offered and whether this lane/case pair is available.
 */
export async function POST(request: NextRequest) {
  if (!v4Enabled()) return stagingNotFound();

  if (!isSameOriginPost(request)) {
    return refuse(403, 'origin_not_allowed', 'Cross-origin requests are not allowed.');
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return refuse(415, 'unsupported_media_type', 'Send the request as application/json.');
  }

  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (!isUuid(idempotencyKey)) {
    return refuse(400, 'invalid_idempotency_key', 'A UUID Idempotency-Key header is required.');
  }

  const raw = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!raw.ok) {
    return raw.reason === 'too_large'
      ? refuse(413, 'body_too_large', 'The request body is too large.')
      : refuse(400, 'invalid_request', 'The request body could not be read.');
  }
  const parsed = parseSubmitBody(raw.text);
  if (!parsed.ok) {
    return parsed.reason === 'recipient'
      ? refuse(400, 'invalid_recipient', 'Enter a single valid email address.')
      : refuse(400, 'invalid_request', 'The request must contain exactly pilot, lane and recipient with valid values.');
  }

  const clientIp = clientIpFrom(request);
  if (!clientIp) {
    return refuse(400, 'bad_client_ip', 'The client address could not be determined.');
  }

  const config = await backendRequest(BACKEND_PATHS.config, { method: 'GET', clientIp });
  if (config.kind !== 'ok') return errorResponse(publicError(mapBackendFailure(config, 'config')));
  let view: ReturnType<typeof normalizeConfig> | null = null;
  try {
    view = normalizeConfig(config.json);
  } catch {
    view = null;
  }
  // Only what the backend offers, by the same rules as the form (lib/v4Lanes.ts): a lane the config does not
  // offer (malformed, duplicated or missing entry; without per-lane data only the legacy three are offered), or a
  // lane/case pair it marks unavailable, is refused here (a definitive 400) without calling POST /v1/requests.
  // The backend refuses the pair too.
  const offered = view?.lanes ?? null;
  if (!offeredLaneValues(offered).includes(parsed.body.lane)) {
    return refuse(400, 'lane_unavailable', 'The backend does not offer this lane.');
  }
  if (isPairUnavailable(offered, parsed.body.lane, parsed.body.pilot)) {
    return refuse(400, 'lane_pilot_unavailable', 'This lane is not available for this pilot.');
  }
  // The cap comes from the same entry that made the lane offered (or, without per-lane data, as origin/main read it).
  const ackCapUsd = view?.laneCapsUsd[parsed.body.lane] ?? null;
  if (!ackCapUsd) {
    return refuse(503, 'v4_unavailable', 'The staging backend did not report a reservation cap for this lane.');
  }

  const result = await backendRequest(BACKEND_PATHS.requests, {
    method: 'POST',
    body: backendSubmitBody(parsed.body, ackCapUsd),
    clientIp,
    idempotencyKey: idempotencyKey.toLowerCase()
  });
  if (result.kind !== 'ok') return errorResponse(publicError(mapBackendFailure(result, 'submit')));

  let accepted: ReturnType<typeof normalizeAccepted> = null;
  try {
    accepted = normalizeAccepted(result.json);
  } catch {
    accepted = null;
  }
  if (!accepted) {
    return refuse(502, 'backend_error', 'The staging backend answered, but the response could not be read. Check the status before resubmitting.');
  }
  return jsonResponse(accepted.replay ? 200 : 202, operatorPreview() ? accepted : acceptedForAudience(accepted));
}

export function GET() {
  return methodNotAllowed('POST');
}

export function PUT() {
  return methodNotAllowed('POST');
}

export function PATCH() {
  return methodNotAllowed('POST');
}

export function DELETE() {
  return methodNotAllowed('POST');
}

export function OPTIONS() {
  return methodNotAllowed('POST');
}
