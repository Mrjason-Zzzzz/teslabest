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
  const remainingDays =
    access.expiresAt === null
      ? null
      : Math.max(0, Math.ceil((access.expiresAt - Date.now()) / 86_400_000));

  return NextResponse.json(
    {
      plan: access.plan,
      planLabel: ACCESS_PLAN_LABELS[access.plan],
      status: access.status,
      expiresAt: access.expiresAt,
      remainingDays,
      isExpired: access.isExpired,
      source: access.source,
      renewalMessage:
        access.expiresAt === null
          ? ''
          : config.SiteConfig.MembershipRenewalMessage || '如需续费请联系站长',
    },
    {
      headers: {
        'Cache-Control': 'no-store, max-age=0',
      },
    }
  );
}
