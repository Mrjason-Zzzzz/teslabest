import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import {
  isDirectPlayableUrl,
  readCastSessionForOwner,
  submitCastPayload,
  type CastPayload,
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
    if (!value || value.length > 120) {
      return NextResponse.json(
        { error: '请输入不超过 120 个字符的影片名称' },
        { status: 400, headers: noStore }
      );
    }
    try {
      new URL(value);
      return NextResponse.json(
        { error: '受保护的平台网页不能直接转成视频流，请填写片名后由本站资源匹配播放' },
        { status: 400, headers: noStore }
      );
    } catch {
      // A plain title is the expected search handoff input.
    }
    payload = { type: 'vod', query: value, label };
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
