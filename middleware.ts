import { NextRequest, NextResponse } from 'next/server';

const REALM = 'Distributed Knowledge';

function unauthorized() {
  return new NextResponse('Authentication required', {
    status: 401,
    headers: { 'www-authenticate': `Basic realm="${REALM}", charset="UTF-8"` }
  });
}

export function middleware(request: NextRequest) {
  const password = process.env.INFOPACK_WEB_PASSWORD;
  if (!password) {
    return new NextResponse('INFOPACK_WEB_PASSWORD is not configured', { status: 503 });
  }
  const header = request.headers.get('authorization');
  if (!header?.startsWith('Basic ')) return unauthorized();
  const decoded = atob(header.slice('Basic '.length));
  const separator = decoded.indexOf(':');
  const supplied = separator >= 0 ? decoded.slice(separator + 1) : '';
  if (supplied !== password) return unauthorized();
  return NextResponse.next();
}

export const config = {
  matcher: ['/generate/:path*', '/api/generate/:path*']
};
