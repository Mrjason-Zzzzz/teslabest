import { filterAdsFromMediaPlaylist } from './ad-filter-core';

function stripSimpleTypeScriptAnnotations(code: string): string {
  return code
    .replace(
      /(\w+)\s*:\s*(string|number|boolean|any|void|never|unknown|object)\s*([,)])/g,
      '$1$3'
    )
    .replace(
      /\)\s*:\s*(string|number|boolean|any|void|never|unknown|object)\s*\{/g,
      ') {'
    )
    .replace(
      /(const|let|var)\s+(\w+)\s*:\s*(string|number|boolean|any|void|never|unknown|object)\s*=/g,
      '$1 $2 ='
    );
}

function readMediaSegmentUris(content: string): string[] {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  const uris: string[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    if (!lines[index].trim().startsWith('#EXTINF:')) continue;
    let uriIndex = index + 1;
    while (
      uriIndex < lines.length &&
      (!lines[uriIndex].trim() || lines[uriIndex].trim().startsWith('#'))
    ) {
      uriIndex += 1;
    }
    if (uriIndex >= lines.length) return [];
    uris.push(lines[uriIndex].trim());
    index = uriIndex;
  }

  return uris;
}

function inferRemovedSegmentIndexes(
  originalContent: string,
  customFilteredContent: string
): ReadonlySet<number> | null {
  if (!customFilteredContent.trimStart().startsWith('#EXTM3U')) return null;

  const originalUris = readMediaSegmentUris(originalContent);
  const filteredUris = readMediaSegmentUris(customFilteredContent);
  if (
    originalUris.length === 0 ||
    filteredUris.length === 0 ||
    filteredUris.length >= originalUris.length
  ) {
    return null;
  }

  const removed = new Set<number>();
  let filteredIndex = 0;
  for (
    let originalIndex = 0;
    originalIndex < originalUris.length;
    originalIndex += 1
  ) {
    if (originalUris[originalIndex] === filteredUris[filteredIndex]) {
      filteredIndex += 1;
      if (filteredIndex === filteredUris.length) {
        for (
          let trailingIndex = originalIndex + 1;
          trailingIndex < originalUris.length;
          trailingIndex += 1
        ) {
          removed.add(trailingIndex);
        }
        break;
      }
    } else {
      removed.add(originalIndex);
    }
  }

  // 自定义代码若改写、新增或重排分片，结果不是原列表的子序列。
  // 这类结果不可信，直接退回内置安全规则。
  if (filteredIndex !== filteredUris.length || removed.size === 0) return null;
  return removed;
}

/**
 * 站长自定义代码只用来标记“哪些完整分片是广告”。
 * 最终播放列表仍由共用安全过滤器从原文重建，保留密钥、初始化段和
 * discontinuity 边界，禁止自定义代码直接破坏音画时间轴。
 */
export function applyConfiguredAdFilterSafely(
  type: string,
  m3u8Content: string,
  customCode = '',
  assumeVod = false
): string {
  if (!customCode.trim() || !m3u8Content.includes('#EXTINF:')) {
    return filterAdsFromMediaPlaylist(m3u8Content, { assumeVod });
  }

  try {
    const jsCode = stripSimpleTypeScriptAnnotations(customCode);
    const customFunction = new Function(
      'type',
      'm3u8Content',
      `${jsCode}\nreturn filterAdsFromM3U8(type, m3u8Content);`
    );
    const result = customFunction(type, m3u8Content);
    if (typeof result !== 'string') {
      return filterAdsFromMediaPlaylist(m3u8Content, { assumeVod });
    }

    const additionalAdSegmentIndexes = inferRemovedSegmentIndexes(
      m3u8Content,
      result
    );
    return filterAdsFromMediaPlaylist(m3u8Content, {
      additionalAdSegmentIndexes: additionalAdSegmentIndexes || undefined,
      assumeVod,
    });
  } catch {
    return filterAdsFromMediaPlaylist(m3u8Content, { assumeVod });
  }
}
