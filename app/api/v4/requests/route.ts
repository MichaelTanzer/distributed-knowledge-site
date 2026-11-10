import type { NextRequest } from 'next/server';
import {
  BACKEND_PATHS,
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
  parseSubmitBody,
  readBodyLimited,
  stagingEnabled,
  stagingNotFound
} from '../../../../lib/v4Staging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** Two sequential backend calls (config, then submit), each bounded at 15 s. */
export const maxDuration = 40;

const MAX_BODY_BYTES = 2048;

/**
 * POST /api/v4/requests → backend POST /v1/requests.
 * Browser body: exactly {pilot, lane, ack_cap_usd}. The recipient is never
 * taken from the browser; it is read from the backend's /v1/config.
 */
export async function POST(request: NextRequest) {
  if (!stagingEnabled()) return stagingNotFound();

  if (!isSameOriginPost(request)) {
    return apiError(403, 'origin_not_allowed', 'Cross-origin requests are not allowed.');
  }

  const contentType = (request.headers.get('content-type') ?? '').split(';')[0]?.trim().toLowerCase();
  if (contentType !== 'application/json') {
    return apiError(415, 'unsupported_media_type', 'Send the request as application/json.');
  }

  const idempotencyKey = request.headers.get('idempotency-key') ?? '';
  if (!isUuid(idempotencyKey)) {
    return apiError(400, 'invalid_idempotency_key', 'A UUID Idempotency-Key header is required.');
  }

  const raw = await readBodyLimited(request, MAX_BODY_BYTES);
  if (!raw.ok) {
    return raw.reason === 'too_large'
      ? apiError(413, 'body_too_large', 'The request body is too large.')
      : apiError(400, 'invalid_request', 'The request body could not be read.');
  }
  const body = parseSubmitBody(raw.text);
  if (!body) {
    return apiError(400, 'invalid_request', 'The request must contain exactly pilot, lane and ack_cap_usd with valid values.');
  }

  const clientIp = clientIpFrom(request);
  if (!clientIp) {
    return apiError(400, 'bad_client_ip', 'The client address could not be determined.');
  }

  const config = await backendRequest(BACKEND_PATHS.config, { method: 'GET', clientIp });
  if (config.kind !== 'ok') return errorResponse(mapBackendFailure(config, 'config'));
  const recipient = normalizeConfig(config.json).recipient;
  if (!recipient) {
    return apiError(503, 'recipient_unavailable', 'The staging backend did not report an allowlisted recipient.');
  }

  const result = await backendRequest(BACKEND_PATHS.requests, {
    method: 'POST',
    body: backendSubmitBody(body, recipient),
    clientIp,
    idempotencyKey: idempotencyKey.toLowerCase()
  });
  if (result.kind !== 'ok') return errorResponse(mapBackendFailure(result, 'submit'));

  const accepted = normalizeAccepted(result.json);
  if (!accepted) {
    return apiError(502, 'backend_error', 'The staging backend answered, but the response could not be read. Check the status before resubmitting.');
  }
  return jsonResponse(accepted.replay ? 200 : 202, accepted);
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
