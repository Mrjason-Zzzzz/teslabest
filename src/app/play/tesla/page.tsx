'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SearchResult } from '@/lib/types';

import TeslaPlayer from '@/components/TeslaPlayer';
import { fetchTVDetail, resolveTVEpisodeUrl } from '@/components/tv/player/utils';

function TeslaPlayPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const source = searchParams.get('source') || '';
  const id = searchParams.get('id') || '';
  const initialTitle = searchParams.get('title') || '';
  const year = searchParams.get('year') || '';
  const episodeParam = searchParams.get('episode');
  const initialEpisode = episodeParam ? Math.max(0, parseInt(episodeParam, 10) - 1) : 0;

  const [detail, setDetail] = useState<SearchResult | null>(null);
  const [loadingDetail, setLoadingDetail] = useState(true);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(initialEpisode);
  const [showEpisodePanel, setShowEpisodePanel] = useState(false);
  const [playUrl, setPlayUrl] = useState('');
  const [isAutoPlayingNext, setIsAutoPlayingNext] = useState(false);
  const detailSeqRef = useRef(0);

  useEffect(() => {
    document.title = initialTitle ? `${initialTitle} - Tesla 播放` : 'Tesla 播放';
  }, [initialTitle]);

  useEffect(() => {
    if (!source && !id && !initialTitle) {
      setDetailError('缺少参数：source / id / title');
      setLoadingDetail(false);
      return;
    }
    const seq = ++detailSeqRef.current;
    setLoadingDetail(true);
    setDetailError(null);

    console.log('[TeslaPlay] fetchTVDetail start', { source, id, title: initialTitle });

    fetchTVDetail({ source: source || null, id: id || null, title: initialTitle || null })
      .then(({ detail: d }) => {
        if (seq !== detailSeqRef.current) return;
        console.log('[TeslaPlay] fetchTVDetail success', {
          source: d.source,
          id: d.id,
          title: d.title,
          episodesCount: d.episodes?.length || 0,
          firstEpisode: d.episodes?.[0]?.slice(0, 100),
          proxyMode: d.proxyMode,
        });
        setDetail(d);
        if (!d.episodes || d.episodes.length === 0 || initialEpisode >= d.episodes.length) {
          setCurrentEpisodeIndex(0);
        } else {
          setCurrentEpisodeIndex(initialEpisode);
        }
        setLoadingDetail(false);
      })
      .catch((e) => {
        if (seq !== detailSeqRef.current) return;
        console.error('[TeslaPlay] fetchTVDetail failed', e);
        setDetailError(e?.message || '未找到播放源');
        setLoadingDetail(false);
      });
  }, [source, id, initialTitle]);

  useEffect(() => {
    if (!detail || !detail.episodes || currentEpisodeIndex >= detail.episodes.length) {
      setPlayUrl('');
      return;
    }
    let disposed = false;
    const rawUrl = detail.episodes[currentEpisodeIndex];
    console.log('[TeslaPlay] resolveTVEpisodeUrl start', {
      rawUrl: rawUrl.slice(0, 120),
      source: detail.source,
      proxyMode: detail.proxyMode,
    });
    resolveTVEpisodeUrl(rawUrl, detail.source, detail.proxyMode)
      .then((u) => {
        if (disposed) return;
        console.log('[TeslaPlay] resolveTVEpisodeUrl success', { resolvedUrl: u.slice(0, 120) });
        setPlayUrl(u);
        setIsAutoPlayingNext(false);
      })
      .catch((err) => {
        if (disposed) return;
        console.error('[TeslaPlay] resolveTVEpisodeUrl failed, fallback to raw', err);
        setPlayUrl(rawUrl);
        setIsAutoPlayingNext(false);
      });
    return () => {
      disposed = true;
    };
  }, [detail, currentEpisodeIndex]);

  const handlePlayEnded = useCallback(() => {
    if (!detail || !detail.episodes) return;
    if (currentEpisodeIndex < detail.episodes.length - 1) {
      setIsAutoPlayingNext(true);
      setTimeout(() => {
        setCurrentEpisodeIndex(currentEpisodeIndex + 1);
        const params = new URLSearchParams(window.location.search);
        params.set('episode', String(currentEpisodeIndex + 2));
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
      }, 1500);
    }
  }, [detail, currentEpisodeIndex]);

  const playRecordKey = useMemo(() => {
    if (!detail) return undefined;
    return `${detail.source}_${detail.id}_ep${currentEpisodeIndex}`;
  }, [detail, currentEpisodeIndex]);

  const episodeTitle = useMemo(() => {
    if (!detail) return '';
    const titles = detail.episodes_titles || [];
    return titles[currentEpisodeIndex] || `第 ${currentEpisodeIndex + 1} 集`;
  }, [detail, currentEpisodeIndex]);

  const fullTitle = useMemo(() => {
    const parts: string[] = [];
    if (initialTitle) parts.push(initialTitle);
    if (year) parts.push(year);
    if (episodeTitle) parts.push(episodeTitle);
    return parts.join(' - ');
  }, [initialTitle, year, episodeTitle]);

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/play?${params.toString()}`);
  }, [router, searchParams]);

  const handleSelectEpisode = useCallback((index: number) => {
    setCurrentEpisodeIndex(index);
    setShowEpisodePanel(false);
    const params = new URLSearchParams(window.location.search);
    params.set('episode', String(index + 1));
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      {/* 播放器区域 */}
      <div className="relative flex-1">
        {loadingDetail && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/70">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span>正在加载详情…</span>
          </div>
        )}
        {detailError && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-red-300">{detailError}</p>
            <button
              type="button"
              onClick={backToOriginal}
              className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            >
              返回原版
            </button>
          </div>
        )}
        {!loadingDetail && !detailError && playUrl && (
          <>
            <TeslaPlayer
              key={`${detail?.source}-${currentEpisodeIndex}`}
              url={playUrl}
              title={fullTitle}
              poster={detail?.poster}
              live={false}
              onBackToOriginal={backToOriginal}
              onEnded={handlePlayEnded}
              playRecordKey={playRecordKey}
            />
            {isAutoPlayingNext && (
              <div className="absolute inset-x-0 bottom-24 flex justify-center">
                <div className="rounded-full bg-black/80 px-4 py-2 backdrop-blur">
                  <span className="text-sm text-white/80">播放完毕，正在跳转下一集…</span>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      {/* 集数选择条 */}
      {detail && detail.episodes && detail.episodes.length > 1 && (
        <div className="relative border-t border-white/10 bg-zinc-950/95 backdrop-blur">
          <button
            type="button"
            onClick={() => setShowEpisodePanel((v) => !v)}
            className="flex w-full items-center justify-between px-4 py-3 text-sm font-medium"
          >
            <span className="flex items-center gap-2">
              <span className="text-white/60">选集</span>
              <span className="text-rose-400">{episodeTitle}</span>
              <span className="text-white/40">（共 {detail.episodes.length} 集）</span>
            </span>
            <ChevronDown
              className={`h-4 w-4 transition-transform ${showEpisodePanel ? 'rotate-180' : ''}`}
            />
          </button>
          {showEpisodePanel && (
            <div className="absolute bottom-full left-0 right-0 max-h-72 overflow-y-auto border-t border-white/10 bg-zinc-950/98 p-3 backdrop-blur">
              <div className="grid grid-cols-4 gap-2 sm:grid-cols-6 md:grid-cols-8">
                {detail.episodes.map((_, idx) => (
                  <button
                    key={idx}
                    type="button"
                    onClick={() => handleSelectEpisode(idx)}
                    className={`rounded px-2 py-1.5 text-sm transition-colors ${
                      idx === currentEpisodeIndex
                        ? 'bg-rose-600 text-white'
                        : 'bg-white/5 text-white/70 hover:bg-white/15'
                    }`}
                  >
                    {detail!.episodes_titles?.[idx] || `第 ${idx + 1} 集`}
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      {/* 返回条 */}
      <div className="flex items-center justify-between border-t border-white/10 bg-zinc-950 px-4 py-2 text-xs text-white/50">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex items-center gap-1 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回
        </button>
        <span>
          hls.js · Broadway.js · 双模式播放器
        </span>
      </div>
    </div>
  );
}

export default function TeslaPlayPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <TeslaPlayPageInner />
    </Suspense>
  );
}