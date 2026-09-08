import { NextRequest, NextResponse } from 'next/server';

import { getAuthInfoFromCookie } from '@/lib/auth';
import { getFreshConfig, setCachedConfig } from '@/lib/config';
import { db } from '@/lib/db';
import {
  getDefaultWebLiveName,
  normalizeWebLiveSource,
} from '@/lib/tesla/web-live-source';

function sanitizeAcl(value: unknown): string[] {
  return Array.isArray(value)
    ? Array.from(
        new Set(
          value
            .filter((item): item is string => typeof item === 'string')
            .map((item) => item.trim())
            .filter(Boolean)
        )
      ).slice(0, 100)
    : [];
}

export async function POST(request: NextRequest) {
  try {
    const authInfo = getAuthInfoFromCookie(request);
    const username = authInfo?.username;
    const config = await getFreshConfig();
    if (username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '仅站长可管理网络直播源' },
        { status: 403 }
      );
    }

    const body = await request.json();
    const { action } = body;

    if (!config) {
      return NextResponse.json({ error: '配置不存在' }, { status: 404 });
    }

    if (!config.WebLiveConfig) {
      config.WebLiveConfig = [];
    }

    switch (action) {
      case 'toggleEnabled': {
        const { enabled } = body;
        config.WebLiveEnabled = enabled;
        break;
      }

      case 'add': {
        const { name, platform, roomId, allowedUsers, allowedTags } = body;
        if (!platform || !roomId) {
          return NextResponse.json({ error: '缺少必要参数' }, { status: 400 });
        }

        const normalized = normalizeWebLiveSource(platform, roomId);
        const key = `web_${Date.now()}`;
        if (config.WebLiveConfig.some((s) => s.key === key)) {
          return NextResponse.json({ error: 'Key已存在' }, { status: 400 });
        }

        config.WebLiveConfig.push({
          key,
          name:
            String(name || '').trim() ||
            getDefaultWebLiveName(normalized.platform, normalized.roomId),
          platform: normalized.platform,
          roomId: normalized.roomId,
          from: 'custom',
          disabled: false,
          allowedUsers: sanitizeAcl(allowedUsers),
          allowedTags: sanitizeAcl(allowedTags),
        });
        break;
      }

      case 'delete': {
        const { key } = body;
        const source = config.WebLiveConfig.find((s) => s.key === key);
        if (!source) {
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        }
        if (source.from === 'config') {
          return NextResponse.json(
            { error: '无法删除配置文件中的源' },
            { status: 400 }
          );
        }
        config.WebLiveConfig = config.WebLiveConfig.filter(
          (s) => s.key !== key
        );
        break;
      }

      case 'enable': {
        const { key } = body;
        const source = config.WebLiveConfig.find((s) => s.key === key);
        if (!source) {
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        }
        source.disabled = false;
        break;
      }

      case 'disable': {
        const { key } = body;
        const source = config.WebLiveConfig.find((s) => s.key === key);
        if (!source) {
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        }
        source.disabled = true;
        break;
      }

      case 'edit': {
        const { key, name, platform, roomId, allowedUsers, allowedTags } = body;
        const source = config.WebLiveConfig.find((s) => s.key === key);
        if (!source) {
          return NextResponse.json({ error: '源不存在' }, { status: 404 });
        }
        if (source.from === 'config') {
          return NextResponse.json(
            { error: '无法编辑配置文件中的源' },
            { status: 400 }
          );
        }
        const normalized = normalizeWebLiveSource(platform, roomId);
        source.name =
          String(name || '').trim() ||
          getDefaultWebLiveName(normalized.platform, normalized.roomId);
        source.platform = normalized.platform;
        source.roomId = normalized.roomId;
        if (allowedUsers !== undefined) {
          source.allowedUsers = sanitizeAcl(allowedUsers);
        }
        if (allowedTags !== undefined) {
          source.allowedTags = sanitizeAcl(allowedTags);
        }
        break;
      }

      case 'sort': {
        const { keys } = body;
        if (!Array.isArray(keys)) {
          return NextResponse.json(
            { error: '无效的排序数据' },
            { status: 400 }
          );
        }
        const sortedSources = keys
          .map((key) => config.WebLiveConfig!.find((s) => s.key === key))
          .filter((s): s is NonNullable<typeof s> => s !== undefined);
        config.WebLiveConfig = sortedSources;
        break;
      }

      default:
        return NextResponse.json({ error: '未知操作' }, { status: 400 });
    }

    await db.saveAdminConfig(config);
    await setCachedConfig(config);
    return NextResponse.json({ success: true });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '操作失败' },
      { status: 500 }
    );
  }
}
