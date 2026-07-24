import { NextRequest, NextResponse } from 'next/server';

import { requireFeaturePermission } from '@/lib/permissions';

function getReferer(platform: string, url: string): string {
  if (platform === 'douyin' || /douyin|douyincdn|byteimg|bytedance/i.test(url)) {
    return 'https://live.douyin.com/';
  }
  if (platform === 'bilibili' || /bilivideo|bilibili/i.test(url)) {
    return 'https://live.bilibili.com/';
  }
  return 'https://www.huya.com/';
}

function buildProxyUrl(request: NextRequest, targetUrl: string, platform: string): string {
  const proxyUrl = new URL(request.nextUrl.pathname, request.nextUrl.origin);
  proxyUrl.searchParams.set('url', targetUrl);
  if (platform) proxyUrl.searchParams.set('platform', platform);
  return `${proxyUrl.pathname}${proxyUrl.search}`;
}

function resolveMediaUrl(value: string, playlistUrl: string): string {
  return new URL(value, playlistUrl).toString();
}

function processM3u8Content(
  content: string,
  playlistUrl: string,
  request: NextRequest,
  platform: string
): string {
  return content.split(/\r?\n/).map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // HLS keys, init maps and alternate media keep their addresses in URI="..."
    // attributes. These must use the same proxy as segments or Tesla browsers
    // will hit CORS / anti-hotlink failures after a manifest parses successfully.
    if (trimmed.startsWith('#')) {
      return line.replace(/URI=(['"])(.*?)\1/gi, (_match, quote: string, uri: string) => {
        try {
          const absoluteUrl = resolveMediaUrl(uri, playlistUrl);
          return `URI=${quote}${buildProxyUrl(request, absoluteUrl, platform)}${quote}`;
        } catch {
          return _match;
        }
      });
    }

    try {
      const absoluteUrl = resolveMediaUrl(trimmed, playlistUrl);
      return buildProxyUrl(request, absoluteUrl, platform);
    } catch {
      return line;
    }
  }).join('\n');
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireFeaturePermission(request, 'web_live', '无权限访问网络直播');
    if (authResult instanceof NextResponse) return authResult;

    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');
    const platform = searchParams.get('platform') || '';

    if (!url) {
      return NextResponse.json({ error: '缺少URL参数' }, { status: 400 });
    }

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return NextResponse.json({ error: '直播流URL无效' }, { status: 400 });
    }
    if (target.protocol !== 'https:' && target.protocol !== 'http:') {
      return NextResponse.json({ error: '仅支持HTTP直播流' }, { status: 400 });
    }

    const range = request.headers.get('range');
    const streamRes = await fetch(target, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36',
        'Referer': getReferer(platform, url),
        'Accept': '*/*',
        ...(range ? { Range: range } : {})
      },
      cache: 'no-store'
    });

    if (!streamRes.ok && streamRes.status !== 206) {
      return NextResponse.json(
        { error: `无法获取直播流（上游 ${streamRes.status}）` },
        { status: streamRes.status >= 400 && streamRes.status < 600 ? streamRes.status : 502 }
      );
    }

    const contentType = streamRes.headers.get('content-type') || '';
    const filename = request.nextUrl.pathname.split('/').pop()?.toLowerCase() || '';
    const isM3u8 = target.pathname.toLowerCase().endsWith('.m3u8') ||
      filename.endsWith('.m3u8') ||
      /mpegurl/i.test(contentType);

    if (isM3u8) {
      const content = await streamRes.text();
      const processedContent = processM3u8Content(content, target.toString(), request, platform);
      return new NextResponse(processedContent, {
        status: streamRes.status,
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-store, no-cache, must-revalidate',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }

    const responseHeaders = new Headers({
      'Content-Type': contentType || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*'
    });
    for (const headerName of ['content-length', 'content-range', 'accept-ranges']) {
      const value = streamRes.headers.get(headerName);
      if (value) responseHeaders.set(headerName, value);
    }

    return new NextResponse(streamRes.body, {
      status: streamRes.status,
      headers: responseHeaders
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '代理失败' },
      { status: 500 }
    );
  }
}
