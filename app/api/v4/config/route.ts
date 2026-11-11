import type { NextRequest } from 'next/server';
import {
  BACKEND_PATHS,
  configForAudience,
  backendRequest,
  clientIpFrom,
  errorResponse,
  isCrossSiteGet,
  jsonResponse,
  mapBackendFailure,
  methodNotAllowed,
  normalizeConfig,
  publicError,
  stagingNotFound,
  v4Enabled
} from '../../../../lib/v4Staging';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
/** One backend call bounded at 15 s. */
export const maxDuration = 20;

/** GET /api/v4/config → backend GET /v1/config, returned as a sanitised view (operator view only on Preview). */
export async function GET(request: NextRequest) {
  if (!v4Enabled()) return stagingNotFound();
  if (isCrossSiteGet(request)) return errorResponse(publicError({ status: 403, body: { code: 'origin_not_allowed', message: 'Cross-site requests are not allowed.' } }));

  const result = await backendRequest(BACKEND_PATHS.config, { method: 'GET', clientIp: clientIpFrom(request) });
  if (result.kind !== 'ok') return errorResponse(publicError(mapBackendFailure(result, 'config')));
  try {
    // Public deployments get the same shape with every money / build figure nulled.
    return jsonResponse(200, configForAudience(normalizeConfig(result.json)));
  } catch {
    return errorResponse(publicError({ status: 502, body: { code: 'backend_error', message: 'The staging backend configuration could not be read.' } }));
  }
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
