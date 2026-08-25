import { NextRequest, NextResponse } from 'next/server';

import { requireFeaturePermission } from '@/lib/permissions';

function validateRemoteUrl(value: string): URL {
  const parsed = new URL(value);
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('不支持的直播协议');
  }
  const host = parsed.hostname.toLowerCase();
  const octets = host.split('.').map(Number);
  const isPrivateV4 =
    octets.length === 4 &&
    octets.every(Number.isInteger) &&
    (octets[0] === 10 ||
      octets[0] === 127 ||
      (octets[0] === 169 && octets[1] === 254) ||
      (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) ||
      (octets[0] === 192 && octets[1] === 168));
  if (
    host === 'localhost' ||
    host.endsWith('.local') ||
    host.includes(':') ||
    isPrivateV4
  ) {
    throw new Error('直播地址不允许访问内网');
  }
  return parsed;
}

function toProxyUrl(value: string): string {
  return `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(value)}`;
}

function resolvePlaylistUri(value: string, sourceUrl: URL): string {
  const resolved = new URL(value, sourceUrl);
  return validateRemoteUrl(resolved.toString()).toString();
}

function processM3u8Content(content: string, sourceUrl: URL): string {
  return content
    .split('\n')
    .map((line) => {
      const trimmedLine = line.trim();
      if (!trimmedLine) return line;
      if (trimmedLine.startsWith('#')) {
        return line.replace(/URI=(['"])(.*?)\1/g, (_match, quote, uri) => {
          return `URI=${quote}${toProxyUrl(
            resolvePlaylistUri(uri, sourceUrl)
          )}${quote}`;
        });
      }
      return toProxyUrl(resolvePlaylistUri(trimmedLine, sourceUrl));
    })
    .join('\n');
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireFeaturePermission(
      request,
      'web_live',
      '无权限访问网络直播'
    );
    if (authResult instanceof NextResponse) return authResult;
    const { searchParams } = new URL(request.url);
    const url = searchParams.get('url');

    if (!url) {
      return NextResponse.json({ error: '缺少URL参数' }, { status: 400 });
    }

    const sourceUrl = validateRemoteUrl(url);

    // 根据URL判断Referer
    let referer = 'https://www.huya.com/';
    if (
      sourceUrl.href.includes('bilivideo.com') ||
      sourceUrl.href.includes('bilibili.com')
    ) {
      referer = 'https://live.bilibili.com/';
    } else if (
      sourceUrl.href.includes('douyin.com') ||
      sourceUrl.href.includes('douyincdn.com')
    ) {
      referer = 'https://live.douyin.com/';
    }

    const range = request.headers.get('range');
    const streamRes = await fetch(sourceUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        Referer: referer,
        ...(range ? { Range: range } : {}),
      },
      cache: 'no-store',
      signal: AbortSignal.timeout(12000),
    });

    if (!streamRes.ok) {
      return NextResponse.json({ error: '无法获取直播流' }, { status: 404 });
    }

    const contentType = streamRes.headers.get('Content-Type') || '';

    // 检测是否为m3u8文件
    const isM3u8 =
      sourceUrl.pathname.toLowerCase().endsWith('.m3u8') ||
      contentType.includes('application/vnd.apple.mpegurl') ||
      contentType.includes('application/x-mpegURL');

    if (isM3u8) {
      // 读取m3u8内容
      const content = await streamRes.text();
      const processedContent = processM3u8Content(content, sourceUrl);

      return new NextResponse(processedContent, {
        headers: {
          'Content-Type': 'application/vnd.apple.mpegurl',
          'Cache-Control': 'no-cache',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // 非m3u8文件，直接返回流
    return new NextResponse(streamRes.body, {
      status: streamRes.status,
      headers: {
        'Content-Type': contentType || 'application/octet-stream',
        'Cache-Control': 'private, max-age=15',
        'Access-Control-Allow-Origin': '*',
        ...(streamRes.headers.get('content-range')
          ? { 'Content-Range': streamRes.headers.get('content-range')! }
          : {}),
        ...(streamRes.headers.get('accept-ranges')
          ? { 'Accept-Ranges': streamRes.headers.get('accept-ranges')! }
          : {}),
      },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '代理失败' },
      { status: 500 }
    );
  }
}
