import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { verifyActiveSession } from '@/lib/refresh-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const auth = getAuthInfoFromCookie(request);
  if (!auth?.username || !auth.tokenId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  if (await verifyActiveSession(auth.username, auth.tokenId)) {
    return NextResponse.json(
      { ok: true },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  }
  const response = NextResponse.json(
    { error: '该账号已在另一台设备登录', code: 'SESSION_REPLACED' },
    { status: 409 }
  );
  response.cookies.set('auth', '', { path: '/', expires: new Date(0) });
  return response;
}
