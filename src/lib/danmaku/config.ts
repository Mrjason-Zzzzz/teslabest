import type { AdminConfig } from '@/lib/admin.types';

// P002 uses the tested LogVar endpoint as the managed built-in source. The
// token is part of this service's public route contract rather than a client
// credential; browsers still access it through our same-origin API proxy.
export const BUILTIN_DANMAKU_API_BASE =
  'https://danmu.dorezst.cn/980728';
export const BUILTIN_DANMAKU_API_TOKEN = '980728';

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, '');
}

export function getDanmakuApiBaseUrl(siteConfig: AdminConfig['SiteConfig']) {
  if (siteConfig.DanmakuSourceType === 'builtin') {
    return BUILTIN_DANMAKU_API_BASE;
  }

  const base = trimTrailingSlash(
    siteConfig.DanmakuApiBase || BUILTIN_DANMAKU_API_BASE
  );
  const token = (
    siteConfig.DanmakuApiToken || BUILTIN_DANMAKU_API_TOKEN
  ).trim();

  return token === BUILTIN_DANMAKU_API_TOKEN ? base : `${base}/${token}`;
}
