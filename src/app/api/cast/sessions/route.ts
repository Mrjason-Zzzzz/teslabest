import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { createCastSession } from '@/lib/cast-session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  const auth = getAuthInfoFromCookie(request);
  if (!auth?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const session = await createCastSession(auth.username);
  return NextResponse.json(session, {
    headers: { 'Cache-Control': 'no-store, max-age=0' },
  });
}
