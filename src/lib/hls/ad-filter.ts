/* eslint-disable @typescript-eslint/no-explicit-any */

import Hls from 'hls.js';

const AD_KEYWORDS = [
  'sponsor',
  '/ad/',
  '/ads/',
  'advert',
  'advertisement',
  '/adjump',
  'redtraffic',
];

/**
 * Safely remove only explicit ad media segments from a media playlist.
 *
 * Timeline, encryption and initialization tags are deliberately preserved.
 * If a segment uses an advanced HLS structure, it is kept instead of risking
 * a bad A/V timestamp mapping.
 */
export function filterAdsFromM3U8(type: string, m3u8Content: string): string {
  void type;

  if (!m3u8Content || !m3u8Content.includes('#EXTM3U')) {
    return m3u8Content || '';
  }

  // Master playlists do not contain media segments and must remain untouched.
  if (!m3u8Content.includes('#EXTINF:')) {
    return m3u8Content;
  }

  const lines = m3u8Content.replace(/\r\n/g, '\n').split('\n');
  const output: string[] = [];

  const isAdUrl = (url: string) => {
    const normalized = url.toLowerCase();
    return AD_KEYWORDS.some((keyword) => normalized.includes(keyword));
  };

  const hasUnsafeSegmentStructure = (tags: string[]) =>
    tags.some((line) =>
      /^#EXT-X-(BYTERANGE|MAP|KEY|PART|PRELOAD-HINT|GAP)/i.test(line.trim()),
    );

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    if (!line.trim().startsWith('#EXTINF:')) {
      // In particular, retain EXT-X-DISCONTINUITY and
      // EXT-X-DISCONTINUITY-SEQUENCE. They are timing metadata, not ads.
      output.push(line);
      index++;
      continue;
    }

    let uriIndex = index + 1;
    while (
      uriIndex < lines.length &&
      (!lines[uriIndex].trim() || lines[uriIndex].trim().startsWith('#'))
    ) {
      uriIndex++;
    }

    // Unknown or incomplete structures remain byte-for-byte unchanged.
    if (uriIndex >= lines.length) {
      output.push(line);
      index++;
      continue;
    }

    const segmentTags = lines.slice(index + 1, uriIndex);
    const segmentUri = lines[uriIndex].trim();

    // Skip only a complete, ordinary EXTINF -> URI media segment. Keep any
    // segment requiring a key/map/byte range/partial segment to avoid a
    // desynchronized or unplayable playlist.
    if (isAdUrl(segmentUri) && !hasUnsafeSegmentStructure(segmentTags)) {
      index = uriIndex + 1;
      continue;
    }

    output.push(...lines.slice(index, uriIndex + 1));
    index = uriIndex + 1;
  }

  return output.join('\n');
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
        onSuccess: (response: any, stats: any, currentContext: any, networkDetails: any) => {
          if (typeof response?.data === 'string') {
            response.data = filterAdsFromM3U8(
              currentContext?.type || context?.type || 'hls',
              response.data,
            );
          }
          onSuccess(response, stats, currentContext, networkDetails);
        },
      };

      return super.load(context, config, wrappedCallbacks);
    }
  };
}
