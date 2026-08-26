/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import {
  deleteCachedLiveChannels,
  getBaseUrl,
  getCachedLiveChannels,
  resolveUrl,
} from '@/lib/live';
import {
  isSourceAllowedForUser,
  requireFeaturePermission,
} from '@/lib/permissions';
import { findSameLiveChannel } from '@/lib/tesla/live-channel-identity';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  const authResult = await requireFeaturePermission(
    request,
    'live',
    '无权限访问电视直播'
  );
  if (authResult instanceof NextResponse) return authResult;
  const { searchParams } = new URL(request.url);
  const url = searchParams.get('url');
  const allowCORS = searchParams.get('allowCORS') === 'true';
  const source = searchParams.get('moontv-source');
  const channelId = searchParams.get('moontv-channel');
  const channelTvgId = searchParams.get('moontv-channel-tvg') || '';
  const channelName = searchParams.get('moontv-channel-name') || '';
  const channelGroup = searchParams.get('moontv-channel-group') || '';
  const rootRequest = searchParams.get('moontv-root') === '1';
  if (!url) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  const config = await getConfig();
  const liveSource = config.LiveConfig?.find((s: any) => s.key === source);
  if (!liveSource) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }
  if (!(await isSourceAllowedForUser(authResult.username, liveSource))) {
    return NextResponse.json({ error: '无权限访问该直播源' }, { status: 403 });
  }
  const ua = liveSource.ua || 'AptvPlayer/1.4.10';

  let response: Response | null = null;
  let responseUsed = false;

  try {
    let decodedUrl = decodeURIComponent(url);

    if (rootRequest && source && channelId) {
      const probe = await fetch(decodedUrl, {
        cache: 'no-store',
        redirect: 'manual',
        headers: { 'User-Agent': ua },
      });
      if (probe.status >= 300 && probe.status < 400) {
        probe.body?.cancel().catch(() => undefined);
        deleteCachedLiveChannels(source);
        const refreshed = await getCachedLiveChannels(source, {
          includeEpg: false,
        });
        const exact = refreshed
          ? findSameLiveChannel(refreshed.channels, {
              id: channelId,
              tvgId: channelTvgId,
              name: channelName,
              group: channelGroup,
              url: decodedUrl,
            })
          : null;
        if (!exact) {
          console.warn('[LiveProxy] selected channel disappeared on refresh', {
            source,
            channelId,
            channelTvgId,
            channelName,
          });
          return NextResponse.json(
            { error: '所选频道地址已失效，请重试当前频道' },
            { status: 409 }
          );
        }
        decodedUrl = exact.url;
        console.info('[LiveProxy] refreshed the selected channel URL', {
          source,
          channelId,
          matchedChannelId: exact.id,
          matchedTvgId: exact.tvgId,
          urlChanged: decodedUrl !== decodeURIComponent(url),
        });
      } else {
        probe.body?.cancel().catch(() => undefined);
      }
    }

    response = await fetch(decodedUrl, {
      cache: 'no-cache',
      redirect: 'follow',
      credentials: 'same-origin',
      headers: {
        'User-Agent': ua,
      },
    });

    if (!response.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch m3u8' },
        { status: 500 }
      );
    }

    const contentType = response.headers.get('Content-Type') || '';
    // rewrite m3u8
    if (
      contentType.toLowerCase().includes('mpegurl') ||
      contentType.toLowerCase().includes('octet-stream')
    ) {
      // 获取最终的响应URL（处理重定向后的URL）
      const finalUrl = response.url;
      const m3u8Content = await response.text();
      responseUsed = true; // 标记 response 已被使用

      // 使用最终的响应URL作为baseUrl，而不是原始的请求URL
      const baseUrl = getBaseUrl(finalUrl);

      // 重写 M3U8 内容
      const modifiedContent = rewriteM3U8Content(
        m3u8Content,
        baseUrl,
        request,
        allowCORS
      );

      const headers = new Headers();
      headers.set('Content-Type', contentType);
      headers.set('Access-Control-Allow-Origin', '*');
      headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      headers.set(
        'Access-Control-Allow-Headers',
        'Content-Type, Range, Origin, Accept'
      );
      headers.set('Cache-Control', 'no-cache');
      headers.set(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range'
      );
      return new Response(modifiedContent, { headers });
    }
    // just proxy
    const headers = new Headers();
    headers.set(
      'Content-Type',
      response.headers.get('Content-Type') || 'application/vnd.apple.mpegurl'
    );
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set(
      'Access-Control-Allow-Headers',
      'Content-Type, Range, Origin, Accept'
    );
    headers.set('Cache-Control', 'no-cache');
    headers.set(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range'
    );

    // 直接返回视频流
    return new Response(response.body, {
      status: 200,
      headers,
    });
  } catch (error) {
    return NextResponse.json(
      { error: 'Failed to fetch m3u8' },
      { status: 500 }
    );
  } finally {
    // 确保 response 被正确关闭以释放资源
    if (response && !responseUsed) {
      try {
        response.body?.cancel();
      } catch (error) {
        // 忽略关闭时的错误
        console.warn('Failed to close response body:', error);
      }
    }
  }
}

function rewriteM3U8Content(
  content: string,
  baseUrl: string,
  req: Request,
  allowCORS: boolean
) {
  // 从 referer 头提取协议信息
  const referer = req.headers.get('referer');
  let protocol = 'http';
  if (referer) {
    try {
      const refererUrl = new URL(referer);
      protocol = refererUrl.protocol.replace(':', '');
    } catch (error) {
      // ignore
    }
  }

  const host = req.headers.get('host');
  const proxyBase = `${protocol}://${host}/api/proxy`;

  // 获取 moontv-source 参数
  const reqUrl = new URL(req.url);
  const source = reqUrl.searchParams.get('moontv-source') || '';
  const channel = reqUrl.searchParams.get('moontv-channel') || '';
  const identityParams = `&moontv-source=${encodeURIComponent(
    source
  )}&moontv-channel=${encodeURIComponent(channel)}`;

  const lines = content.split('\n');
  const rewrittenLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // 处理 TS 片段 URL 和其他媒体文件
    if (line && !line.startsWith('#')) {
      const resolvedUrl = resolveUrl(baseUrl, line);
      const proxyUrl = allowCORS
        ? resolvedUrl
        : `${proxyBase}/segment?url=${encodeURIComponent(
            resolvedUrl
          )}${identityParams}`;
      rewrittenLines.push(proxyUrl);
      continue;
    }

    // 处理 EXT-X-MAP 标签中的 URI
    if (line.startsWith('#EXT-X-MAP:')) {
      line = rewriteMapUri(line, baseUrl, proxyBase, allowCORS, identityParams);
    }

    // 处理 EXT-X-KEY 标签中的 URI
    if (line.startsWith('#EXT-X-KEY:')) {
      line = rewriteKeyUri(line, baseUrl, proxyBase, allowCORS, identityParams);
    }

    // 处理嵌套的 M3U8 文件 (EXT-X-STREAM-INF)
    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      rewrittenLines.push(line);
      // 下一行通常是 M3U8 URL
      if (i + 1 < lines.length) {
        i++;
        const nextLine = lines[i].trim();
        if (nextLine && !nextLine.startsWith('#')) {
          const resolvedUrl = resolveUrl(baseUrl, nextLine);
          const proxyUrl = `${proxyBase}/m3u8?url=${encodeURIComponent(
            resolvedUrl
          )}${identityParams}`;
          rewrittenLines.push(proxyUrl);
        } else {
          rewrittenLines.push(nextLine);
        }
      }
      continue;
    }

    rewrittenLines.push(line);
  }

  return rewrittenLines.join('\n');
}

function rewriteMapUri(
  line: string,
  baseUrl: string,
  proxyBase: string,
  allowCORS: boolean,
  identityParams: string
) {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (uriMatch) {
    const originalUri = uriMatch[1];
    const resolvedUrl = resolveUrl(baseUrl, originalUri);
    const proxyUrl = allowCORS
      ? resolvedUrl
      : `${proxyBase}/segment?url=${encodeURIComponent(
          resolvedUrl
        )}${identityParams}`;
    return line.replace(uriMatch[0], `URI="${proxyUrl}"`);
  }
  return line;
}

function rewriteKeyUri(
  line: string,
  baseUrl: string,
  proxyBase: string,
  allowCORS: boolean,
  identityParams: string
) {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (uriMatch) {
    const originalUri = uriMatch[1];
    const resolvedUrl = resolveUrl(baseUrl, originalUri);
    const proxyUrl = allowCORS
      ? resolvedUrl
      : `${proxyBase}/key?url=${encodeURIComponent(
          resolvedUrl
        )}${identityParams}`;
    return line.replace(uriMatch[0], `URI="${proxyUrl}"`);
  }
  return line;
}
