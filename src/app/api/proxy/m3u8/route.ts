/* eslint-disable no-console,@typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";
import { getBaseUrl, resolveUrl } from "@/lib/live";

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  // URLSearchParams already returns the decoded value. Decoding a second time
  // corrupts signed URLs containing percent sequences.
  const targetUrl = searchParams.get('url');
  const allowCORS = searchParams.get('allowCORS') === 'true';
  const source = searchParams.get('moontv-source');
  if (!targetUrl) {
    return NextResponse.json({ error: 'Missing url' }, { status: 400 });
  }

  const config = await getConfig();
  const liveSource = config.LiveConfig?.find((item: any) => item.key === source);
  if (!liveSource) {
    return NextResponse.json({ error: 'Source not found' }, { status: 404 });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12000);
  try {
    const upstream = await fetch(targetUrl, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': liveSource.ua || 'AptvPlayer/1.4.10',
        Accept: 'application/vnd.apple.mpegurl,application/x-mpegURL,*/*',
      },
    });
    clearTimeout(timeout);

    if (!upstream.ok) {
      return NextResponse.json(
        { error: 'Failed to fetch playlist', upstreamStatus: upstream.status },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }

    const bytes = await upstream.arrayBuffer();
    const contentType = upstream.headers.get('Content-Type') || '';
    const preview = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.byteLength, 32))).trimStart();
    const pathname = new URL(upstream.url || targetUrl).pathname.toLowerCase();
    const isPlaylist =
      contentType.toLowerCase().includes('mpegurl') ||
      pathname.endsWith('.m3u8') ||
      preview.startsWith('#EXTM3U');

    const headers = new Headers();
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range');
    headers.set('Cache-Control', isPlaylist ? 'no-store' : 'public, max-age=30, s-maxage=120');

    if (!isPlaylist) {
      // application/octet-stream is frequently used for TS/fMP4 fragments.
      // Never decode it as text solely because of that generic MIME type.
      headers.set('Content-Type', contentType || 'application/octet-stream');
      return new Response(bytes, { status: 200, headers });
    }

    const playlist = new TextDecoder().decode(bytes);
    const modified = rewriteM3U8Content(
      playlist,
      getBaseUrl(upstream.url || targetUrl),
      request,
      allowCORS,
    );
    headers.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    return new Response(modified, { status: 200, headers });
  } catch (error: any) {
    clearTimeout(timeout);
    const timedOut = error?.name === 'AbortError';
    return NextResponse.json(
      { error: timedOut ? 'Playlist upstream timed out' : 'Failed to fetch playlist' },
      { status: timedOut ? 504 : 502 },
    );
  }
}

function rewriteM3U8Content(content: string, baseUrl: string, req: Request, allowCORS: boolean) {
  const proxyBase = `${new URL(req.url).origin}/api/proxy`;

  // 获取 moontv-source 参数
  const reqUrl = new URL(req.url);
  const source = reqUrl.searchParams.get('moontv-source') || '';

  const lines = content.split('\n');
  const rewrittenLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i].trim();

    // 处理 TS 片段 URL 和其他媒体文件
    if (line && !line.startsWith('#')) {
      const resolvedUrl = resolveUrl(baseUrl, line);
      const proxyUrl = allowCORS ? resolvedUrl : `${proxyBase}/segment?url=${encodeURIComponent(resolvedUrl)}&moontv-source=${source}`;
      rewrittenLines.push(proxyUrl);
      continue;
    }

    // 处理 EXT-X-MAP 标签中的 URI
    if (line.startsWith('#EXT-X-MAP:')) {
      line = rewriteMapUri(line, baseUrl, proxyBase, allowCORS, source);
    }

    // 处理 EXT-X-KEY 标签中的 URI
    if (line.startsWith('#EXT-X-KEY:')) {
      line = rewriteKeyUri(line, baseUrl, proxyBase, allowCORS, source);
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
          const proxyUrl = `${proxyBase}/m3u8?url=${encodeURIComponent(resolvedUrl)}&moontv-source=${source}`;
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

function rewriteMapUri(line: string, baseUrl: string, proxyBase: string, allowCORS: boolean, source: string) {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (uriMatch) {
    const originalUri = uriMatch[1];
    const resolvedUrl = resolveUrl(baseUrl, originalUri);
    const proxyUrl = allowCORS ? resolvedUrl : `${proxyBase}/segment?url=${encodeURIComponent(resolvedUrl)}&moontv-source=${source}`;
    return line.replace(uriMatch[0], `URI="${proxyUrl}"`);
  }
  return line;
}

function rewriteKeyUri(line: string, baseUrl: string, proxyBase: string, allowCORS: boolean, source: string) {
  const uriMatch = line.match(/URI="([^"]+)"/);
  if (uriMatch) {
    const originalUri = uriMatch[1];
    const resolvedUrl = resolveUrl(baseUrl, originalUri);
    const proxyUrl = allowCORS ? resolvedUrl : `${proxyBase}/key?url=${encodeURIComponent(resolvedUrl)}&moontv-source=${source}`;
    return line.replace(uriMatch[0], `URI="${proxyUrl}"`);
  }
  return line;
}