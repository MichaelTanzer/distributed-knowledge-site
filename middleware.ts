import { NextResponse, type NextRequest } from 'next/server';
import { v4Enabled } from './lib/v4Env';

/**
 * v4 switch for the public site. Only /generate and /api/generate pass through here.
 *
 * - v4 not enabled (neither or only one of DK_V4_STAGING_URL / DK_V4_STAGING_TOKEN set): both requests pass
 *   through untouched, so /generate is the unchanged v3 page and /api/generate the unchanged v3 route.
 * - v4 enabled: /generate is served by the v4 form (internal route /generate-v4), and the legacy v3 paid
 *   entrypoint /api/generate is refused with 410 before any v3 code or upstream fetch runs. There is no
 *   automatic fallback to v3 after a v4 refusal.
 *
 * Module scope holds imports and constants only. Any exception inside the handler fails OPEN to the unchanged
 * route (NextResponse.next()) and logs {"event":"v4_middleware_error","name":<error name>}; the legacy v3 route
 * then refuses by itself when v4 is enabled (Node-side guard in app/api/generate/route.ts).
 */
export function middleware(request: NextRequest) {
  try {
    if (!v4Enabled()) return NextResponse.next();
    if (request.nextUrl.pathname === '/api/generate') {
      return NextResponse.json(
        { error: 'Generation has moved to the new form; reload /generate.' },
        { status: 410, headers: { 'cache-control': 'no-store' } }
      );
    }
    return NextResponse.rewrite(new URL('/generate-v4', request.url));
  } catch (error) {
    try {
      console.error(JSON.stringify({ event: 'v4_middleware_error', name: error instanceof Error ? String(error.name).slice(0, 64) : typeof error }));
    } catch {
      // Logging must never turn a fail-open into a failure.
    }
    return NextResponse.next();
  }
}

export const config = { matcher: ['/generate', '/api/generate'] };
