'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import type { SearchResult } from '@/lib/types';

import TeslaPlayer from '@/components/TeslaPlayer';
import { fetchTVDetail, resolveTVEpisodeUrl } from '@/components/tv/player/utils';

/**
 * /tv/play/tesla
 *
 * 特斯拉车机适配版 TV 播放页。接收与 /tv/play 相同的 query 参数：
 *   - source, id, title, fileName, index
 *
 * 复用 fetchTVDetail / resolveTVEpisodeUrl 逻辑，确保 URL 拼接与原版一致；
 * 底层播放器为 TeslaPlayer（Broadway + Canvas）。
 */

function TeslaTVPlayPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const source = searchParams.get('source');
  const id = searchParams.get('id');
  const title = searchParams.get('title');
  const fileName = searchParams.get('fileName');
  const initialIndex = Number(searchParams.get('index') || '0');

  const [detail, setDetail] = useState<SearchResult | null>(null);
  const [sources, setSources] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentIndex, setCurrentIndex] = useState(initialIndex);
  const [playUrl, setPlayUrl] = useState('');
  const [showEpisodePanel, setShowEpisodePanel] = useState(false);

  useEffect(() => {
    if (!source && !id && !title) {
      setError('缺少参数：source / id / title');
      setLoading(false);
      return;
    }
    let disposed = false;
    fetchTVDetail({ source, id, title, fileName })
      .then(({ detail: d, sources: ss }) => {
        if (disposed) return;
        setDetail(d);
        setSources(ss);
        if (initialIndex >= d.episodes.length) {
          setCurrentIndex(0);
        }
        setLoading(false);
      })
      .catch((e) => {
        if (disposed) return;
        setError(e?.message || '详情获取失败');
        setLoading(false);
      });
    return () => {
      disposed = true;
    };
  }, [source, id, title, fileName]);

  // 解析当前集 URL
  useEffect(() => {
    if (!detail || !detail.episodes[currentIndex]) {
      setPlayUrl('');
      return;
    }
    let disposed = false;
    const rawUrl = detail.episodes[currentIndex];
    resolveTVEpisodeUrl(rawUrl, detail.source, detail.proxyMode)
      .then((u) => {
        if (!disposed) setPlayUrl(u);
      })
      .catch(() => {
        if (!disposed) setPlayUrl(rawUrl);
      });
    return () => {
      disposed = true;
    };
  }, [detail, currentIndex]);

  const episodeTitle = useMemo(() => {
    if (!detail) return '';
    const titles = detail.episodes_titles || [];
    return titles[currentIndex] || `第 ${currentIndex + 1} 集`;
  }, [detail, currentIndex]);

  const fullTitle = useMemo(() => {
    const parts: string[] = [];
    if (title || detail?.title) parts.push(title || detail?.title || '');
    if (episodeTitle) parts.push(episodeTitle);
    return parts.join(' - ');
  }, [title, detail, episodeTitle]);

  const handleSelectEpisode = useCallback((idx: number) => {
    setCurrentIndex(idx);
    setShowEpisodePanel(false);
    const params = new URLSearchParams(window.location.search);
    params.set('index', String(idx));
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  const handleSelectSource = useCallback((s: SearchResult) => {
    const params = new URLSearchParams();
    params.set('source', s.source);
    params.set('id', s.id);
    if (s.title) params.set('title', s.title);
    router.push(`/tv/play/tesla?${params.toString()}`);
  }, [router]);

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/tv/play?${params.toString()}`);
  }, [router, searchParams]);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="relative flex-1">
        {loading && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span>正在加载详情…</span>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-red-300">{error}</p>
            <button
              type="button"
              onClick={backToOriginal}
              className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            >
              切回原版 TV 播放
            </button>
          </div>
        )}
        {!loading && !error && playUrl && (
          <TeslaPlayer
            key={`${detail?.source}-${currentIndex}`}
            url={playUrl}
            title={fullTitle}
            poster={detail?.poster}
            onBackToOriginal={backToOriginal}
          />
        )}
      </div>

      {/* 集数选择 */}
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
                      idx === currentIndex
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

      {/* 换源条 */}
      {sources.length > 1 && (
        <div className="border-t border-white/10 bg-zinc-950 px-4 py-2 text-xs">
          <div className="flex items-center gap-2 overflow-x-auto">
            <span className="shrink-0 text-white/40">换源:</span>
            {sources.map((s) => (
              <button
                key={`${s.source}-${s.id}`}
                type="button"
                onClick={() => handleSelectSource(s)}
                className={`shrink-0 rounded px-2 py-1 hover:bg-white/10 ${
                  s.source === detail?.source && s.id === detail?.id
                    ? 'bg-white/15 text-white'
                    : 'text-white/60'
                }`}
              >
                {s.source_name}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="flex items-center justify-between border-t border-white/10 bg-zinc-950 px-4 py-2 text-xs text-white/50">
        <button
          type="button"
          onClick={() => router.back()}
          className="flex items-center gap-1 hover:text-white"
        >
          <ArrowLeft className="h-3.5 w-3.5" /> 返回
        </button>
        <span>Broadway.js · YUVCanvas · Canvas 软解模式</span>
      </div>
    </div>
  );
}

export default function TeslaTVPlayPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <TeslaTVPlayPageInner />
    </Suspense>
  );
}
