'use client';

import {
  type CSSProperties,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  convertDanmakuFormat,
  getDanmakuById,
  getEpisodes,
  matchAnime,
  searchAnime,
} from '@/lib/danmaku/api';
import {
  buildTeslaDanmakuFileName,
  buildTeslaDanmakuSearchKeywords,
  cleanTeslaDanmakuTitle,
  parseTeslaDanmakuEpisodeNumber,
  scoreTeslaDanmakuCandidate,
  selectTeslaDanmakuCandidate,
  selectTeslaDanmakuEpisode,
} from '@/lib/tesla/danmaku-match';

type OverlayComment = {
  id: string;
  text: string;
  color: string;
  lane: number;
  startedAt: number;
};

export type TeslaDanmakuProgrammeChoice = {
  animeId: number;
  animeTitle: string;
};

export type TeslaDanmakuEpisodeChoice = {
  episodeId: number;
  episodeTitle: string;
};

export type TeslaDanmakuChoices = {
  programmes: TeslaDanmakuProgrammeChoice[];
  episodes: TeslaDanmakuEpisodeChoice[];
  selectedAnimeId: number | null;
  selectedEpisodeId: number | null;
  automatic: boolean;
};

interface TeslaDanmakuOverlayProps {
  enabled: boolean;
  title?: string;
  year?: string;
  episodeNumber?: number;
  episodeLabel?: string;
  mediaType?: 'movie' | 'tv';
  totalEpisodes?: number;
  currentTime: number;
  mediaTime?: number;
  timelineOffsetSec?: number;
  playing: boolean;
  laneCount?: number;
  speed?: number;
  fontSize?: number;
  manualAnimeId?: number | null;
  manualEpisodeId?: number | null;
  onStatusChange?: (status: string) => void;
  onChoicesChange?: (choices: TeslaDanmakuChoices) => void;
}

function lowerBoundComment(
  comments: Array<{ time: number }>,
  targetTime: number
) {
  let low = 0;
  let high = comments.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (comments[middle].time <= targetTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

export default function TeslaDanmakuOverlay({
  enabled,
  title = '',
  year = '',
  episodeNumber = 1,
  episodeLabel = '',
  mediaType = 'tv',
  totalEpisodes = 0,
  currentTime,
  mediaTime = currentTime,
  timelineOffsetSec = 0,
  playing,
  laneCount = 7,
  speed = 3,
  fontSize = 30,
  manualAnimeId = null,
  manualEpisodeId = null,
  onStatusChange,
  onChoicesChange,
}: TeslaDanmakuOverlayProps) {
  const [comments, setComments] = useState<
    Array<{ text: string; time: number; color: string }>
  >([]);
  const [activeComments, setActiveComments] = useState<OverlayComment[]>([]);
  const [stageSize, setStageSize] = useState({ width: 1280, height: 720 });
  const stageRef = useRef<HTMLDivElement | null>(null);
  const loadIdentityRef = useRef('');
  const lastTimeRef = useRef(0);
  const sequenceRef = useRef(0);
  const commentCursorRef = useRef(0);
  const currentTimeRef = useRef(currentTime);
  const lastTimingLogAtRef = useRef(0);
  currentTimeRef.current = currentTime;

  const safeLaneCount = Math.max(3, Math.min(8, Math.floor(laneCount || 7)));
  const safeSpeed = Math.max(1, Math.min(5, Math.floor(speed || 3)));
  const safeFontSize = Math.max(18, Math.min(44, Math.floor(fontSize || 30)));
  const displayFontSize = Math.max(
    14,
    Math.round(safeFontSize * Math.min(1, stageSize.height / 540))
  );
  const animationDurationSec = 14 - (safeSpeed - 1) * 2;
  const baseTitle = cleanTeslaDanmakuTitle(title);
  const contentIdentity = `${baseTitle}|${year}|${mediaType}|${episodeNumber}|${episodeLabel}|${totalEpisodes}|${
    manualAnimeId || 0
  }|${manualEpisodeId || 0}`;

  useEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const updateSize = () => {
      const bounds = stage.getBoundingClientRect();
      if (bounds.width > 0 && bounds.height > 0) {
        setStageSize({ width: bounds.width, height: bounds.height });
      }
    };
    updateSize();
    const observer =
      typeof ResizeObserver === 'function'
        ? new ResizeObserver(updateSize)
        : null;
    observer?.observe(stage);
    window.addEventListener('resize', updateSize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', updateSize);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !title || loadIdentityRef.current === contentIdentity)
      return;

    let cancelled = false;
    const loadingIdentity = contentIdentity;
    setComments([]);
    setActiveComments([]);
    commentCursorRef.current = 0;
    loadIdentityRef.current = contentIdentity;
    onStatusChange?.('正在匹配弹幕…');

    const load = async () => {
      const context = { title: baseTitle, year, mediaType, totalEpisodes };
      const wantedEpisode =
        parseTeslaDanmakuEpisodeNumber(episodeLabel) || episodeNumber;
      const searchKeywords = buildTeslaDanmakuSearchKeywords(baseTitle);
      const fileNames = searchKeywords.map((keyword) =>
        buildTeslaDanmakuFileName({
          title: keyword,
          year,
          episode: wantedEpisode,
        })
      );
      const [matchResults, searchResults] = await Promise.all([
        Promise.all(fileNames.map((fileName) => matchAnime(fileName))),
        Promise.all(searchKeywords.map((keyword) => searchAnime(keyword))),
      ]);
      if (cancelled) return;
      const directMatches = matchResults.flatMap((matched) =>
        (matched.matches || []).filter((item) => {
          const matchedEpisode = parseTeslaDanmakuEpisodeNumber(
            item.episodeTitle || ''
          );
          return (
            scoreTeslaDanmakuCandidate(item, context) >= 45 &&
            (matchedEpisode === null || matchedEpisode === wantedEpisode)
          );
        })
      );
      const searchedCandidates = searchResults.flatMap((searchResult) =>
        searchResult.success ? searchResult.animes || [] : []
      );

      const candidatePool: Array<{
        animeId: number;
        animeTitle: string;
        episodeId?: number;
        episodeTitle?: string;
        startDate?: string;
        type?: string;
        typeDescription?: string;
        episodeCount?: number;
      }> = [];
      const seenCandidates = new Set<number>();
      // Search results carry year/type/episode-count metadata, so use them as
      // the authoritative programme identity. Direct matches remain useful for
      // the exact episode id after that identity has been verified.
      for (const anime of searchedCandidates) {
        if (seenCandidates.has(anime.animeId)) continue;
        seenCandidates.add(anime.animeId);
        candidatePool.push(anime);
      }
      for (const match of directMatches) {
        if (seenCandidates.has(match.animeId)) continue;
        seenCandidates.add(match.animeId);
        candidatePool.push(match);
      }

      const programmes = candidatePool
        .filter(
          (candidate) => scoreTeslaDanmakuCandidate(candidate, context) >= 45
        )
        .map((candidate) => ({
          animeId: candidate.animeId,
          animeTitle: candidate.animeTitle,
        }));
      const automaticSelection = selectTeslaDanmakuCandidate(
        candidatePool,
        context
      );
      const selected = manualAnimeId
        ? candidatePool.find(
            (candidate) => candidate.animeId === manualAnimeId
          ) || null
        : automaticSelection;
      onChoicesChange?.({
        programmes,
        episodes: [],
        selectedAnimeId: selected?.animeId || null,
        selectedEpisodeId: null,
        automatic: !manualAnimeId,
      });
      if (!selected) {
        onStatusChange?.(
          programmes.length
            ? '自动匹配不唯一，请手动选择弹幕节目'
            : '未找到可用弹幕节目'
        );
        return;
      }

      const episodeResult = await getEpisodes(selected.animeId);
      if (cancelled) return;
      const episodes = episodeResult.bangumi?.episodes?.length
        ? episodeResult.bangumi.episodes
        : directMatches
            .filter(
              (match) => match.animeId === selected.animeId && match.episodeId
            )
            .map((match) => ({
              episodeId: match.episodeId,
              episodeTitle: match.episodeTitle,
            }));
      const directEpisode = directMatches.find(
        (match) =>
          match.animeId === selected.animeId &&
          parseTeslaDanmakuEpisodeNumber(match.episodeTitle || '') ===
            wantedEpisode
      );
      const manualEpisode = manualEpisodeId
        ? episodes.find((episode) => episode.episodeId === manualEpisodeId)
        : null;
      const automaticEpisode =
        directEpisode ||
        selectTeslaDanmakuEpisode(episodes, episodeNumber, episodeLabel);
      const selectedEpisode = manualEpisode || automaticEpisode;
      onChoicesChange?.({
        programmes,
        episodes,
        selectedAnimeId: selected.animeId,
        selectedEpisodeId: selectedEpisode?.episodeId || null,
        automatic: !manualAnimeId && !manualEpisodeId,
      });
      if (!selectedEpisode) {
        onStatusChange?.('已找到节目，请手动选择弹幕集数');
        return;
      }

      const episodeId = selectedEpisode.episodeId;
      const matchedEpisodeTitle = selectedEpisode.episodeTitle;

      const rawComments = await getDanmakuById(
        episodeId,
        baseTitle,
        episodeNumber - 1,
        manualAnimeId || manualEpisodeId ? { bypassCache: true } : undefined,
        {
          animeId: selected.animeId,
          animeTitle: selected.animeTitle,
          episodeTitle: matchedEpisodeTitle,
          searchKeyword: baseTitle,
        }
      );
      if (cancelled) return;
      const matchedTitle = selected.animeTitle;
      if (rawComments.length === 0) {
        loadIdentityRef.current = '';
        onStatusChange?.('已匹配当前集，但暂无弹幕');
        return;
      }

      const converted = convertDanmakuFormat(rawComments)
        .filter((item) => item.text.trim() && Number.isFinite(item.time))
        .map((item) => ({
          text: item.text.slice(0, 80),
          time: item.time,
          color: item.color,
        }))
        .sort((a, b) => a.time - b.time);

      setComments(converted);
      const resumeFrom = Math.max(0, currentTimeRef.current - 0.2);
      commentCursorRef.current = lowerBoundComment(converted, resumeFrom);
      lastTimeRef.current = resumeFrom;
      onStatusChange?.(
        converted.length > 0
          ? `已自动匹配 ${matchedTitle}${
              matchedEpisodeTitle ? ` · ${matchedEpisodeTitle}` : ''
            }，加载 ${converted.length} 条`
          : '当前内容暂无弹幕'
      );
    };

    load().catch((error) => {
      if (cancelled) return;
      loadIdentityRef.current = '';
      console.warn('[TeslaDanmaku] load failed:', error);
      onStatusChange?.('弹幕加载超时，播放不受影响');
    });

    return () => {
      cancelled = true;
      if (loadIdentityRef.current === loadingIdentity) {
        loadIdentityRef.current = '';
      }
    };
  }, [
    baseTitle,
    contentIdentity,
    enabled,
    episodeLabel,
    episodeNumber,
    mediaType,
    manualAnimeId,
    manualEpisodeId,
    onChoicesChange,
    onStatusChange,
    title,
    totalEpisodes,
    year,
  ]);

  useEffect(() => {
    if (!enabled) {
      setActiveComments([]);
      lastTimeRef.current = currentTime;
      commentCursorRef.current = lowerBoundComment(comments, currentTime);
      return;
    }

    const previousTime = lastTimeRef.current;
    if (currentTime < previousTime || currentTime - previousTime > 2) {
      setActiveComments([]);
      const resumeFrom = Math.max(0, currentTime - 0.2);
      lastTimeRef.current = resumeFrom;
      commentCursorRef.current = lowerBoundComment(comments, resumeFrom);
      return;
    }

    let cursor = commentCursorRef.current;
    while (cursor < comments.length && comments[cursor].time <= previousTime)
      cursor++;
    const due: typeof comments = [];
    while (
      cursor < comments.length &&
      comments[cursor].time <= currentTime + 0.25 &&
      due.length < 6
    ) {
      due.push(comments[cursor]);
      cursor++;
    }
    commentCursorRef.current = cursor;

    setActiveComments((current) => {
      const stillVisible = current.filter(
        (comment) =>
          currentTime - comment.startedAt < animationDurationSec + 0.5
      );
      if (due.length === 0) return stillVisible;

      // Never evict a comment that is still crossing the screen. The previous
      // global slice made dense moments remove the oldest text halfway across.
      // Keep at most two comments per lane and drop only newly due overflow.
      const laneLoads = Array.from(
        { length: safeLaneCount },
        (_, lane) =>
          stillVisible.filter((comment) => comment.lane === lane).length
      );
      const spawned: OverlayComment[] = [];
      due.forEach((comment) => {
        let lane = 0;
        for (let index = 1; index < laneLoads.length; index++) {
          if (laneLoads[index] < laneLoads[lane]) lane = index;
        }
        if (laneLoads[lane] >= 2) return;
        const sequence = sequenceRef.current++;
        laneLoads[lane]++;
        spawned.push({
          id: `${comment.time}-${sequence}`,
          text: comment.text,
          color: comment.color,
          lane,
          startedAt: currentTime,
        });
      });
      if (
        spawned.length > 0 &&
        performance.now() - lastTimingLogAtRef.current >= 5000
      ) {
        lastTimingLogAtRef.current = performance.now();
        console.debug('[TeslaDanmakuTiming]', {
          videoPtsSec: Number(mediaTime.toFixed(3)),
          rawDanmakuTimeSec: Number(due[0].time.toFixed(3)),
          correctedRenderMediaPtsSec: Number(
            (due[0].time + timelineOffsetSec).toFixed(3)
          ),
          timelineOffsetSec: Number(timelineOffsetSec.toFixed(3)),
        });
      }
      return [...stillVisible, ...spawned];
    });

    lastTimeRef.current = currentTime;
  }, [
    animationDurationSec,
    comments,
    currentTime,
    enabled,
    mediaTime,
    safeLaneCount,
    timelineOffsetSec,
  ]);

  const visibleComments = useMemo(
    () => (enabled ? activeComments : []),
    [activeComments, enabled]
  );

  if (!enabled) return null;

  return (
    <div
      ref={stageRef}
      className='pointer-events-none absolute inset-0 z-[7] overflow-hidden'
      aria-hidden='true'
      style={
        {
          '--tesla-danmaku-stage-width': `${stageSize.width}px`,
        } as CSSProperties
      }
    >
      {visibleComments.map((comment) => (
        <span
          key={comment.id}
          className='tesla-danmaku-comment absolute whitespace-nowrap font-semibold'
          style={{
            // Keep all lanes in the upper band. Pixel spacing prevents three
            // lanes from consuming half of a short, non-fullscreen player.
            top: `${Math.round(10 + comment.lane * displayFontSize * 1.35)}px`,
            color: comment.color,
            animationDuration: `${animationDurationSec}s`,
            animationPlayState: playing ? 'running' : 'paused',
            fontSize: `${displayFontSize}px`,
          }}
        >
          {comment.text}
        </span>
      ))}
    </div>
  );
}
