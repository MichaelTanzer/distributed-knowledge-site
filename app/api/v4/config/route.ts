import type { NextRequest } from 'next/server';
import {
  BACKEND_PATHS,
  apiError,
  backendRequest,
  clientIpFrom,
  errorResponse,
  isCrossSiteGet,
  jsonResponse,
  mapBackendFailure,
  methodNotAllowed,
  normalizeConfig,
  stagingEnabled,
  stagingNotFound
} from '../../../../lib/v4Staging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** GET /api/v4/config → backend GET /v1/config, returned as a sanitised view. */
export async function GET(request: NextRequest) {
  if (!stagingEnabled()) return stagingNotFound();
  if (isCrossSiteGet(request)) return apiError(403, 'origin_not_allowed', 'Cross-site requests are not allowed.');

  const result = await backendRequest(BACKEND_PATHS.config, { method: 'GET', clientIp: clientIpFrom(request) });
  if (result.kind !== 'ok') return errorResponse(mapBackendFailure(result, 'config'));
  return jsonResponse(200, normalizeConfig(result.json));
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
