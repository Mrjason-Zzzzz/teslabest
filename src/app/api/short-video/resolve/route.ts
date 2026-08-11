import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  getShortVideoResolverStatus,
  resolveShortVideo,
  ShortVideoResolverError,
} from '@/lib/short-video/resolver.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
};

function requireLogin(request: NextRequest): NextResponse | null {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username) {
    return NextResponse.json(
      { error: 'Unauthorized', code: 'UNAUTHORIZED' },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }
  return null;
}

export async function GET(request: NextRequest) {
  const unauthorized = requireLogin(request);
  if (unauthorized) return unauthorized;

  return NextResponse.json(getShortVideoResolverStatus(), {
    headers: NO_STORE_HEADERS,
  });
}

export async function POST(request: NextRequest) {
  const unauthorized = requireLogin(request);
  if (unauthorized) return unauthorized;

  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > 4_096) {
    return NextResponse.json(
      { error: '请求内容过大', code: 'PAYLOAD_TOO_LARGE' },
      { status: 413, headers: NO_STORE_HEADERS }
    );
  }

  let rawBody: string;
  try {
    rawBody = await request.text();
  } catch {
    return NextResponse.json(
      { error: '无法读取请求内容', code: 'INVALID_BODY' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  if (rawBody.length > 4_096) {
    return NextResponse.json(
      { error: '请求内容过大', code: 'PAYLOAD_TOO_LARGE' },
      { status: 413, headers: NO_STORE_HEADERS }
    );
  }

  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return NextResponse.json(
      { error: '请求格式不正确', code: 'INVALID_JSON' },
      { status: 400, headers: NO_STORE_HEADERS }
    );
  }

  const url =
    body && typeof body === 'object' && !Array.isArray(body)
      ? (body as Record<string, unknown>).url
      : undefined;

  try {
    const result = await resolveShortVideo(url);
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof ShortVideoResolverError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }

    console.error('[short-video] Unexpected resolver error:', error);
    return NextResponse.json(
      { error: '短视频解析失败', code: 'INTERNAL_ERROR' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
