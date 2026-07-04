import { NextRequest, NextResponse } from 'next/server';

function validEmail(value: unknown): value is string {
  return typeof value === 'string' && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
}

export async function POST(request: NextRequest) {
  const body = await request.json().catch(() => null);
  if (!body || !validEmail(body.email)) {
    return NextResponse.json({ error: 'Enter a valid delivery email.' }, { status: 400 });
  }

  const backendUrl = process.env.INFOPACK_BACKEND_URL;
  const backendToken = process.env.INFOPACK_BACKEND_TOKEN;
  if (!backendUrl || !backendToken) {
    return NextResponse.json(
      { error: 'Generation backend is not configured yet.' },
      { status: 503 }
    );
  }

  const response = await fetch(backendUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${backendToken}`
    },
    body: JSON.stringify({ email: body.email, packageId: 'counterfactual_port_azura' })
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    return NextResponse.json(
      { error: payload.error ?? 'Generation backend failed.' },
      { status: response.status }
    );
  }
  return NextResponse.json({
    message: 'Generation request accepted. Delivery email will follow.',
    deliveryId: payload.deliveryId
  });
}
