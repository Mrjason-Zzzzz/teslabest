'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  convertDanmakuFormat,
  getDanmakuById,
  getEpisodes,
  matchAnime,
  searchAnime,
} from '@/lib/danmaku/api';
import {
  buildTeslaDanmakuFileName,
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
  const loadIdentityRef = useRef('');
  const lastTimeRef = useRef(0);
  const sequenceRef = useRef(0);
  const commentCursorRef = useRef(0);
  const currentTimeRef = useRef(currentTime);
  currentTimeRef.current = currentTime;

  const safeLaneCount = Math.max(3, Math.min(8, Math.floor(laneCount || 7)));
  const safeSpeed = Math.max(1, Math.min(5, Math.floor(speed || 3)));
  const safeFontSize = Math.max(18, Math.min(44, Math.floor(fontSize || 30)));
  const animationDurationSec = 14 - (safeSpeed - 1) * 2;
  const baseTitle = cleanTeslaDanmakuTitle(title);
  const contentIdentity = `${baseTitle}|${year}|${mediaType}|${episodeNumber}|${episodeLabel}|${totalEpisodes}`;

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
      const searchKeywords = Array.from(
        new Set([
          baseTitle,
          baseTitle.replace(/\s*第\s*[0-9一-十两]+\s*季.*$/u, '').trim(),
        ].filter(Boolean))
      );
      let anime = null;
      for (const keyword of searchKeywords) {
        const searchResult = await searchAnime(keyword);
        if (cancelled) return;
        if (!searchResult.success) continue;
        anime = selectTeslaDanmakuCandidate(searchResult.animes || [], {
          title: baseTitle,
          year,
          mediaType,
          totalEpisodes,
        });
        if (anime) break;
      }
      if (cancelled) return;

      // Search results are not complete for every provider. Use the structured
      // filename matcher as a generic fallback, but accept it only when title,
      // media type and episode number still agree with the current programme.
      if (!anime) {
        const matched = await matchAnime(
          buildTeslaDanmakuFileName({
            title: baseTitle,
            year,
            episode: episodeNumber,
          })
        );
        if (cancelled) return;
        const reliableMatch = (matched.matches || []).find((item) => {
          const score = scoreTeslaDanmakuCandidate(item, {
            title: baseTitle,
            year,
            mediaType,
            totalEpisodes,
          });
          const matchedEpisode = parseTeslaDanmakuEpisodeNumber(
            item.episodeTitle || ''
          );
          return score >= 70 &&
            (matchedEpisode === null || matchedEpisode === episodeNumber);
        });
        if (reliableMatch) {
          anime = {
            animeId: reliableMatch.animeId,
            animeTitle: reliableMatch.animeTitle,
            type: reliableMatch.type,
            typeDescription: reliableMatch.typeDescription,
          };
        }
      }
      if (!anime) {
        loadIdentityRef.current = '';
        onStatusChange?.('未找到可靠弹幕匹配');
        return;
      }

      const episodeResult = await getEpisodes(anime.animeId);
      if (cancelled) return;

      const episodes = episodeResult.bangumi?.episodes || [];
      const episode = selectTeslaDanmakuEpisode(
        episodes,
        episodeNumber,
        episodeLabel
      );
      if (!episode) {
        loadIdentityRef.current = '';
        onStatusChange?.('未找到对应集数弹幕');
        return;
      }

      const rawComments = await getDanmakuById(
        episode.episodeId,
        baseTitle,
        episodeNumber - 1,
        undefined,
        {
          animeId: anime.animeId,
          animeTitle: anime.animeTitle,
          episodeTitle: episode.episodeTitle,
          searchKeyword: baseTitle,
        }
      );
      if (cancelled) return;

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
          ? `已加载 ${converted.length} 条弹幕`
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

      const spawned = due.map((comment) => {
        const sequence = sequenceRef.current++;
        return {
          id: `${comment.time}-${sequence}`,
          text: comment.text,
          color: comment.color,
          lane: sequence % safeLaneCount,
          startedAt: currentTime,
        };
      });
      return [...stillVisible, ...spawned].slice(-(safeLaneCount * 2));
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
      className='pointer-events-none absolute inset-0 z-[7] overflow-hidden'
      aria-hidden='true'
    >
      {visibleComments.map((comment) => (
        <span
          key={comment.id}
          className='tesla-danmaku-comment absolute whitespace-nowrap font-semibold'
          style={{
            top: `${6 + comment.lane * (62 / safeLaneCount)}%`,
            color: comment.color,
            animationDuration: `${animationDurationSec}s`,
            animationPlayState: playing ? 'running' : 'paused',
            fontSize: `${safeFontSize}px`,
          }}
        >
          {comment.text}
        </span>
      ))}
    </div>
  );
}
