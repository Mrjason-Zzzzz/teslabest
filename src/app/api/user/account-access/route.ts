import { NextRequest, NextResponse } from 'next/server';

import { ACCESS_PLAN_LABELS, resolveAccountAccess } from '@/lib/account-access';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getFreshConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const config = await getFreshConfig();
  const access = resolveAccountAccess(config, authInfo.username);

  return NextResponse.json(
    {
      plan: access.plan,
      planLabel: ACCESS_PLAN_LABELS[access.plan],
      status: access.status,
      expiresAt: access.expiresAt,
      isExpired: access.isExpired,
      source: access.source,
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}
