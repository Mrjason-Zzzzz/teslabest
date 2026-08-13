/* eslint-disable no-console */
import { NextRequest, NextResponse } from 'next/server';

import { resolveAccountAccess } from '@/lib/account-access';
import { getAuthInfoFromCookie, parseAuthInfo } from '@/lib/auth';
import { getConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { refreshAccessToken } from '@/lib/middleware-auth';
import { TOKEN_CONFIG } from '@/lib/refresh-token';

export const runtime = 'nodejs';

const STORAGE_TYPE =
  (process.env.NEXT_PUBLIC_STORAGE_TYPE as
    | 'localstorage'
    | 'redis'
    | 'upstash'
    | 'kvrocks'
    | undefined) || 'localstorage';

function buildRefreshResponse(authToken?: string | null) {
  const body: Record<string, unknown> = { ok: true };

  if (authToken) {
    body.token = authToken;
    const authInfo = parseAuthInfo(authToken);
    if (authInfo) {
      const { password, ...rest } = authInfo;
      body.auth = rest;
    }
  }

  return NextResponse.json(body);
}

export async function POST(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);

  if (!authInfo) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  if (STORAGE_TYPE === 'localstorage') {
    if (!authInfo.password || authInfo.password !== process.env.PASSWORD) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const authCookie = request.cookies.get('auth');
    if (!authCookie?.value) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const response = buildRefreshResponse(authCookie.value);
    const expires = new Date();
    expires.setDate(expires.getDate() + 60);
    response.cookies.set('auth', authCookie.value, {
      path: '/',
      expires,
      sameSite: 'lax',
      httpOnly: false,
      secure: false,
    });
    return response;
  }

  if (
    !authInfo.username ||
    !authInfo.role ||
    !authInfo.timestamp ||
    !authInfo.tokenId ||
    !authInfo.refreshToken ||
    !authInfo.refreshExpires ||
    authInfo.accountStatus !== 'active' ||
    (authInfo.accountExpiresAt !== null &&
      typeof authInfo.accountExpiresAt !== 'number')
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const now = Date.now();

  if (authInfo.username === process.env.USERNAME) {
    if (authInfo.role !== 'owner') {
      return NextResponse.json({ error: 'Role changed' }, { status: 401 });
    }
  } else {
    const userInfo = await db.getUserInfoV2(authInfo.username);

    if (!userInfo) {
      return NextResponse.json({ error: 'User not found' }, { status: 401 });
    }

    if (userInfo.banned) {
      return NextResponse.json({ error: 'User banned' }, { status: 403 });
    }

    if (userInfo.role !== authInfo.role) {
      return NextResponse.json({ error: 'Role changed' }, { status: 401 });
    }

    const config = await getConfig();
    const access = resolveAccountAccess(config, authInfo.username, now);
    if (access.status === 'disabled') {
      return NextResponse.json({ error: 'Account disabled' }, { status: 403 });
    }
    if (access.isExpired) {
      return NextResponse.json({ error: 'Account expired' }, { status: 403 });
    }
    authInfo.accountExpiresAt = access.expiresAt;
  }

  // 只检查 Refresh Token 是否过期
  if (now >= authInfo.refreshExpires) {
    return NextResponse.json(
      { error: 'Refresh token expired' },
      { status: 401 }
    );
  }

  // 只要 Refresh Token 有效，就允许刷新（即使 Access Token 已过期）

  const newAuthData = await refreshAccessToken(
    authInfo.username,
    authInfo.role,
    authInfo.tokenId,
    authInfo.refreshToken,
    authInfo.refreshExpires,
    authInfo.accountExpiresAt ?? null
  );

  if (!newAuthData) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const response = buildRefreshResponse(newAuthData);
  const expires = new Date(
    authInfo.accountExpiresAt
      ? Math.min(authInfo.refreshExpires, authInfo.accountExpiresAt)
      : authInfo.refreshExpires
  );
  response.cookies.set('auth', newAuthData, {
    path: '/',
    expires,
    sameSite: 'lax',
    httpOnly: false,
    secure: false,
  });
  return response;
}
