/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import {
  isSourceAllowedForUser,
  requireFeaturePermission,
} from '@/lib/permissions';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authResult = await requireFeaturePermission(
    request,
    'live',
    '无权限访问电视直播'
  );
  if (authResult instanceof NextResponse) return authResult;
  const { searchParams } = new URL(request.url);
  const imageUrl = searchParams.get('url');
  const source =
    searchParams.get('moontv-source') || searchParams.get('source');

  if (!imageUrl) {
    return NextResponse.json({ error: 'Missing image URL' }, { status: 400 });
  }

  const config = await getConfig();
  const liveSource = config.LiveConfig?.find((s: any) => s.key === source);
  if (
    !liveSource ||
    !(await isSourceAllowedForUser(authResult.username, liveSource))
  ) {
    return NextResponse.json({ error: '无权限访问该直播源' }, { status: 403 });
  }
  const ua = liveSource?.ua || 'AptvPlayer/1.4.10';

  try {
    const decodedUrl = decodeURIComponent(imageUrl);
    const imageResponse = await fetch(decodedUrl, {
      cache: 'no-cache',
      redirect: 'follow',
      credentials: 'same-origin',
      headers: {
        'User-Agent': ua,
      },
    });

    if (!imageResponse.ok) {
      return NextResponse.json(
        { error: imageResponse.statusText },
        { status: imageResponse.status }
      );
    }

    const contentType = imageResponse.headers.get('content-type');

    if (!imageResponse.body) {
      return NextResponse.json(
        { error: 'Image response has no body' },
        { status: 500 }
      );
    }

    // 创建响应头
    const headers = new Headers();
    if (contentType) {
      headers.set('Content-Type', contentType);
    }

    // 设置缓存头
    headers.set('Cache-Control', 'public, max-age=86400, s-maxage=86400'); // 缓存一天

    // 直接返回图片流
    return new Response(imageResponse.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Error fetching image' },
      { status: 500 }
    );
  }
}
