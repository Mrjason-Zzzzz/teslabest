import { NextRequest, NextResponse } from 'next/server';

import { requireFeaturePermission } from '@/lib/permissions';
import {
  fetchShortVideoFeed,
  ShortVideoResolverError,
} from '@/lib/short-video/resolver.server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const NO_STORE_HEADERS = {
  'Cache-Control': 'private, no-store, max-age=0',
};

export async function GET(request: NextRequest) {
  const authResult = await requireFeaturePermission(
    request,
    'short_video',
    '无权限访问刷视频'
  );
  if (authResult instanceof NextResponse) return authResult;

  try {
    const result = await fetchShortVideoFeed(
      request.nextUrl.searchParams.get('cursor'),
      request.nextUrl.searchParams.get('limit')
    );
    return NextResponse.json(result, { headers: NO_STORE_HEADERS });
  } catch (error) {
    if (error instanceof ShortVideoResolverError) {
      return NextResponse.json(
        { error: error.message, code: error.code },
        { status: error.status, headers: NO_STORE_HEADERS }
      );
    }

    console.error('[short-video-feed] Unexpected resolver error:', error);
    return NextResponse.json(
      { error: '短视频推荐流加载失败', code: 'INTERNAL_ERROR' },
      { status: 500, headers: NO_STORE_HEADERS }
    );
  }
}
