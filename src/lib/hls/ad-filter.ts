/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';

import { filterAdsFromMediaPlaylist } from './ad-filter-core';

/**
 * Safely remove only explicit ad media segments from a media playlist.
 *
 * Timeline, encryption and initialization tags are deliberately preserved.
 * If a segment uses an advanced HLS structure, it is kept instead of risking
 * a bad A/V timestamp mapping.
 */
export function filterAdsFromM3U8(type: string, m3u8Content: string): string {
  void type;
  return filterAdsFromMediaPlaylist(m3u8Content);
}

/**
 * hls.js uses pLoader only for text playlists (master/level/audio/subtitle).
 * Segment bytes, keys and init sections continue through the unchanged loader.
 */
export function createAdFilteringPlaylistLoader() {
  const BaseLoader = (Hls as any).DefaultConfig?.loader;
  if (!BaseLoader) return undefined;

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
          if (typeof response?.data === 'string') {
            response.data = filterAdsFromM3U8(
              currentContext?.type || context?.type || 'hls',
              response.data
            );
          }
          onSuccess(response, stats, currentContext, networkDetails);
        },
      };

      return super.load(context, config, wrappedCallbacks);
    }
  };
}
