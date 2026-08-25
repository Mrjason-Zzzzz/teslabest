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
  rankTeslaDanmakuCandidates,
  scoreTeslaDanmakuCandidate,
  selectTeslaDanmakuEpisode,
} from '@/lib/tesla/danmaku-match';

type OverlayComment = {
  id: string;
  text: string;
  color: string;
  lane: number;
  startedAt: number;
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
  playing: boolean;
  laneCount?: number;
  speed?: number;
  fontSize?: number;
  onStatusChange?: (status: string) => void;
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
  playing,
  laneCount = 7,
  speed = 3,
  fontSize = 30,
  onStatusChange,
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
  const contentIdentity = `${baseTitle}|${year}|${mediaType}|${episodeNumber}|${episodeLabel}|${totalEpisodes}`;

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
      const searchKeywords = buildTeslaDanmakuSearchKeywords(baseTitle);
      const fileNames = searchKeywords.map((keyword) =>
        buildTeslaDanmakuFileName({
          title: keyword,
          year,
          episode: episodeNumber,
        })
      );
      const directMatches = [];
      for (const fileName of fileNames) {
        const matched = await matchAnime(fileName);
        if (cancelled) return;
        directMatches.push(
          ...(matched.matches || []).filter((item) => {
            const matchedEpisode = parseTeslaDanmakuEpisodeNumber(
              item.episodeTitle || ''
            );
            return (
              scoreTeslaDanmakuCandidate(item, context) >= 45 &&
              (matchedEpisode === null || matchedEpisode === episodeNumber)
            );
          })
        );
      }

      const searchedCandidates = [];
      for (const keyword of searchKeywords) {
        const searchResult = await searchAnime(keyword);
        if (cancelled) return;
        if (searchResult.success) {
          searchedCandidates.push(...(searchResult.animes || []));
        }
      }

      const attempts: Array<{
        animeId: number;
        animeTitle: string;
        episodeId?: number;
        episodeTitle?: string;
      }> = [];
      const seenAttempts = new Set<string>();
      for (const match of directMatches) {
        const key = `${match.animeId}:${match.episodeId}`;
        if (seenAttempts.has(key)) continue;
        seenAttempts.add(key);
        attempts.push(match);
      }
      for (const anime of rankTeslaDanmakuCandidates(
        searchedCandidates,
        context
      )) {
        const key = `${anime.animeId}:search`;
        if (seenAttempts.has(key)) continue;
        seenAttempts.add(key);
        attempts.push(anime);
      }

      let rawComments: Awaited<ReturnType<typeof getDanmakuById>> = [];
      let matchedTitle = '';
      let matchedEpisodeTitle = '';
      for (const attempt of attempts.slice(0, 8)) {
        let episodeId = attempt.episodeId;
        let resolvedEpisodeTitle = attempt.episodeTitle || '';
        if (!episodeId) {
          const episodeResult = await getEpisodes(attempt.animeId);
          if (cancelled) return;
          const episode = selectTeslaDanmakuEpisode(
            episodeResult.bangumi?.episodes || [],
            episodeNumber,
            episodeLabel
          );
          if (!episode) continue;
          episodeId = episode.episodeId;
          resolvedEpisodeTitle = episode.episodeTitle;
        }
        const commentsForAttempt = await getDanmakuById(
          episodeId,
          baseTitle,
          episodeNumber - 1,
          undefined,
          {
            animeId: attempt.animeId,
            animeTitle: attempt.animeTitle,
            episodeTitle: resolvedEpisodeTitle,
            searchKeyword: baseTitle,
          }
        );
        if (cancelled) return;
        if (commentsForAttempt.length === 0) continue;
        rawComments = commentsForAttempt;
        matchedTitle = attempt.animeTitle;
        matchedEpisodeTitle = resolvedEpisodeTitle;
        break;
      }
      if (rawComments.length === 0) {
        loadIdentityRef.current = '';
        onStatusChange?.(
          attempts.length > 0 ? '匹配结果暂无弹幕' : '未找到可靠弹幕匹配'
        );
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
      return [...stillVisible, ...spawned];
    });

    lastTimeRef.current = currentTime;
  }, [animationDurationSec, comments, currentTime, enabled, safeLaneCount]);

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
