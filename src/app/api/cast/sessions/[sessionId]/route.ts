import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  type CastPayload,
  isDirectPlayableUrl,
  readCastSessionForOwner,
  readCastSessionForToken,
  submitCastPayload,
} from '@/lib/cast-session';
import { resolvePublicWebLiveSource } from '@/lib/tesla/web-live-source';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const noStore = { 'Cache-Control': 'no-store, max-age=0' };

export async function GET(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const auth = getAuthInfoFromCookie(request);
  if (!auth?.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const session = await readCastSessionForOwner(params.sessionId, auth.username);
  if (!session) {
    return NextResponse.json({ error: 'Session expired' }, { status: 404 });
  }
  return NextResponse.json(session, { headers: noStore });
}

export async function POST(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const token = request.nextUrl.searchParams.get('token') || '';
  const body = (await request.json().catch(() => null)) as {
    type?: string;
    value?: string;
    label?: string;
  } | null;
  const value = body?.value?.trim() || '';
  const label = body?.label?.trim().slice(0, 120) || undefined;

  let payload: CastPayload;
  if (body?.type === 'live') {
    if (!value || value.length > 2048) {
      return NextResponse.json(
        { error: '请输入直播直链或公开直播间链接' },
        { status: 400, headers: noStore }
      );
    }
    if (isDirectPlayableUrl(value)) {
      payload = { type: 'direct', url: value, label };
    } else {
      try {
        const resolved = await resolvePublicWebLiveSource(value);
        payload = { type: 'live', ...resolved, label };
      } catch (error) {
        return NextResponse.json(
          {
            error:
              error instanceof Error
                ? error.message
                : '未能识别公开直播间链接',
          },
          { status: 400, headers: noStore }
        );
      }
    }
  } else if (body?.type === 'vod') {
    const structured = body as typeof body & {
      source?: string;
      id?: string;
      title?: string;
      year?: string;
      episodeIndex?: number;
    };
    const source = structured.source?.trim() || '';
    const id = structured.id?.trim() || '';
    const title = structured.title?.trim() || '';
    if (source && id && title) {
      const session = await readCastSessionForToken(params.sessionId, token);
      if (!session) {
        return NextResponse.json(
          { error: '二维码已过期或无效，请在车机重新打开接力页' },
          { status: 404, headers: noStore }
        );
      }
      const { getAvailableApiSites } = await import('@/lib/config');
      const sites = await getAvailableApiSites(session.owner);
      if (!sites.some((site) => site.key === source)) {
        return NextResponse.json(
          { error: '所选资源已停用，请重新搜索' },
          { status: 400, headers: noStore }
        );
      }
      if (id.length > 300 || title.length > 160) {
        return NextResponse.json(
          { error: '资源参数过长，请重新选择' },
          { status: 400, headers: noStore }
        );
      }
      payload = {
        type: 'vod',
        source,
        id,
        title,
        year: structured.year?.trim().slice(0, 12),
        episodeIndex: Math.max(
          0,
          Math.min(9999, Math.floor(Number(structured.episodeIndex) || 0))
        ),
        label,
      };
    } else {
      if (!value || value.length > 120) {
        return NextResponse.json(
          { error: '请输入不超过 120 个字符的影片名称' },
          { status: 400, headers: noStore }
        );
      }
      try {
        new URL(value);
        return NextResponse.json(
          {
            error:
              '受保护的平台网页不能直接转成视频流，请填写片名后由本站资源匹配播放',
          },
          { status: 400, headers: noStore }
        );
      } catch {
        // A plain title is the expected search handoff input.
      }
      payload = { type: 'vod', query: value, label };
    }
  } else {
    return NextResponse.json(
      { error: 'Unsupported cast payload' },
      { status: 400, headers: noStore }
    );
  }

  const session = await submitCastPayload(params.sessionId, token, payload);
  if (!session) {
    return NextResponse.json(
      { error: '二维码已过期或无效，请在车机重新打开接力页' },
      { status: 404, headers: noStore }
    );
  }
  return NextResponse.json({ ok: true }, { headers: noStore });
}
