const CHINESE_SEASONS: Record<string, number> = {
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
  十: 10,
};

export function cleanTeslaDanmakuTitle(value: string) {
  return value
    .replace(/\s*-\s*\d{4}\s*-\s*第\s*\d+\s*集.*$/u, '')
    .replace(/\s*-\s*第\s*\d+\s*集.*$/u, '')
    .replace(/\s*第\s*\d+\s*集.*$/u, '')
    .replace(/(?:\[|\]|【|】)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function normalizeComparableTitle(value: string) {
  return cleanTeslaDanmakuTitle(
    value.replace(/\u3010[^\u3011]*\u3011|\[[^\]]*\]/g, '')
  )
    .replace(/[(\uff08]\d{4}[)\uff09]/g, '')
    .replace(
      /第\s*([一二两三四五六七八九十])\s*季/gu,
      (_match, season) => `s${CHINESE_SEASONS[season] || season}`
    )
    .replace(/第\s*(\d{1,2})\s*季/gu, 's$1')
    .replace(/season\s*0*(\d{1,2})/gi, 's$1')
    .replace(/\bfrom\s+\S+$/i, '')
    .replace(/[^a-z0-9\u4e00-\u9fff]/gi, '')
    .toLowerCase();
}

export type TeslaDanmakuCandidate = {
  animeId: number;
  animeTitle: string;
  startDate?: string;
  type?: string;
  typeDescription?: string;
  episodeCount?: number;
};

function readCandidateYear(candidate: TeslaDanmakuCandidate) {
  return `${candidate.startDate || ''} ${candidate.animeTitle || ''}`.match(
    /(?:19|20)\d{2}/
  )?.[0];
}

function looksLikeMovie(value: string) {
  return /\u7535\u5f71|\u5267\u573a|movie|film/i.test(value);
}

const MISLEADING_SUFFIX =
  /\u89e3\u8bf4|\u89e3\u5bc6|\u63ed\u79d8|\u901f\u770b|\u526a\u8f91|\u76d8\u70b9|\u9884\u544a|\u5408\u96c6/u;

export function scoreTeslaDanmakuCandidate(
  candidate: TeslaDanmakuCandidate,
  context: {
    title: string;
    year?: string;
    mediaType?: 'movie' | 'tv';
    totalEpisodes?: number;
  }
) {
  const wanted = normalizeComparableTitle(context.title);
  const offered = normalizeComparableTitle(candidate.animeTitle);
  if (!wanted || !offered) return -Infinity;

  let score = 0;
  if (wanted === offered) score += 100;
  else if (wanted.includes(offered) || offered.includes(wanted)) score += 55;
  else return -Infinity;

  const candidateYear = readCandidateYear(candidate);
  if (/^\d{4}$/.test(context.year || '') && candidateYear) {
    score += candidateYear === context.year ? 70 : -80;
  }

  const description = `${candidate.type || ''} ${
    candidate.typeDescription || ''
  }`;
  if (context.mediaType) {
    score +=
      looksLikeMovie(description) === (context.mediaType === 'movie')
        ? 15
        : -15;
  }

  const expectedCount = Number(context.totalEpisodes);
  const candidateCount = Number(candidate.episodeCount);
  if (expectedCount > 0 && candidateCount > 0) {
    const difference = Math.abs(expectedCount - candidateCount);
    if (difference === 0) score += 25;
    else if (difference <= 2) score += 15;
    else if (difference / expectedCount <= 0.1) score += 8;
    else score -= Math.min(25, difference);
  }

  if (
    MISLEADING_SUFFIX.test(candidate.animeTitle) &&
    !MISLEADING_SUFFIX.test(context.title)
  ) {
    score -= 45;
  }
  return score;
}

export function selectTeslaDanmakuCandidate<T extends TeslaDanmakuCandidate>(
  candidates: T[],
  context: {
    title: string;
    year?: string;
    mediaType?: 'movie' | 'tv';
    totalEpisodes?: number;
  }
): T | null {
  const ranked = candidates
    .map((candidate) => ({
      candidate,
      score: scoreTeslaDanmakuCandidate(candidate, context),
    }))
    .filter((item) => Number.isFinite(item.score))
    .sort((left, right) => right.score - left.score);
  const best = ranked[0];
  if (!best || best.score < 70) return null;
  if (ranked[1] && best.score - ranked[1].score < 15) return null;
  return best.candidate;
}

export function rankTeslaDanmakuCandidates<T extends TeslaDanmakuCandidate>(
  candidates: T[],
  context: {
    title: string;
    year?: string;
    mediaType?: 'movie' | 'tv';
    totalEpisodes?: number;
  }
): T[] {
  return candidates
    .map((candidate) => ({
      candidate,
      score: scoreTeslaDanmakuCandidate(candidate, context),
    }))
    .filter((item) => Number.isFinite(item.score) && item.score >= 45)
    .sort((left, right) => right.score - left.score)
    .map((item) => item.candidate);
}

export function buildTeslaDanmakuSearchKeywords(title: string) {
  const clean = cleanTeslaDanmakuTitle(title);
  const withoutSeason = clean
    .replace(/\s*第\s*[0-9一二两三四五六七八九十]+\s*季.*$/u, '')
    .replace(/(?:^|\s)S(?:eason)?\s*0*\d{1,2}(?:\s|$)/i, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return Array.from(new Set([clean, withoutSeason].filter(Boolean)));
}

export function parseTeslaDanmakuEpisodeNumber(value: string) {
  const patterns = [
    /S\d{1,2}E0*(\d{1,4})/i,
    /(?:EP?|Episode)\s*0*(\d{1,4})/i,
    /\u7b2c\s*0*(\d{1,4})\s*(?:\u96c6|\u8bdd|\u671f)/u,
    /(?:^|[_\s-])0*(\d{1,4})(?:$|[_\s-])/,
  ];
  for (const pattern of patterns) {
    const match = value.match(pattern);
    if (match) return Math.max(1, Number(match[1]));
  }
  return null;
}

type TeslaDanmakuEpisodeIdentity = {
  number: number | null;
  /**
   * "第 1 期上"、"第 1 期下"、"加更" 不能只按数字视为同一集。
   * 这里保留可比较的版本身份；未知时宁可要求手动选择，也不串弹幕。
   */
  variant: string | null;
};

function readTeslaDanmakuEpisodeVariant(
  value: string
): TeslaDanmakuEpisodeIdentity['variant'] {
  const normalized = value
    .replace(/\s+/g, '')
    .replace(/[（(][^)）]*[)）]/g, '');
  if (/(?:上半|上集|上篇|上)/u.test(normalized)) return 'upper';
  if (/(?:下半|下集|下篇|下)/u.test(normalized)) return 'lower';
  if (/(?:中集|中篇|中)/u.test(normalized)) return 'middle';
  if (/(?:加更|加长|会员加更|plus)/iu.test(normalized)) return 'bonus';
  if (/(?:先导|抢先|预告)/u.test(normalized)) return 'preview';
  if (/(?:花絮|番外|特别篇|特别节目|彩蛋)/u.test(normalized)) return 'special';
  if (/(?:精编|纯享)/u.test(normalized)) return 'cut';
  return null;
}

function getTeslaDanmakuEpisodeIdentity(
  value: string
): TeslaDanmakuEpisodeIdentity {
  return {
    number: parseTeslaDanmakuEpisodeNumber(value),
    variant: readTeslaDanmakuEpisodeVariant(value),
  };
}

export function selectTeslaDanmakuEpisode<T extends { episodeTitle: string }>(
  episodes: T[],
  wantedEpisode: number,
  episodeLabel?: string
): T | null {
  const labelNumber = episodeLabel
    ? parseTeslaDanmakuEpisodeNumber(episodeLabel)
    : null;
  const wanted = Math.max(1, Math.floor(labelNumber || wantedEpisode || 1));
  const numbered = episodes.map((episode) => ({
    episode,
    identity: getTeslaDanmakuEpisodeIdentity(episode.episodeTitle),
  }));

  if (episodeLabel) {
    const normalizedLabel = normalizeComparableTitle(episodeLabel);
    const labelMatch = normalizedLabel
      ? episodes.find(
          (episode) =>
            normalizeComparableTitle(episode.episodeTitle) === normalizedLabel
        )
      : undefined;
    if (labelMatch) return labelMatch;
  }

  const candidates = numbered.filter(
    (item) => item.identity.number === wanted
  );
  const requestedVariant = episodeLabel
    ? readTeslaDanmakuEpisodeVariant(episodeLabel)
    : null;

  if (requestedVariant) {
    const matchingVariant = candidates.filter(
      (item) => item.identity.variant === requestedVariant
    );
    // More than one item with the same semantic identity still needs an exact
    // manual choice.  Choosing the first one recreates the old串片problem.
    if (matchingVariant.length === 1) return matchingVariant[0].episode;
    return null;
  }

  // A plain "第 1 期" must not silently resolve to "第 1 期上/下/加更".
  // The single, unqualified item is safe; several variants are not.
  const plainCandidates = candidates.filter((item) => !item.identity.variant);
  if (plainCandidates.length === 1) return plainCandidates[0].episode;
  if (candidates.length === 1) return candidates[0].episode;
  if (candidates.length > 1) return null;

  const knownNumbers = numbered
    .map((item) => item.identity.number)
    .filter((value): value is number => value !== null);
  if (episodes.length === 1 && wanted === 1) return episodes[0];
  const isMonotonic =
    knownNumbers.length === episodes.length &&
    knownNumbers.every(
      (value, index) => index === 0 || value > knownNumbers[index - 1]
    );
  if (isMonotonic && episodes[wanted - 1]) return episodes[wanted - 1];
  return null;
}

export function inferTeslaDanmakuSeason(value: string) {
  const latin = value.match(/(?:^|\s)S(?:eason)?\s*0*(\d{1,2})(?:\s|$)/i);
  if (latin) return Math.max(1, Number(latin[1]));
  const arabic = value.match(/第\s*(\d{1,2})\s*季/u);
  if (arabic) return Math.max(1, Number(arabic[1]));
  const chinese = value.match(/第\s*([一二两三四五六七八九十])\s*季/u);
  return chinese ? CHINESE_SEASONS[chinese[1]] || 1 : 1;
}

export function buildTeslaDanmakuFileName({
  title,
  year,
  episode,
}: {
  title: string;
  year?: string;
  episode: number;
}) {
  const cleanTitle = cleanTeslaDanmakuTitle(title);
  const season = inferTeslaDanmakuSeason(cleanTitle);
  const safeEpisode = Math.max(1, Math.floor(episode || 1));
  const safeYear = /^\d{4}$/.test(year || '') ? ` (${year})` : '';
  return `${cleanTitle}${safeYear} S${String(season).padStart(2, '0')}E${String(
    safeEpisode
  ).padStart(2, '0')}`;
}
