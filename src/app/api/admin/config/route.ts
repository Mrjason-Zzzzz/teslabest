/* eslint-disable no-console */

import { NextRequest, NextResponse } from 'next/server';

import { AdminConfigResult } from '@/lib/admin.types';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig } from '@/lib/config';

export const runtime = 'nodejs';

function createAdminSafeConfig(config: AdminConfigResult['Config']) {
  const safe = JSON.parse(
    JSON.stringify(config)
  ) as AdminConfigResult['Config'];
  safe.ConfigFile = '';
  safe.ConfigSubscribtion = {
    ...safe.ConfigSubscribtion,
    URL: '',
    AutoUpdate: false,
  };
  safe.SiteConfig = {
    ...safe.SiteConfig,
    DanmakuApiToken: '',
    TMDBApiKey: '',
    TMDBProxy: '',
    TMDBReverseProxy: '',
    TurnstileSecretKey: '',
    OIDCClientSecret: '',
    AnalyticsCustomScript: '',
  };
  safe.UserConfig.RedemptionCodes = [];
  safe.UserConfig.AccessPolicies = {};

  const extensionKeys = [
    'OpenListConfig',
    'EmbyConfig',
    'XiaoyaConfig',
    'NetDiskConfig',
    'AIConfig',
    'EmailConfig',
    'TelegramConfig',
    'MusicConfig',
    'SuwayomiConfig',
    'OPDSConfig',
  ];
  const safeRecord = safe as unknown as Record<string, unknown>;
  extensionKeys.forEach((key) => {
    if (key in safeRecord) safeRecord[key] = {};
  });
  return safe;
}

export async function GET(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      {
        error: '不支持本地存储进行管理员配置',
      },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    const config = await getConfig();
    const result: AdminConfigResult = {
      Role: 'owner',
      Config: config,
    };
    if (username === process.env.USERNAME) {
      result.Role = 'owner';
    } else {
      // 从新版数据库获取用户信息
      const { db } = await import('@/lib/db');
      const userInfoV2 = await db.getUserInfoV2(username);

      if (userInfoV2 && userInfoV2.role === 'admin' && !userInfoV2.banned) {
        result.Role = 'admin';
        result.Config = createAdminSafeConfig(config);
      } else {
        return NextResponse.json(
          { error: '你是管理员吗你就访问？' },
          { status: 401 }
        );
      }
    }

    return NextResponse.json(result, {
      headers: {
        'Cache-Control': 'no-store', // 管理员配置不缓存
      },
    });
  } catch (error) {
    console.error('获取管理员配置失败:', error);
    return NextResponse.json(
      {
        error: '获取管理员配置失败',
        details: (error as Error).message,
      },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return NextResponse.json(
      { error: '不支持本地存储进行管理员配置' },
      { status: 400 }
    );
  }

  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo || !authInfo.username) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const username = authInfo.username;

  try {
    const newConfig = await request.json();

    // 通用全量配置可覆盖密钥与权限策略，只允许站长写入。
    if (username !== process.env.USERNAME) {
      return NextResponse.json(
        { error: '仅站长可修改全局配置' },
        { status: 403 }
      );
    }

    // 保存配置
    const { db } = await import('@/lib/db');
    const { configSelfCheck, setCachedConfig } = await import('@/lib/config');

    // 自检配置
    const checkedConfig = configSelfCheck(newConfig);

    // 保存到数据库
    await db.saveAdminConfig(checkedConfig);

    // 更新缓存
    await setCachedConfig(checkedConfig);

    return NextResponse.json({ success: true, message: '配置已保存' });
  } catch (error) {
    console.error('保存配置失败:', error);
    return NextResponse.json(
      { error: '保存配置失败: ' + (error as Error).message },
      { status: 500 }
    );
  }
}
