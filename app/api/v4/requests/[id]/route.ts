import type { NextRequest } from 'next/server';
import {
  BACKEND_PATHS,
  backendRequest,
  clientIpFrom,
  errorResponse,
  isCrossSiteGet,
  isRequestId,
  jsonResponse,
  mapBackendFailure,
  methodNotAllowed,
  normalizeStatus,
  publicError,
  stagingNotFound,
  statusForAudience,
  v4Enabled
} from '../../../../../lib/v4Staging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One backend call bounded at 15 s. */
export const maxDuration = 20;

/** GET /api/v4/requests/<id> → backend GET /v1/requests/<id>, sanitised. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!v4Enabled()) return stagingNotFound();
  if (isCrossSiteGet(request)) return errorResponse(publicError({ status: 403, body: { code: 'origin_not_allowed', message: 'Cross-site requests are not allowed.' } }));

  const { id } = await params;
  if (!isRequestId(id)) return errorResponse(publicError({ status: 400, body: { code: 'invalid_request_id', message: 'The request id is not valid.' } }));

  const result = await backendRequest(BACKEND_PATHS.request(id), { method: 'GET', clientIp: clientIpFrom(request) });
  if (result.kind !== 'ok') return errorResponse(publicError(mapBackendFailure(result, 'status')));

  let status: ReturnType<typeof normalizeStatus> = null;
  try {
    status = normalizeStatus(result.json, id);
  } catch {
    status = null;
  }
  if (!status) return errorResponse(publicError({ status: 502, body: { code: 'backend_error', message: 'The staging backend status could not be read.' } }));
  // Public deployments omit the money fields.
  return jsonResponse(200, statusForAudience(status));
}

export function POST() {
  return methodNotAllowed('GET, HEAD');
}

export function PUT() {
  return methodNotAllowed('GET, HEAD');
}

export function PATCH() {
  return methodNotAllowed('GET, HEAD');
}

export function DELETE() {
  return methodNotAllowed('GET, HEAD');
}

export function OPTIONS() {
  return methodNotAllowed('GET, HEAD');
}
