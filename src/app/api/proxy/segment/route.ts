/* eslint-disable @typescript-eslint/no-explicit-any */

import { NextResponse } from "next/server";

import { getConfig } from "@/lib/config";

export const runtime = 'nodejs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const targetUrl = searchParams.get('url');
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
  const timeout = setTimeout(() => controller.abort(), 25000);
  request.signal.addEventListener('abort', () => controller.abort(), { once: true });

  try {
    const forwardedRange = request.headers.get('range');
    const upstream = await fetch(targetUrl, {
      cache: 'no-store',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'User-Agent': liveSource.ua || 'AptvPlayer/1.4.10',
        ...(forwardedRange ? { Range: forwardedRange } : {}),
      },
    });

    if (!upstream.ok && upstream.status !== 206) {
      clearTimeout(timeout);
      return NextResponse.json(
        { error: 'Failed to fetch segment', upstreamStatus: upstream.status },
        { status: upstream.status === 404 ? 404 : 502 },
      );
    }

    const headers = new Headers();
    headers.set('Content-Type', upstream.headers.get('Content-Type') || 'application/octet-stream');
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, Range, Origin, Accept');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    headers.set('Accept-Ranges', upstream.headers.get('Accept-Ranges') || 'bytes');
    headers.set('Cache-Control', 'public, max-age=30, s-maxage=120, stale-while-revalidate=60');

    for (const name of ['Content-Length', 'Content-Range', 'ETag', 'Last-Modified']) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }

    // Keep the upstream body streaming. The previous custom reader had a
    // cancellation flag that never changed and could leave vehicle requests hung.
    return new Response(upstream.body, {
      status: upstream.status,
      headers,
    });
  } catch (error: any) {
    clearTimeout(timeout);
    const timedOut = error?.name === 'AbortError' && !request.signal.aborted;
    return NextResponse.json(
      { error: timedOut ? 'Segment upstream timed out' : 'Failed to fetch segment' },
      { status: timedOut ? 504 : 502 },
    );
  }
}
