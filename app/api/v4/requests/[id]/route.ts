import type { NextRequest } from 'next/server';
import {
  BACKEND_PATHS,
  apiError,
  backendRequest,
  clientIpFrom,
  errorResponse,
  isCrossSiteGet,
  isRequestId,
  jsonResponse,
  mapBackendFailure,
  methodNotAllowed,
  normalizeStatus,
  stagingEnabled,
  stagingNotFound
} from '../../../../../lib/v4Staging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One backend call bounded at 15 s. */
export const maxDuration = 20;

/** GET /api/v4/requests/<id> → backend GET /v1/requests/<id>, sanitised. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!stagingEnabled()) return stagingNotFound();
  if (isCrossSiteGet(request)) return apiError(403, 'origin_not_allowed', 'Cross-site requests are not allowed.');

  const { id } = await params;
  if (!isRequestId(id)) return apiError(400, 'invalid_request_id', 'The request id is not valid.');

  const result = await backendRequest(BACKEND_PATHS.request(id), { method: 'GET', clientIp: clientIpFrom(request) });
  if (result.kind !== 'ok') return errorResponse(mapBackendFailure(result, 'status'));

  let status: ReturnType<typeof normalizeStatus> = null;
  try {
    status = normalizeStatus(result.json, id);
  } catch {
    status = null;
  }
  if (!status) return apiError(502, 'backend_error', 'The staging backend status could not be read.');
  return jsonResponse(200, status);
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
