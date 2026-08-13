import { NextRequest, NextResponse } from 'next/server';

import { getCachedLiveChannels } from '@/lib/live';
import { getConfig } from '@/lib/config';
import {
  isSourceAllowedForUser,
  requireFeaturePermission,
} from '@/lib/permissions';

export const runtime = 'nodejs';

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireFeaturePermission(
      request,
      'live',
      '无权限访问电视直播'
    );
    if (authResult instanceof NextResponse) return authResult;
    const { searchParams } = new URL(request.url);
    const sourceKey = searchParams.get('source');

    if (!sourceKey) {
      return NextResponse.json({ error: '缺少直播源参数' }, { status: 400 });
    }
    const config = await getConfig();
    const source = config.LiveConfig?.find((item) => item.key === sourceKey);
    if (
      !source ||
      source.disabled ||
      !(await isSourceAllowedForUser(authResult.username, source))
    ) {
      return NextResponse.json(
        { error: '无权限访问该直播源' },
        { status: 403 }
      );
    }

    // Channel selection does not need the potentially large XMLTV document.
    // Return the parsed playlist immediately; the EPG endpoint loads programme
    // data on demand.
    const channelData = await getCachedLiveChannels(sourceKey, {
      includeEpg: false,
    });

    if (!channelData) {
      return NextResponse.json({ error: '频道信息未找到' }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: channelData.channels,
    });
  } catch (error) {
    return NextResponse.json({ error: '获取频道信息失败' }, { status: 500 });
  }
}
