/* eslint-disable @typescript-eslint/no-explicit-any, no-console, @typescript-eslint/no-non-null-assertion */

import { db } from '@/lib/db';

import { AdminConfig } from './admin.types';

const BUILTIN_DANMAKU_API_BASE = 'https://danmu.dorezst.cn/980728';
const BUILTIN_DANMAKU_API_TOKEN = '980728';
const DEFAULT_LIVE_REFRESH_INTERVAL_HOURS = 12;

function normalizeLiveRefreshIntervalHours(
  refreshIntervalHours?: number
): number {
  const normalizedInterval = Number(refreshIntervalHours);

  if (!Number.isFinite(normalizedInterval) || normalizedInterval <= 0) {
    return DEFAULT_LIVE_REFRESH_INTERVAL_HOURS;
  }

  return Math.floor(normalizedInterval);
}

export interface ApiSite {
  key: string;
  api: string;
  name: string;
  detail?: string;
  proxyMode?: boolean;
}

export interface LiveCfg {
  name: string;
  url: string;
  ua?: string;
  epg?: string; // 节目单
}

interface ConfigFileStruct {
  cache_time?: number;
  api_site?: {
    [key: string]: ApiSite;
  };
  custom_category?: {
    name?: string;
    type: 'movie' | 'tv';
    query: string;
  }[];
  lives?: {
    [key: string]: LiveCfg;
  };
  web_live?: {
    key: string;
    name: string;
    platform: string;
    roomId: string;
  }[];
  special_source_apis?: string[];
  specialSourceApis?: string[];
}

export const API_CONFIG = {
  search: {
    path: '?ac=videolist&wd=',
    pagePath: '?ac=videolist&wd={query}&pg={page}',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  },
  detail: {
    path: '?ac=videolist&ids=',
    headers: {
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      Accept: 'application/json',
    },
  },
};

// 内置默认资源（写死在代码中，按用户原始配置文件整理）。
// 收录标准：已验证连通、HTTPS、标准苹果CMS采集接口或可获取的 m3u 直播列表。
// 数据库配置丢失或条目被删除后，这些条目会在读取配置时自动恢复；
// 后台仍可“停用”单个内置源。设置环境变量 ENABLE_BUILTIN_SOURCES=false 可整体关闭。
const BUILTIN_DEFAULT_CONFIG: ConfigFileStruct = {
  cache_time: 7200,
  api_site: {
    mtm3u8: {
      key: 'mtm3u8',
      name: '茅台资源',
      api: 'https://caiji.maotai999.vip/api.php/provide/vod/',
      detail: 'https://caiji.maotai999.vip',
    },
    modum3u8: {
      key: 'modum3u8',
      name: '魔都资源',
      api: 'https://www.moduzy.com/api.php/provide/vod/from/modum3u8/',
      detail: 'https://www.moduzy.com',
    },
    bfzym3u8: {
      key: 'bfzym3u8',
      name: '非凡影视',
      api: 'https://cj.ffzyapi.com/api.php/provide/vod/from/ffm3u8/',
      detail: 'https://cj.ffzyapi.com',
    },
    lzm3u8: {
      key: 'lzm3u8',
      name: '360资源',
      api: 'https://360zy.com/api.php/provide/vod/from/lzm3u8/',
      detail: 'https://360zy.com',
    },
    bdm3u8: {
      key: 'bdm3u8',
      name: '极速资源',
      api: 'https://jszyapi.com/api.php/provide/vod',
      detail: 'https://jszyapi.com',
    },
    nby: {
      key: 'nby',
      name: '无尽资源',
      api: 'https://api.wujinapi.me/api.php/provide/vod',
      detail: 'https://api.wujinapi.me',
    },
    ikun: {
      key: 'ikun',
      name: 'IKUN资源',
      api: 'https://ikunzy.com/api.php/provide/vod',
      detail: '',
    },
    jisu: {
      key: 'jisu',
      name: '极速专线',
      api: 'https://jszyapi.com/api.php/provide/vod/from/m3u8',
      detail: '',
    },
  },
  custom_category: [
    { name: '华语电影', type: 'movie', query: '华语' },
    { name: '欧美电影', type: 'movie', query: '欧美' },
    { name: '豆瓣高分', type: 'movie', query: '豆瓣高分' },
    { name: '国产剧', type: 'tv', query: '国产剧' },
    { name: '美剧', type: 'tv', query: '美剧' },
    { name: '韩剧', type: 'tv', query: '韩剧' },
    { name: '综艺', type: 'tv', query: '综艺' },
    { name: '纪录片', type: 'tv', query: '纪录片' },
    { name: '短剧', type: 'tv', query: '短剧' },
  ],
  lives: {
    guovin: {
      name: 'Guovin',
      url: 'https://cdn.jsdelivr.net/gh/Guovin/iptv-api@gd/output/result.m3u',
    },
    ghfast: {
      name: 'ghfast',
      url: 'https://ghfast.top/raw.githubusercontent.com/TianmuTNT/iptv/main/iptv.m3u',
    },
    itvlist: {
      name: 'itvlist',
      url: 'https://raw.githubusercontent.com/mzky/checklist/refs/heads/master/itvlist.m3u',
    },
    suxuang: {
      name: 'suxuang',
      url: 'https://raw.githubusercontent.com/suxuang/myIPTV/main/ipv4.m3u',
    },
  },
  web_live: [
    { key: 'web_cctv13', name: 'CCTV13', platform: 'douyin', roomId: '547977714661' },
    { key: 'web_cctv6', name: 'CCTV6', platform: 'douyin', roomId: '232551178364' },
    { key: 'web_cctv2', name: 'CCTV2', platform: 'douyin', roomId: '296728101980' },
    { key: 'web_zengxiaoxian', name: '曾小咸', platform: 'huya', roomId: '11336726' },
    { key: 'web_zhouxingxing', name: '周星星', platform: 'huya', roomId: '11342412' },
    { key: 'web_gangpianjingdian', name: '港片经典', platform: 'huya', roomId: '30682679' },
  ],
};

// 在模块加载时根据环境决定配置来源
let cachedConfig: AdminConfig;
let cachedConfigAt = 0;
let configInitPromise: Promise<AdminConfig> | null = null;

// 把写死的资源站与直播源合并进当前配置：
// - 已存在的条目只标记为配置文件来源（from: 'config'，后台不可删除），
//   不改写 name/api/detail/url，尊重数据库中已配置的值；
// - 不存在的条目自动补回，实现“删除后自动恢复”。
// 设置环境变量 ENABLE_BUILTIN_SOURCES=false 可整体关闭内置合并。
function mergeBuiltinSources(adminConfig: AdminConfig): void {
  if (process.env.ENABLE_BUILTIN_SOURCES === 'false') {
    return;
  }

  const sources = new Map(
    (adminConfig.SourceConfig || []).map((s) => [s.key, s])
  );
  Object.entries(BUILTIN_DEFAULT_CONFIG.api_site || {}).forEach(
    ([key, site]) => {
      const existing = sources.get(key);
      if (existing) {
        existing.from = 'config';
      } else {
        sources.set(key, {
          key,
          name: site.name,
          api: site.api,
          detail: site.detail,
          from: 'config',
          disabled: false,
        });
      }
    }
  );
  adminConfig.SourceConfig = Array.from(sources.values());

  const lives = new Map((adminConfig.LiveConfig || []).map((l) => [l.key, l]));
  Object.entries(BUILTIN_DEFAULT_CONFIG.lives || {}).forEach(
    ([key, live]) => {
      const existing = lives.get(key);
      if (existing) {
        existing.from = 'config';
      } else {
        lives.set(key, {
          key,
          name: live.name,
          url: live.url,
          ua: live.ua,
          epg: live.epg,
          channelNumber: 0,
          from: 'config',
          disabled: false,
        });
      }
    }
  );
  adminConfig.LiveConfig = Array.from(lives.values());

  // 自定义分类：已有条目保留数据库配置，缺失条目补回
  const categories = new Map(
    (adminConfig.CustomCategories || []).map((c) => [c.query + c.type, c])
  );
  (BUILTIN_DEFAULT_CONFIG.custom_category || []).forEach((category) => {
    const key = category.query + category.type;
    const existing = categories.get(key);
    if (existing) {
      existing.from = 'config';
    } else {
      categories.set(key, {
        name: category.name || category.query,
        type: category.type,
        query: category.query,
        from: 'config',
        disabled: false,
      });
    }
  });
  adminConfig.CustomCategories = Array.from(categories.values());

  // 网络直播源：已有条目保留数据库配置，缺失条目补回
  if (!adminConfig.WebLiveConfig) {
    adminConfig.WebLiveConfig = [];
  }
  const webLives = new Map(
    adminConfig.WebLiveConfig.map((w) => [w.key, w])
  );
  (BUILTIN_DEFAULT_CONFIG.web_live || []).forEach((live) => {
    const existing = webLives.get(live.key);
    if (existing) {
      existing.from = 'config';
    } else {
      webLives.set(live.key, {
        key: live.key,
        name: live.name,
        platform: live.platform,
        roomId: live.roomId,
        from: 'config',
        disabled: false,
      });
    }
  });
  adminConfig.WebLiveConfig = Array.from(webLives.values());
}

// 从配置文件补充管理员配置
export function refineConfig(adminConfig: AdminConfig): AdminConfig {
  let fileConfig: ConfigFileStruct;
  try {
    fileConfig = JSON.parse(adminConfig.ConfigFile) as ConfigFileStruct;
  } catch (e) {
    fileConfig = {} as ConfigFileStruct;
  }

  // 合并文件中的源信息
  const apiSitesFromFile = Object.entries(fileConfig.api_site || []);
  const currentApiSites = new Map(
    (adminConfig.SourceConfig || []).map((s) => [s.key, s])
  );

  apiSitesFromFile.forEach(([key, site]) => {
    const existingSource = currentApiSites.get(key);
    if (existingSource) {
      // 如果已存在，只覆盖 name、api、detail 和 from
      existingSource.name = site.name;
      existingSource.api = site.api;
      existingSource.detail = site.detail;
      existingSource.from = 'config';
    } else {
      // 如果不存在，创建新条目
      currentApiSites.set(key, {
        key,
        name: site.name,
        api: site.api,
        detail: site.detail,
        from: 'config',
        disabled: false,
      });
    }
  });

  // 检查现有源是否在 fileConfig.api_site 中，如果不在则标记为 custom
  const apiSitesFromFileKey = new Set(apiSitesFromFile.map(([key]) => key));
  currentApiSites.forEach((source) => {
    if (!apiSitesFromFileKey.has(source.key)) {
      source.from = 'custom';
    }
  });

  // 将 Map 转换回数组
  adminConfig.SourceConfig = Array.from(currentApiSites.values());

  const specialApisFromFile = Array.isArray(fileConfig.special_source_apis)
    ? fileConfig.special_source_apis
    : Array.isArray(fileConfig.specialSourceApis)
    ? fileConfig.specialSourceApis
    : undefined;
  if (specialApisFromFile) {
    const sourceKeys = new Set(
      adminConfig.SourceConfig.map((source) => source.key)
    );
    adminConfig.SpecialSourceApis = Array.from(
      new Set(specialApisFromFile)
    ).filter((key) => sourceKeys.has(key));
  }

  // 覆盖 CustomCategories
  const customCategoriesFromFile = fileConfig.custom_category || [];
  const currentCustomCategories = new Map(
    (adminConfig.CustomCategories || []).map((c) => [c.query + c.type, c])
  );

  customCategoriesFromFile.forEach((category) => {
    const key = category.query + category.type;
    const existedCategory = currentCustomCategories.get(key);
    if (existedCategory) {
      existedCategory.name = category.name;
      existedCategory.query = category.query;
      existedCategory.type = category.type;
      existedCategory.from = 'config';
    } else {
      currentCustomCategories.set(key, {
        name: category.name,
        type: category.type,
        query: category.query,
        from: 'config',
        disabled: false,
      });
    }
  });

  // 检查现有 CustomCategories 是否在 fileConfig.custom_category 中，如果不在则标记为 custom
  const customCategoriesFromFileKeys = new Set(
    customCategoriesFromFile.map((c) => c.query + c.type)
  );
  currentCustomCategories.forEach((category) => {
    if (!customCategoriesFromFileKeys.has(category.query + category.type)) {
      category.from = 'custom';
    }
  });

  // 将 Map 转换回数组
  adminConfig.CustomCategories = Array.from(currentCustomCategories.values());

  const livesFromFile = Object.entries(fileConfig.lives || []);
  const currentLives = new Map(
    (adminConfig.LiveConfig || []).map((l) => [l.key, l])
  );
  livesFromFile.forEach(([key, site]) => {
    const existingLive = currentLives.get(key);
    if (existingLive) {
      existingLive.name = site.name;
      existingLive.url = site.url;
      existingLive.ua = site.ua;
      existingLive.epg = site.epg;
    } else {
      // 如果不存在，创建新条目
      currentLives.set(key, {
        key,
        name: site.name,
        url: site.url,
        ua: site.ua,
        epg: site.epg,
        channelNumber: 0,
        from: 'config',
        disabled: false,
      });
    }
  });

  // 检查现有 LiveConfig 是否在 fileConfig.lives 中，如果不在则标记为 custom
  const livesFromFileKeys = new Set(livesFromFile.map(([key]) => key));
  currentLives.forEach((live) => {
    if (!livesFromFileKeys.has(live.key)) {
      live.from = 'custom';
    }
  });

  // 将 Map 转换回数组
  adminConfig.LiveConfig = Array.from(currentLives.values());

  return adminConfig;
}

async function getInitConfig(
  configFile: string,
  subConfig: {
    URL: string;
    AutoUpdate: boolean;
    LastCheck: string;
  } = {
    URL: '',
    AutoUpdate: false,
    LastCheck: '',
  }
): Promise<AdminConfig> {
  let cfgFile: ConfigFileStruct;

  // 优先从环境变量读取订阅 URL
  const envSubUrl = process.env.CONFIG_SUBSCRIPTION_URL || '';

  if (envSubUrl) {
    try {
      const response = await fetch(envSubUrl);
      if (response.ok) {
        const configContent = await response.text();
        const bs58 = (await import('bs58')).default;
        const decodedBytes = bs58.decode(configContent);
        const decodedContent = new TextDecoder().decode(decodedBytes);
        configFile = decodedContent;
        console.log('已从订阅 URL 获取配置');
      }
    } catch (e) {
      console.error('从订阅 URL 获取配置失败:', e);
    }
  }

  // 优先从环境变量读取配置，其次使用已保存的配置文件；
  // 都没有时使用代码内置默认配置（写死的资源站与直播源）
  const envConfig = process.env.INIT_CONFIG || '';
  const configSource =
    envConfig || configFile || JSON.stringify(BUILTIN_DEFAULT_CONFIG);

  try {
    cfgFile = JSON.parse(configSource) as ConfigFileStruct;
  } catch (e) {
    cfgFile = {} as ConfigFileStruct;
  }
  const hasCustomDanmakuEnv = Boolean(
    process.env.DANMAKU_API_BASE || process.env.DANMAKU_API_TOKEN
  );
  const adminConfig: AdminConfig = {
    ConfigFile: configSource,
    ConfigSubscribtion: subConfig,
    SiteConfig: {
      SiteName: process.env.NEXT_PUBLIC_SITE_NAME || 'MoonTVPlus',
      Announcement:
        process.env.ANNOUNCEMENT ||
        '本网站仅提供影视信息搜索服务，所有内容均来自第三方网站。本站不存储任何视频资源，不对任何内容的准确性、合法性、完整性负责。',
      AnnouncementDisplayMode:
        process.env.ANNOUNCEMENT_DISPLAY_MODE === 'every' ? 'every' : 'once',
      SearchDownstreamMaxPage:
        Number(process.env.NEXT_PUBLIC_SEARCH_MAX_PAGE) || 5,
      SiteInterfaceCacheTime: cfgFile.cache_time || 7200,
      DoubanProxyType:
        process.env.NEXT_PUBLIC_DOUBAN_PROXY_TYPE || 'cmliussss-cdn-tencent',
      DoubanProxy: process.env.NEXT_PUBLIC_DOUBAN_PROXY || '',
      DoubanImageProxyType:
        process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY_TYPE ||
        'cmliussss-cdn-tencent',
      DoubanImageProxy: process.env.NEXT_PUBLIC_DOUBAN_IMAGE_PROXY || '',
      DisableYellowFilter:
        process.env.NEXT_PUBLIC_DISABLE_YELLOW_FILTER === 'true',
      FluidSearch: process.env.NEXT_PUBLIC_FLUID_SEARCH !== 'false',
      // 弹幕配置
      DanmakuSourceType: hasCustomDanmakuEnv ? 'custom' : 'builtin',
      DanmakuApiBase:
        process.env.DANMAKU_API_BASE ||
        (hasCustomDanmakuEnv
          ? 'http://localhost:9321'
          : BUILTIN_DANMAKU_API_BASE),
      DanmakuApiToken:
        process.env.DANMAKU_API_TOKEN || BUILTIN_DANMAKU_API_TOKEN,
      // Fetching a full comment document is deliberately opt-in. This keeps
      // the first frame independent from the external danmaku service.
      DanmakuAutoLoadDefault: false,
      // TMDB is retired in P002. Empty compatibility fields allow older
      // persisted configs to load without deploying or exposing the feature.
      TMDBApiKey: '',
      TMDBProxy: '',
      TMDBReverseProxy: '',
      // 动漫/Bangumi配置
      BangumiDataSource:
        (process.env.NEXT_PUBLIC_BANGUMI_DATA_SOURCE as any) || 'direct',
      BangumiApiBaseUrl:
        process.env.BANGUMI_API_BASE_URL ||
        process.env.NEXT_PUBLIC_BANGUMI_API_BASE_URL ||
        'https://api.bgm.tv',
      BangumiImageBaseUrl:
        process.env.BANGUMI_IMAGE_BASE_URL ||
        process.env.NEXT_PUBLIC_BANGUMI_IMAGE_BASE_URL ||
        '',
      BangumiProxy: process.env.BANGUMI_PROXY || '',
      // Pansou配置
      PansouApiUrl: '',
      PansouUsername: '',
      PansouPassword: '',
      PansouKeywordBlocklist: '',
      // 磁链配置
      MagnetProxy: '',
      MagnetMikanReverseProxy: '',
      MagnetDmhyReverseProxy: '',
      MagnetAcgripReverseProxy: '',
      MagnetNyaaReverseProxy: '',
      // 评论功能开关
      EnableComments: false,
      EnableRegistration: false,
      RequireRegistrationInviteCode: false,
      RegistrationInviteCode: '',
      RequireRedemptionCode: true,
      RegistrationAccessMode: 'redemption',
      MembershipRenewalMessage: '如需续费请联系站长',
      SingleDeviceLoginEnabled: true,
      RegistrationRequireTurnstile: false,
      LoginRequireTurnstile: false,
      TurnstileSiteKey: '',
      TurnstileSecretKey: '',
      DefaultUserTags: [],
      // 流量统计配置
      AnalyticsEnabled: false,
      AnalyticsProvider: 'umami',
      AnalyticsScriptUrl: '',
      AnalyticsWebsiteId: '',
      AnalyticsCustomScript: '',
    },
    UserConfig: {
      Users: [],
    },
    SourceConfig: [],
    CustomCategories: [],
    LiveConfig: [],
    TelegramConfig: {
      enabled:
        process.env.TELEGRAM_BOT_ENABLED === 'true' ||
        Boolean(process.env.TELEGRAM_BOT_TOKEN),
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
      apiProxy: process.env.TELEGRAM_API_PROXY || '',
      apiBaseUrl: process.env.TELEGRAM_API_BASE_URL || '',
      loginEnabled: process.env.TELEGRAM_LOGIN_ENABLED !== 'false',
      bindingEnabled: process.env.TELEGRAM_BINDING_ENABLED !== 'false',
      registrationEnabled: process.env.TELEGRAM_REGISTRATION_ENABLED === 'true',
      notificationsEnabled:
        process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== 'false',
      defaultNotifications:
        process.env.TELEGRAM_DEFAULT_NOTIFICATIONS !== 'false',
    },
    SpecialSourceApis: Array.isArray(cfgFile.special_source_apis)
      ? cfgFile.special_source_apis
      : Array.isArray(cfgFile.specialSourceApis)
      ? cfgFile.specialSourceApis
      : [],
    ClientAdSourceApis: [],
  };

  // 用户信息已迁移到新版数据库，不再填充 UserConfig.Users
  // 保持为空数组，避免与新版用户系统冲突
  adminConfig.UserConfig.Users = [];

  // 从配置文件中补充源信息
  Object.entries(cfgFile.api_site || []).forEach(([key, site]) => {
    adminConfig.SourceConfig.push({
      key: key,
      name: site.name,
      api: site.api,
      detail: site.detail,
      from: 'config',
      disabled: false,
    });
  });

  // 从配置文件中补充自定义分类信息
  cfgFile.custom_category?.forEach((category) => {
    adminConfig.CustomCategories.push({
      name: category.name || category.query,
      type: category.type,
      query: category.query,
      from: 'config',
      disabled: false,
    });
  });

  // 从配置文件中补充直播源信息
  Object.entries(cfgFile.lives || []).forEach(([key, live]) => {
    if (!adminConfig.LiveConfig) {
      adminConfig.LiveConfig = [];
    }
    adminConfig.LiveConfig.push({
      key,
      name: live.name,
      url: live.url,
      ua: live.ua,
      epg: live.epg,
      channelNumber: 0,
      from: 'config',
      disabled: false,
    });
  });

  // 从配置文件中补充网络直播源信息
  (cfgFile.web_live || []).forEach((live) => {
    if (!adminConfig.WebLiveConfig) {
      adminConfig.WebLiveConfig = [];
    }
    adminConfig.WebLiveConfig.push({
      key: live.key,
      name: live.name,
      platform: live.platform,
      roomId: live.roomId,
      from: 'config',
      disabled: false,
    });
  });

  return adminConfig;
}

export async function getConfig(): Promise<AdminConfig> {
  // 直接使用内存缓存
  if (cachedConfig && Date.now() - cachedConfigAt < 5000) {
    return cachedConfig;
  }

  // 如果正在初始化，等待初始化完成
  if (configInitPromise) {
    return configInitPromise;
  }

  // 创建初始化 Promise
  configInitPromise = (async () => {
    const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';

    // localStorage 模式下直接从环境变量初始化
    if (storageType === 'localstorage') {
      console.log('localStorage 模式：从环境变量初始化配置');
      const adminConfig = await getInitConfig('');
      cachedConfig = configSelfCheck(adminConfig);
      cachedConfigAt = Date.now();
      configInitPromise = null;
      return cachedConfig;
    }

    // 读 db
    let adminConfig: AdminConfig | null = null;
    let dbReadFailed = false;
    try {
      adminConfig = await db.getAdminConfig();
    } catch (e) {
      console.error('获取管理员配置失败:', e);
      // A temporary outage must never create a writable default configuration.
      throw e;
    }

    // db 中无配置，执行一次初始化
    if (!adminConfig) {
      if (dbReadFailed) {
        // 数据库读取失败，使用默认配置但不保存，避免覆盖数据库
        console.warn('数据库读取失败，使用临时默认配置（不会保存到数据库）');
        adminConfig = await getInitConfig('');
      } else {
        // 数据库中确实没有配置，首次初始化并保存
        console.log('首次初始化配置');
        adminConfig = await getInitConfig('');
        await db.saveAdminConfig(adminConfig);
      }
    }

    // 检查是否有旧格式Emby配置需要迁移
    const needsEmbyMigration =
      adminConfig.EmbyConfig &&
      adminConfig.EmbyConfig.ServerURL &&
      !adminConfig.EmbyConfig.Sources;

    adminConfig = configSelfCheck(adminConfig);
    cachedConfig = adminConfig;
    cachedConfigAt = Date.now();

    // 如果进行了Emby配置迁移，保存到数据库
    if (!dbReadFailed && needsEmbyMigration) {
      try {
        await db.saveAdminConfig(adminConfig);
        console.log('[Config] Emby配置迁移已保存到数据库');
      } catch (error) {
        console.error('[Config] 保存迁移后的配置失败:', error);
      }
    }

    // 自动迁移用户（如果配置中有用户且V2存储支持）
    // 过滤掉站长后检查是否有需要迁移的用户
    const nonOwnerUsers = adminConfig.UserConfig.Users.filter(
      (u) => u.username !== process.env.USERNAME
    );
    if (!dbReadFailed && nonOwnerUsers.length > 0) {
      try {
        // 检查是否支持V2存储
        const storage = (db as any).storage;
        if (storage && typeof storage.createUserV2 === 'function') {
          console.log('检测到配置中有用户，开始自动迁移...');
          await db.migrateUsersFromConfig(adminConfig);
          // 迁移完成后，清空配置中的用户列表并保存
          adminConfig.UserConfig.Users = [];
          await db.saveAdminConfig(adminConfig);
          cachedConfig = adminConfig;
          console.log('用户自动迁移完成');
        }
      } catch (error) {
        console.error('自动迁移用户失败:', error);
        // 不影响主流程，继续执行
      }
    }

    // 清除初始化 Promise
    configInitPromise = null;
    return cachedConfig;
  })();

  try {
    return await configInitPromise;
  } finally {
    // Failed initializations must be retryable on the next request.
    configInitPromise = null;
  }
}

/**
 * Read the persisted configuration instead of a process-local snapshot.
 * Account expiry and redemption state must be visible across Vercel instances;
 * using getConfig() alone can leave one warm instance showing a redeemed code
 * as active after another instance already saved the change.
 */
export async function getFreshConfig(): Promise<AdminConfig> {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') return getConfig();

  const persisted = await db.getAdminConfig();
  if (!persisted) {
    throw new Error('管理员配置缺失，请恢复备份；已阻止使用缓存覆盖数据库');
  }
  cachedConfig = configSelfCheck(persisted);
  cachedConfigAt = Date.now();
  configInitPromise = null;
  return cachedConfig;
}

export function configSelfCheck(adminConfig: AdminConfig): AdminConfig {
  // 确保必要的属性存在和初始化
  if (!adminConfig.SiteConfig) {
    adminConfig.SiteConfig = {
      SiteName: 'MoonTVPlus',
      Announcement: '',
      SearchDownstreamMaxPage: 5,
      SiteInterfaceCacheTime: 7200,
      DoubanProxyType: 'cmliussss-cdn-tencent',
      DoubanProxy: '',
      DoubanImageProxyType: 'cmliussss-cdn-tencent',
      DoubanImageProxy: '',
      DisableYellowFilter: false,
      FluidSearch: true,
      DanmakuSourceType: 'builtin',
      DanmakuApiBase: BUILTIN_DANMAKU_API_BASE,
      DanmakuApiToken: BUILTIN_DANMAKU_API_TOKEN,
      DanmakuAutoLoadDefault: false,
      PansouApiUrl: '',
      PansouUsername: '',
      PansouPassword: '',
      PansouKeywordBlocklist: '',
      MagnetProxy: '',
      MagnetMikanReverseProxy: '',
      MagnetDmhyReverseProxy: '',
      MagnetAcgripReverseProxy: '',
      MagnetNyaaReverseProxy: '',
      EnableComments: false,
      EnableRegistration: false,
      RequireRegistrationInviteCode: false,
      RegistrationInviteCode: '',
      RequireRedemptionCode: true,
      RegistrationAccessMode: 'redemption',
      MembershipRenewalMessage: '如需续费请联系站长',
      SingleDeviceLoginEnabled: true,
      RegistrationRequireTurnstile: false,
      LoginRequireTurnstile: false,
      TurnstileSiteKey: '',
      TurnstileSecretKey: '',
      DefaultUserTags: [],
    };
  }
  adminConfig.SiteConfig.TMDBApiKey = '';
  adminConfig.SiteConfig.TMDBProxy = '';
  adminConfig.SiteConfig.TMDBReverseProxy = '';
  adminConfig.SiteConfig.BannerDataSource = 'Douban';
  adminConfig.SiteConfig.RecommendationDataSource = 'Douban';
  adminConfig.SiteConfig.EnableMovieRequest = false;
  // 确保弹幕配置存在
  if (adminConfig.SiteConfig.DanmakuSourceType === undefined) {
    adminConfig.SiteConfig.DanmakuSourceType = 'custom';
  }
  if (!adminConfig.SiteConfig.DanmakuApiBase) {
    adminConfig.SiteConfig.DanmakuApiBase =
      adminConfig.SiteConfig.DanmakuSourceType === 'builtin'
        ? BUILTIN_DANMAKU_API_BASE
        : 'http://localhost:9321';
  }
  if (!adminConfig.SiteConfig.DanmakuApiToken) {
    adminConfig.SiteConfig.DanmakuApiToken = BUILTIN_DANMAKU_API_TOKEN;
  }
  if (adminConfig.SiteConfig.DanmakuAutoLoadDefault === undefined) {
    adminConfig.SiteConfig.DanmakuAutoLoadDefault = false;
  }
  // 确保评论开关存在
  if (adminConfig.SiteConfig.EnableComments === undefined) {
    adminConfig.SiteConfig.EnableComments = false;
  }
  // 确保公告显示模式存在
  if (adminConfig.SiteConfig.AnnouncementDisplayMode === undefined) {
    adminConfig.SiteConfig.AnnouncementDisplayMode =
      process.env.ANNOUNCEMENT_DISPLAY_MODE === 'every' ? 'every' : 'once';
  }
  if (adminConfig.SiteConfig.EnableRegistration === undefined) {
    adminConfig.SiteConfig.EnableRegistration = false;
  }
  if (adminConfig.SiteConfig.RequireRegistrationInviteCode === undefined) {
    adminConfig.SiteConfig.RequireRegistrationInviteCode = false;
  }
  if (adminConfig.SiteConfig.RegistrationInviteCode === undefined) {
    adminConfig.SiteConfig.RegistrationInviteCode = '';
  }
  if (adminConfig.SiteConfig.RegistrationAccessMode === undefined) {
    adminConfig.SiteConfig.RegistrationAccessMode = 'redemption';
  }
  adminConfig.SiteConfig.RequireRedemptionCode =
    adminConfig.SiteConfig.RegistrationAccessMode === 'redemption';
  if (adminConfig.SiteConfig.MembershipRenewalMessage === undefined) {
    adminConfig.SiteConfig.MembershipRenewalMessage = '如需续费请联系站长';
  }
  if (adminConfig.SiteConfig.SingleDeviceLoginEnabled === undefined) {
    adminConfig.SiteConfig.SingleDeviceLoginEnabled = true;
  }
  if (adminConfig.SiteConfig.RegistrationRequireTurnstile === undefined) {
    adminConfig.SiteConfig.RegistrationRequireTurnstile = false;
  }
  if (adminConfig.SiteConfig.LoginRequireTurnstile === undefined) {
    adminConfig.SiteConfig.LoginRequireTurnstile = false;
  }
  if (adminConfig.SiteConfig.TurnstileSiteKey === undefined) {
    adminConfig.SiteConfig.TurnstileSiteKey = '';
  }
  if (adminConfig.SiteConfig.TurnstileSecretKey === undefined) {
    adminConfig.SiteConfig.TurnstileSecretKey = '';
  }
  if (adminConfig.SiteConfig.DefaultUserTags === undefined) {
    adminConfig.SiteConfig.DefaultUserTags = [];
  }
  // 流量统计配置补全
  if (adminConfig.SiteConfig.AnalyticsEnabled === undefined) {
    adminConfig.SiteConfig.AnalyticsEnabled = false;
  }
  if (adminConfig.SiteConfig.AnalyticsProvider === undefined) {
    adminConfig.SiteConfig.AnalyticsProvider = 'umami';
  }
  if (adminConfig.SiteConfig.AnalyticsScriptUrl === undefined) {
    adminConfig.SiteConfig.AnalyticsScriptUrl = '';
  }
  if (adminConfig.SiteConfig.AnalyticsWebsiteId === undefined) {
    adminConfig.SiteConfig.AnalyticsWebsiteId = '';
  }
  if (adminConfig.SiteConfig.AnalyticsCustomScript === undefined) {
    adminConfig.SiteConfig.AnalyticsCustomScript = '';
  }
  if (!adminConfig.TelegramConfig) {
    adminConfig.TelegramConfig = {
      enabled:
        process.env.TELEGRAM_BOT_ENABLED === 'true' ||
        Boolean(process.env.TELEGRAM_BOT_TOKEN),
      botToken: process.env.TELEGRAM_BOT_TOKEN || '',
      botUsername: process.env.TELEGRAM_BOT_USERNAME || '',
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET || '',
      apiProxy: process.env.TELEGRAM_API_PROXY || '',
      apiBaseUrl: process.env.TELEGRAM_API_BASE_URL || '',
      loginEnabled: process.env.TELEGRAM_LOGIN_ENABLED !== 'false',
      bindingEnabled: process.env.TELEGRAM_BINDING_ENABLED !== 'false',
      registrationEnabled: process.env.TELEGRAM_REGISTRATION_ENABLED === 'true',
      notificationsEnabled:
        process.env.TELEGRAM_NOTIFICATIONS_ENABLED !== 'false',
      defaultNotifications:
        process.env.TELEGRAM_DEFAULT_NOTIFICATIONS !== 'false',
    };
  }
  if (adminConfig.TelegramConfig.registrationEnabled === undefined) {
    adminConfig.TelegramConfig.registrationEnabled =
      process.env.TELEGRAM_REGISTRATION_ENABLED === 'true';
  }
  if (adminConfig.SiteConfig.PansouKeywordBlocklist === undefined) {
    adminConfig.SiteConfig.PansouKeywordBlocklist = '';
  }
  if (adminConfig.SiteConfig.MagnetProxy === undefined) {
    adminConfig.SiteConfig.MagnetProxy = '';
  }
  if (adminConfig.SiteConfig.MagnetMikanReverseProxy === undefined) {
    adminConfig.SiteConfig.MagnetMikanReverseProxy = '';
  }
  if (adminConfig.SiteConfig.MagnetDmhyReverseProxy === undefined) {
    adminConfig.SiteConfig.MagnetDmhyReverseProxy = '';
  }
  if (adminConfig.SiteConfig.MagnetAcgripReverseProxy === undefined) {
    adminConfig.SiteConfig.MagnetAcgripReverseProxy = '';
  }
  if (adminConfig.SiteConfig.MagnetNyaaReverseProxy === undefined) {
    adminConfig.SiteConfig.MagnetNyaaReverseProxy = '';
  }
  if (!adminConfig.UserConfig) {
    adminConfig.UserConfig = { Users: [] };
  }
  if (
    !adminConfig.UserConfig.Users ||
    !Array.isArray(adminConfig.UserConfig.Users)
  ) {
    adminConfig.UserConfig.Users = [];
  }
  if (!adminConfig.UserConfig.AccessPolicies) {
    adminConfig.UserConfig.AccessPolicies = {};
  }
  if (!Array.isArray(adminConfig.UserConfig.RedemptionCodes)) {
    adminConfig.UserConfig.RedemptionCodes = [];
  }
  if (!adminConfig.SourceConfig || !Array.isArray(adminConfig.SourceConfig)) {
    adminConfig.SourceConfig = [];
  }
  if (
    !adminConfig.CustomCategories ||
    !Array.isArray(adminConfig.CustomCategories)
  ) {
    adminConfig.CustomCategories = [];
  }
  if (!adminConfig.LiveConfig || !Array.isArray(adminConfig.LiveConfig)) {
    adminConfig.LiveConfig = [];
  }
  if (
    !adminConfig.SpecialSourceApis ||
    !Array.isArray(adminConfig.SpecialSourceApis)
  ) {
    adminConfig.SpecialSourceApis = [];
  }
  if (
    !adminConfig.ClientAdSourceApis ||
    !Array.isArray(adminConfig.ClientAdSourceApis)
  ) {
    adminConfig.ClientAdSourceApis = [];
  }
  adminConfig.LiveRefreshIntervalHours = normalizeLiveRefreshIntervalHours(
    adminConfig.LiveRefreshIntervalHours
  );

  if (adminConfig.OpenListConfig) {
    if (!adminConfig.OpenListConfig.RootPaths) {
      adminConfig.OpenListConfig.RootPaths = adminConfig.OpenListConfig.RootPath
        ? [adminConfig.OpenListConfig.RootPath]
        : ['/'];
    }
    if (!adminConfig.OpenListConfig.OfflineDownloadPath) {
      adminConfig.OpenListConfig.OfflineDownloadPath = '/';
    }
    if (
      adminConfig.OpenListConfig.OfflineDownloadUseCustomSource === undefined
    ) {
      adminConfig.OpenListConfig.OfflineDownloadUseCustomSource = false;
    }
    if (adminConfig.OpenListConfig.OfflineDownloadURL === undefined) {
      adminConfig.OpenListConfig.OfflineDownloadURL = '';
    }
    if (adminConfig.OpenListConfig.OfflineDownloadUsername === undefined) {
      adminConfig.OpenListConfig.OfflineDownloadUsername = '';
    }
    if (adminConfig.OpenListConfig.OfflineDownloadPassword === undefined) {
      adminConfig.OpenListConfig.OfflineDownloadPassword = '';
    }
    if (adminConfig.OpenListConfig.PathMeta === undefined) {
      adminConfig.OpenListConfig.PathMeta = {};
    }
  }

  // 用户信息已迁移到新版数据库
  // 这里只保留站长用户用于兼容性，其他用户从数据库读取
  const ownerUser = process.env.USERNAME;
  adminConfig.UserConfig.Users = [
    {
      username: ownerUser!,
      role: 'owner',
      banned: false,
    },
  ];

  // 采集源去重
  const seenSourceKeys = new Set<string>();
  adminConfig.SourceConfig = adminConfig.SourceConfig.filter((source) => {
    if (seenSourceKeys.has(source.key)) {
      return false;
    }
    seenSourceKeys.add(source.key);
    return true;
  });

  const validSourceKeys = new Set(
    adminConfig.SourceConfig.map((source) => source.key)
  );
  adminConfig.SpecialSourceApis = Array.from(
    new Set(
      (adminConfig.SpecialSourceApis || []).filter((key) =>
        validSourceKeys.has(key)
      )
    )
  );
  adminConfig.ClientAdSourceApis = Array.from(
    new Set(
      (adminConfig.ClientAdSourceApis || []).filter((key) =>
        validSourceKeys.has(key)
      )
    )
  );

  // 自定义分类去重
  const seenCustomCategoryKeys = new Set<string>();
  adminConfig.CustomCategories = adminConfig.CustomCategories.filter(
    (category) => {
      if (seenCustomCategoryKeys.has(category.query + category.type)) {
        return false;
      }
      seenCustomCategoryKeys.add(category.query + category.type);
      return true;
    }
  );

  // 直播源去重
  const seenLiveKeys = new Set<string>();
  adminConfig.LiveConfig = adminConfig.LiveConfig.filter((live) => {
    if (seenLiveKeys.has(live.key)) {
      return false;
    }
    seenLiveKeys.add(live.key);
    return true;
  });

  // Emby配置迁移：将旧格式迁移到新格式
  if (adminConfig.EmbyConfig) {
    // 如果是旧格式（有ServerURL但没有Sources）
    if (adminConfig.EmbyConfig.ServerURL && !adminConfig.EmbyConfig.Sources) {
      console.log('[Config] 检测到旧格式Emby配置，自动迁移到新格式');
      const oldConfig = adminConfig.EmbyConfig;
      adminConfig.EmbyConfig = {
        Sources: [
          {
            key: 'default',
            name: 'Emby',
            enabled: oldConfig.Enabled ?? false,
            ServerURL: oldConfig.ServerURL || '',
            ApiKey: oldConfig.ApiKey,
            Username: oldConfig.Username,
            Password: oldConfig.Password,
            UserId: oldConfig.UserId,
            AuthToken: oldConfig.AuthToken,
            Libraries: oldConfig.Libraries,
            embyAuthorizationHeader: oldConfig.embyAuthorizationHeader,
            LastSyncTime: oldConfig.LastSyncTime,
            ItemCount: oldConfig.ItemCount,
            isDefault: true,
          },
        ],
      };
    }

    // Emby源去重
    if (adminConfig.EmbyConfig?.Sources) {
      const seenEmbyKeys = new Set<string>();
      adminConfig.EmbyConfig.Sources = adminConfig.EmbyConfig.Sources.filter(
        (source) => {
          if (seenEmbyKeys.has(source.key)) {
            return false;
          }
          seenEmbyKeys.add(source.key);
          return true;
        }
      );
    }
  }

  if (!adminConfig.SuwayomiConfig) {
    adminConfig.SuwayomiConfig = {
      Enabled: process.env.SUWAYOMI_ENABLED === 'true',
      ServerURL:
        process.env.SUWAYOMI_URL || process.env.NEXT_PUBLIC_SUWAYOMI_URL || '',
      AuthMode:
        (process.env.SUWAYOMI_AUTH_MODE as
          | 'none'
          | 'basic_auth'
          | 'simple_login'
          | undefined) || 'none',
      Username: process.env.SUWAYOMI_USERNAME || '',
      Password: process.env.SUWAYOMI_PASSWORD || '',
      DefaultLang: process.env.SUWAYOMI_DEFAULT_LANG || 'zh',
      SourceIds: [],
      MaxSources: Number(process.env.SUWAYOMI_MAX_SOURCES || 10),
    };
  }
  if (adminConfig.SuwayomiConfig.Enabled === undefined) {
    adminConfig.SuwayomiConfig.Enabled = false;
  }
  if (adminConfig.SuwayomiConfig.ServerURL === undefined) {
    adminConfig.SuwayomiConfig.ServerURL = '';
  }
  if (
    adminConfig.SuwayomiConfig.AuthMode !== 'basic_auth' &&
    adminConfig.SuwayomiConfig.AuthMode !== 'simple_login'
  ) {
    adminConfig.SuwayomiConfig.AuthMode = 'none';
  }
  if (adminConfig.SuwayomiConfig.Username === undefined) {
    adminConfig.SuwayomiConfig.Username = '';
  }
  if (adminConfig.SuwayomiConfig.Password === undefined) {
    adminConfig.SuwayomiConfig.Password = '';
  }
  if (adminConfig.SuwayomiConfig.DefaultLang === undefined) {
    adminConfig.SuwayomiConfig.DefaultLang = 'zh';
  }
  if (!Array.isArray(adminConfig.SuwayomiConfig.SourceIds)) {
    adminConfig.SuwayomiConfig.SourceIds = [];
  }
  if (
    adminConfig.SuwayomiConfig.MaxSources === undefined ||
    Number.isNaN(adminConfig.SuwayomiConfig.MaxSources)
  ) {
    adminConfig.SuwayomiConfig.MaxSources = 10;
  }

  if (!adminConfig.OPDSConfig) {
    adminConfig.OPDSConfig = {
      Enabled: process.env.OPDS_ENABLED === 'true',
      Sources: (() => {
        const json = process.env.OPDS_SOURCES_JSON;
        if (json) {
          try {
            const parsed = JSON.parse(json);
            if (Array.isArray(parsed)) return parsed;
          } catch {
            // ignore invalid env json
          }
        }

        const envUrl = process.env.OPDS_URL || process.env.NEXT_PUBLIC_OPDS_URL;
        if (!envUrl) return [];

        return [
          {
            id: 'default',
            name: process.env.OPDS_NAME || '默认书源',
            type: 'opds',
            url: envUrl,
            enabled: true,
            authMode:
              (process.env.OPDS_AUTH_MODE as
                | 'none'
                | 'basic'
                | 'header'
                | undefined) || 'none',
            username: process.env.OPDS_USERNAME || '',
            password: process.env.OPDS_PASSWORD || '',
            headerName: process.env.OPDS_HEADER_NAME || '',
            headerValue: process.env.OPDS_HEADER_VALUE || '',
            searchTemplate: process.env.OPDS_SEARCH_TEMPLATE || '',
          },
        ];
      })(),
      CacheTTL: Number(process.env.OPDS_CACHE_TTL_MS || 10 * 60 * 1000),
    };
  }
  if (adminConfig.OPDSConfig.Enabled === undefined) {
    adminConfig.OPDSConfig.Enabled = false;
  }
  if (!Array.isArray(adminConfig.OPDSConfig.Sources)) {
    adminConfig.OPDSConfig.Sources = [];
  }
  adminConfig.OPDSConfig.Sources = adminConfig.OPDSConfig.Sources.filter(
    (source: any) => (source?.type || 'opds') === 'opds'
  ).map((source: any) => {
    const { legado: _legado, ...rest } = source || {};
    return { ...rest, type: 'opds' };
  });
  if (!Array.isArray(adminConfig.OPDSConfig.LegadoSubscriptions)) {
    adminConfig.OPDSConfig.LegadoSubscriptions = [];
  }
  if (
    adminConfig.OPDSConfig.CacheTTL === undefined ||
    Number.isNaN(adminConfig.OPDSConfig.CacheTTL)
  ) {
    adminConfig.OPDSConfig.CacheTTL = Number(
      process.env.OPDS_CACHE_TTL_MS || 10 * 60 * 1000
    );
  }

  if (!adminConfig.NetDiskConfig) {
    adminConfig.NetDiskConfig = {
      Quark: {
        Enabled: false,
        Cookie: '',
        SavePath: '/',
        PlayMode: 'transcode_first',
        MultiThreadPlayback: false,
      },
      Mobile: {
        Enabled: false,
        Authorization: '',
      },
      Baidu: {
        Enabled: false,
        Cookie: '',
      },
      Tianyi: {
        Enabled: false,
        Account: '',
        Password: '',
      },
      Pan123: {
        Enabled: false,
        Account: '',
        Password: '',
      },
      UC: {
        Enabled: false,
        Cookie: '',
        Token: '',
        SavePath: '/',
      },
      Pan115: {
        Enabled: false,
        Cookie: '',
      },
    };
  }

  if (!adminConfig.NetDiskConfig.Quark) {
    adminConfig.NetDiskConfig.Quark = {
      Enabled: false,
      Cookie: '',
      SavePath: '/',
      PlayMode: 'transcode_first',
      MultiThreadPlayback: false,
    };
  }
  if (!adminConfig.NetDiskConfig.Quark.PlayMode) {
    adminConfig.NetDiskConfig.Quark.PlayMode = 'transcode_first';
  }
  if (adminConfig.NetDiskConfig.Quark.MultiThreadPlayback === undefined) {
    adminConfig.NetDiskConfig.Quark.MultiThreadPlayback = false;
  }

  if (!adminConfig.NetDiskConfig.Mobile) {
    adminConfig.NetDiskConfig.Mobile = {
      Enabled: false,
      Authorization: '',
    };
  }

  if (!adminConfig.NetDiskConfig.Baidu) {
    adminConfig.NetDiskConfig.Baidu = {
      Enabled: false,
      Cookie: '',
    };
  }

  if (!adminConfig.NetDiskConfig.Tianyi) {
    adminConfig.NetDiskConfig.Tianyi = {
      Enabled: false,
      Account: '',
      Password: '',
    };
  }

  if (!adminConfig.NetDiskConfig.Pan123) {
    adminConfig.NetDiskConfig.Pan123 = {
      Enabled: false,
      Account: '',
      Password: '',
    };
  }

  if (!adminConfig.NetDiskConfig.UC) {
    adminConfig.NetDiskConfig.UC = {
      Enabled: false,
      Cookie: '',
      Token: '',
      SavePath: '/',
    };
  }

  if (!adminConfig.NetDiskConfig.Pan115) {
    adminConfig.NetDiskConfig.Pan115 = {
      Enabled: false,
      Cookie: '',
    };
  }

  // 确保音乐配置存在
  if (!adminConfig.MusicConfig) {
    adminConfig.MusicConfig = {
      Enabled: false,
      BaseUrl: '',
      Token: '',
      ProxyEnabled: true,
    };
  } else if (adminConfig.MusicConfig.ProxyEnabled === undefined) {
    adminConfig.MusicConfig.ProxyEnabled = true;
  }

  if (!adminConfig.OPDSConfig) {
    adminConfig.OPDSConfig = {
      Enabled: false,
      Sources: [],
      CacheTTL: 10 * 60 * 1000,
    };
  } else {
    if (adminConfig.OPDSConfig.CacheTTL === undefined) {
      adminConfig.OPDSConfig.CacheTTL = 10 * 60 * 1000;
    }
  }

  // 合并写死的内置资源站与直播源（删除后自动恢复，禁用状态保留）
  mergeBuiltinSources(adminConfig);

  return adminConfig;
}

export async function resetConfig() {
  const originConfig = await getFreshConfig();
  const adminConfig = await getInitConfig(
    originConfig.ConfigFile,
    originConfig.ConfigSubscribtion
  );
  Object.assign(adminConfig, {
    _storageRevision: (originConfig as any)._storageRevision,
  });
  await db.saveAdminConfig(adminConfig);
  await setCachedConfig(adminConfig);

  return;
}

export async function getCacheTime(): Promise<number> {
  const config = await getConfig();
  return config.SiteConfig.SiteInterfaceCacheTime || 7200;
}

export async function getAvailableApiSites(
  user?: string,
  includeSpecialSources = false
): Promise<ApiSite[]> {
  const config = await getConfig();
  const specialSourceSet = new Set(config.SpecialSourceApis || []);
  const filterSpecialSources = <T extends { key: string }>(sites: T[]): T[] =>
    includeSpecialSources
      ? sites
      : sites.filter((site) => !specialSourceSet.has(site.key));
  const allApiSites = filterSpecialSources(
    config.SourceConfig.filter((s) => !s.disabled)
  );

  if (!user) {
    return allApiSites;
  }

  // localStorage 模式下直接返回所有可用源
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE || 'localstorage';
  if (storageType === 'localstorage') {
    return allApiSites;
  }

  // 从V2存储中获取用户信息
  const userInfoV2 = await db.getUserInfoV2(user);
  if (!userInfoV2) {
    return allApiSites;
  }

  // 优先根据用户自己的 enabledApis 配置查找
  if (userInfoV2.enabledApis && userInfoV2.enabledApis.length > 0) {
    const userApiSitesSet = new Set(userInfoV2.enabledApis);
    return allApiSites
      .filter((s) => userApiSitesSet.has(s.key))
      .map((s) => ({
        key: s.key,
        name: s.name,
        api: s.api,
        detail: s.detail,
        proxyMode: s.proxyMode,
      }));
  }

  // 如果没有 enabledApis 配置，则根据 tags 查找
  if (userInfoV2.tags && userInfoV2.tags.length > 0 && config.UserConfig.Tags) {
    const enabledApisFromTags = new Set<string>();

    // 遍历用户的所有 tags，收集对应的 enabledApis
    userInfoV2.tags.forEach((tagName) => {
      const tagConfig = config.UserConfig.Tags?.find((t) => t.name === tagName);
      if (tagConfig && tagConfig.enabledApis) {
        tagConfig.enabledApis.forEach((apiKey) =>
          enabledApisFromTags.add(apiKey)
        );
      }
    });

    if (enabledApisFromTags.size > 0) {
      return allApiSites
        .filter((s) => enabledApisFromTags.has(s.key))
        .map((s) => ({
          key: s.key,
          name: s.name,
          api: s.api,
          detail: s.detail,
          proxyMode: s.proxyMode,
        }));
    }
  }

  // 如果都没有配置，返回所有可用的 API 站点
  return allApiSites;
}

export async function setCachedConfig(config: AdminConfig) {
  cachedConfig = config;
  cachedConfigAt = Date.now();
}

export async function clearConfigCache() {
  cachedConfig = null as any;
  configInitPromise = null;
}
