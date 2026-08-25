/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';

import { applyConfiguredAdFilterSafely } from './ad-filter-custom';

interface ConfiguredAdFilterResponse {
  code?: string;
  version?: number;
}

let configuredAdFilterPromise: Promise<string> | null = null;
const AD_FILTER_SOFT_WAIT_MS = 800;
const AD_FILTER_FETCH_TIMEOUT_MS = 3000;

function readRuntimeFilterVersion(): number {
  if (typeof window === 'undefined') return 0;
  const rawVersion = (window as any).RUNTIME_CONFIG?.CUSTOM_AD_FILTER_VERSION;
  const version = Number(rawVersion || 0);
  return Number.isFinite(version) && version > 0 ? version : 0;
}

async function loadConfiguredAdFilterCode(): Promise<string> {
  if (typeof window === 'undefined') return '';
  if (configuredAdFilterPromise) return configuredAdFilterPromise;

  configuredAdFilterPromise = (async () => {
    const version = readRuntimeFilterVersion();
    const cachedCode =
      localStorage.getItem('custom_ad_filter_code_cache') || '';
    const cachedVersion = Number(
      localStorage.getItem('custom_ad_filter_version_cache') || 0
    );

    if (version <= 0) {
      localStorage.removeItem('custom_ad_filter_code_cache');
      localStorage.removeItem('custom_ad_filter_version_cache');
      return '';
    }
    if (cachedCode && cachedVersion === version) return cachedCode;

    const controller = new AbortController();
    const timeout = window.setTimeout(
      () => controller.abort(),
      AD_FILTER_FETCH_TIMEOUT_MS
    );
    try {
      const response = await fetch('/api/ad-filter?full=true', {
        cache: 'no-store',
        credentials: 'same-origin',
        signal: controller.signal,
      });
      if (!response.ok) return cachedCode;
      const data = (await response.json()) as ConfiguredAdFilterResponse;
      const code = typeof data.code === 'string' ? data.code : '';
      const responseVersion = Number(data.version || version);
      if (code) {
        localStorage.setItem('custom_ad_filter_code_cache', code);
        localStorage.setItem(
          'custom_ad_filter_version_cache',
          String(responseVersion)
        );
      }
      return code || cachedCode;
    } catch {
      return cachedCode;
    } finally {
      clearTimeout(timeout);
    }
  })();

  return configuredAdFilterPromise;
}

/**
 * Safely remove only explicit ad media segments from a media playlist.
 *
 * Timeline, encryption and initialization tags are deliberately preserved.
 * If a segment uses an advanced HLS structure, it is kept instead of risking
 * a bad A/V timestamp mapping.
 */
export function filterAdsFromM3U8(type: string, m3u8Content: string): string {
  return applyConfiguredAdFilterSafely(type, m3u8Content);
}

/**
 * hls.js uses pLoader only for text playlists (master/level/audio/subtitle).
 * Segment bytes, keys and init sections continue through the unchanged loader.
 */
export function resolveAdFilterSourceKey(
  sourceKey: string | undefined,
  playlistContextType: string | undefined
) {
  return sourceKey?.trim() || playlistContextType || 'hls';
}

export function createAdFilteringPlaylistLoader(
  sourceKey?: string,
  assumeVod = false
) {
  const BaseLoader = (Hls as any).DefaultConfig?.loader;
  if (!BaseLoader) return undefined;

  // 建立 loader 时就并行预取配置。通常在首个媒体列表返回前已完成，
  // 不额外串行阻塞网络请求。
  const configuredCodePromise = loadConfiguredAdFilterCode();
  const cachedCode = (() => {
    if (typeof window === 'undefined') return '';
    const version = readRuntimeFilterVersion();
    const cachedVersion = Number(
      localStorage.getItem('custom_ad_filter_version_cache') || 0
    );
    if (version <= 0 || cachedVersion !== version) return '';
    return localStorage.getItem('custom_ad_filter_code_cache') || '';
  })();

  return class AdFilteringPlaylistLoader extends BaseLoader {
    load(context: any, config: any, callbacks: any) {
      const onSuccess = callbacks.onSuccess;
      const wrappedCallbacks = {
        ...callbacks,
        onSuccess: (
          response: any,
          stats: any,
          currentContext: any,
          networkDetails: any
        ) => {
          let finished = false;
          const finish = (customCode = '') => {
            if (finished) return;
            finished = true;
            if (typeof response?.data === 'string') {
              response.data = applyConfiguredAdFilterSafely(
                resolveAdFilterSourceKey(
                  sourceKey,
                  currentContext?.type || context?.type
                ),
                response.data,
                customCode,
                assumeVod
              );
            }
            onSuccess(response, stats, currentContext, networkDetails);
          };

          // 主列表不含 EXTINF，立即交给 hls.js；只有真正的媒体列表才需要
          // 等待去广告配置，避免延长清晰度列表的首次解析。
          if (
            typeof response?.data !== 'string' ||
            !response.data.includes('#EXTINF:')
          ) {
            finish();
            return;
          }

          const softTimeout = window.setTimeout(
            () => finish(cachedCode),
            AD_FILTER_SOFT_WAIT_MS
          );
          void configuredCodePromise.then(
            (code) => {
              clearTimeout(softTimeout);
              finish(code || cachedCode);
            },
            () => {
              clearTimeout(softTimeout);
              finish(cachedCode);
            }
          );
        },
      };

      return super.load(context, config, wrappedCallbacks);
    }
  };
}
