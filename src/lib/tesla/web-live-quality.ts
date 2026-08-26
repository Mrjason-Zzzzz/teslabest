export type HuyaQuality = {
  id: string;
  label: string;
  bitrate: number;
};

export function parseHuyaAvcQualities(html: string): HuyaQuality[] {
  const match = html.match(
    /"vMultiStreamInfo"\s*:\s*(\[.*?\])\s*,\s*"iWebDefaultBitRate"/s
  );
  if (!match) return [];
  try {
    const rows = JSON.parse(match[1]);
    const seen = new Set<number>();
    return (Array.isArray(rows) ? rows : [])
      .filter(
        (row) =>
          Number(row?.iCodecType) === 0 &&
          Number.isFinite(Number(row?.iBitRate)) &&
          !seen.has(Number(row.iBitRate))
      )
      .map((row) => {
        const bitrate = Number(row.iBitRate);
        seen.add(bitrate);
        return {
          id: `HUYA_${bitrate}`,
          label: String(row.sDisplayName || (bitrate ? `${bitrate}K` : '原画')),
          bitrate,
        };
      })
      .sort((left, right) => {
        const leftRank = left.bitrate === 0 ? Number.MAX_SAFE_INTEGER : left.bitrate;
        const rightRank =
          right.bitrate === 0 ? Number.MAX_SAFE_INTEGER : right.bitrate;
        return leftRank - rightRank;
      });
  } catch {
    return [];
  }
}

export type BilibiliHlsVariant = {
  currentQn: number;
  acceptQn: number[];
  urls: string[];
};

export function getBilibiliQualityLabels(playurl: any) {
  const labels = new Map<number, string>();
  for (const item of playurl?.g_qn_desc || []) {
    const qn = Number(item?.qn);
    if (Number.isFinite(qn)) labels.set(qn, String(item?.desc || qn));
  }
  return labels;
}

export function getBilibiliAvcTsVariant(
  playurl: any
): BilibiliHlsVariant | null {
  for (const stream of playurl?.stream || []) {
    if (stream?.protocol_name !== 'http_hls') continue;
    for (const format of stream?.format || []) {
      if (format?.format_name !== 'ts') continue;
      for (const codec of format?.codec || []) {
        if (codec?.codec_name !== 'avc' || !codec?.base_url) continue;
        const urls = (codec.url_info || [])
          .map(
            (item: any) =>
              `${String(item?.host || '')}${String(codec.base_url)}${String(
                item?.extra || ''
              )}`
          )
          .filter((url: string) => /^https?:\/\//i.test(url));
        if (!urls.length) continue;
        return {
          currentQn: Number(codec.current_qn) || 0,
          acceptQn: (codec.accept_qn || [])
            .map(Number)
            .filter(Number.isFinite),
          urls,
        };
      }
    }
  }
  return null;
}
