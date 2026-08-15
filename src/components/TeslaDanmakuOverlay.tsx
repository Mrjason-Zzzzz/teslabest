'use client';

import { useEffect, useMemo, useRef, useState } from 'react';

import {
  convertDanmakuFormat,
  getDanmakuById,
  getEpisodes,
  searchAnime,
} from '@/lib/danmaku/api';

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
  currentTime: number;
  playing: boolean;
  onStatusChange?: (status: string) => void;
}

const LANE_COUNT = 7;

function cleanVideoTitle(value: string) {
  return value
    .replace(/\s*-\s*\d{4}\s*-\s*第\s*\d+\s*集.*$/u, '')
    .replace(/\s*-\s*第\s*\d+\s*集.*$/u, '')
    .replace(/\s*第\s*\d+\s*集.*$/u, '')
    .replace(/(?:\[|\]|【|】)/g, ' ')
    .trim();
}

function getEpisodeNumber(value: string) {
  const match = value.match(/第\s*(\d+)\s*集/u);
  return match ? Math.max(1, Number(match[1])) : 1;
}

export default function TeslaDanmakuOverlay({
  enabled,
  title = '',
  currentTime,
  playing,
  onStatusChange,
}: TeslaDanmakuOverlayProps) {
  const [comments, setComments] = useState<
    Array<{ text: string; time: number; color: string }>
  >([]);
  const [activeComments, setActiveComments] = useState<OverlayComment[]>([]);
  const loadIdentityRef = useRef('');
  const lastTimeRef = useRef(0);
  const sequenceRef = useRef(0);

  const contentIdentity = `${cleanVideoTitle(title)}|${getEpisodeNumber(
    title
  )}`;

  useEffect(() => {
    if (!enabled || !title || loadIdentityRef.current === contentIdentity)
      return;

    let cancelled = false;
    const baseTitle = cleanVideoTitle(title);
    const episodeNumber = getEpisodeNumber(title);

    setComments([]);
    setActiveComments([]);
    loadIdentityRef.current = contentIdentity;
    onStatusChange?.('正在匹配弹幕…');

    const load = async () => {
      const searchResult = await searchAnime(baseTitle);
      if (cancelled) return;

      const anime = searchResult.success ? searchResult.animes?.[0] : null;
      if (!anime) {
        loadIdentityRef.current = '';
        onStatusChange?.('暂无可匹配弹幕');
        return;
      }

      const episodeResult = await getEpisodes(anime.animeId);
      if (cancelled) return;

      const episodes = episodeResult.bangumi?.episodes || [];
      const episode =
        episodes[Math.min(episodes.length - 1, episodeNumber - 1)] ||
        episodes[0];
      if (!episode) {
        loadIdentityRef.current = '';
        onStatusChange?.('暂无可匹配弹幕');
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
      // The playback-time effect below aligns the cursor without spawning
      // every historical comment when danmaku is enabled mid-video.
      lastTimeRef.current = 0;
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
    };
  }, [contentIdentity, enabled, onStatusChange, title]);

  useEffect(() => {
    if (!enabled) {
      setActiveComments([]);
      lastTimeRef.current = currentTime;
      return;
    }

    const previousTime = lastTimeRef.current;
    if (currentTime < previousTime || currentTime - previousTime > 2) {
      setActiveComments([]);
      lastTimeRef.current = Math.max(0, currentTime - 0.2);
      return;
    }

    const due = comments
      .filter(
        (comment) =>
          comment.time > previousTime && comment.time <= currentTime + 0.25
      )
      .slice(0, 6);

    setActiveComments((current) => {
      const stillVisible = current.filter(
        (comment) => currentTime - comment.startedAt < 9.5
      );
      if (due.length === 0) return stillVisible;

      const spawned = due.map((comment) => {
        const sequence = sequenceRef.current++;
        return {
          id: `${comment.time}-${sequence}`,
          text: comment.text,
          color: comment.color,
          lane: sequence % LANE_COUNT,
          startedAt: currentTime,
        };
      });
      return [...stillVisible, ...spawned].slice(-36);
    });

    lastTimeRef.current = currentTime;
  }, [comments, currentTime, enabled]);

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
            top: `${7 + comment.lane * 9}%`,
            color: comment.color,
            animationPlayState: playing ? 'running' : 'paused',
          }}
        >
          {comment.text}
        </span>
      ))}
    </div>
  );
}
