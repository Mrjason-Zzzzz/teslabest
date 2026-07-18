'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { ArrowLeft, ChevronDown, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SearchResult } from '@/lib/types';

import TeslaPlayer from '@/components/TeslaPlayer';

/**
 * /play/tesla
 *
 * 特斯拉车机适配版播放页。接收与 /play 完全相同的 query 参数：
 *   - source, id, title, year, episode, stitle, stype, ...
 *
 * 复用现有 /api/detail、/api/proxy/vod/m3u8、/api/proxy-m3u8 接口，
 * 但底层播放器换成 TeslaPlayer（Broadway.js + Canvas，不依赖 <video>）。
 *
 * 仅保留核心播放与切集功能，不复制原页面的弹幕/字幕/历史进度/优选源等复杂逻辑。
 */

function isM3u8Url(url: string): boolean {
  const lower = url.toLowerCase();
  if (lower.includes('.m3u8') || lower.includes('.m3u')) return true;
  if (lower.match(/\.(mp4|flv|webm|mkv|avi|mov)(\?.*)?$/)) return false;
  return true;
}

/** 与原 /play 一致的 URL 拼接策略：directplay 走 /api/proxy-m3u8，其他源走 /api/proxy/vod/m3u8 */
function buildProxyUrl(rawUrl: string, source: string, token?: string): string {
  if (!isM3u8Url(rawUrl)) {
    // 非 m3u8（如 mp4 直链）暂不支持 Broadway 软解（Broadway 仅 H.264 流），
    // 仍然返回原始 URL，由前端提示用户。
    return rawUrl;
  }
  if (source === 'directplay') {
    const tokenParam = token ? `&token=${encodeURIComponent(token)}` : '';
    return `/api/proxy-m3u8?url=${encodeURIComponent(rawUrl)}&source=directplay${tokenParam}`;
  }
  return `/api/proxy/vod/m3u8?url=${encodeURIComponent(rawUrl)}&source=${encodeURIComponent(source)}`;
}

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
  const detailSeqRef = useRef(0);

  // 读取 proxyToken（与原 /play 一致）
  const proxyToken = useMemo(() => {
    if (typeof window === 'undefined') return '';
    try {
      const raw = localStorage.getItem('proxyToken');
      return raw || '';
    } catch {
      return '';
    }
  }, []);

  useEffect(() => {
    document.title = initialTitle ? `${initialTitle} - Tesla 播放` : 'Tesla 播放';
  }, [initialTitle]);

  // 拉取详情
  useEffect(() => {
    if (!source || !id) {
      setDetailError('缺少参数：source / id');
      setLoadingDetail(false);
      return;
    }
    const seq = ++detailSeqRef.current;
    setLoadingDetail(true);
    setDetailError(null);

    fetch(`/api/detail?id=${encodeURIComponent(id)}&source=${encodeURIComponent(source)}`)
      .then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        return r.json();
      })
      .then((data: any) => {
        if (seq !== detailSeqRef.current) return;
        if (!data || !data.list || !Array.isArray(data.list) || data.list.length === 0) {
          setDetailError('未找到播放源');
          setLoadingDetail(false);
          return;
        }
        const sources: SearchResult[] = data.list;
        // 优先匹配 url 中的 source；找不到就取第一个
        const matched =
          sources.find((s) => s.source === source) || sources[0];
        setDetail(matched);
        // 如果详情中的集数少于初始集，重置为 0
        if (
          !matched.episodes ||
          matched.episodes.length === 0 ||
          initialEpisode >= matched.episodes.length
        ) {
          setCurrentEpisodeIndex(0);
        } else {
          setCurrentEpisodeIndex(initialEpisode);
        }
        setLoadingDetail(false);
      })
      .catch((e) => {
        if (seq !== detailSeqRef.current) return;
        setDetailError(e?.message || '详情获取失败');
        setLoadingDetail(false);
      });
  }, [source, id]);

  // 当前集的播放 URL
  const currentPlayUrl = useMemo(() => {
    if (!detail || !detail.episodes || detail.episodes.length === 0) return '';
    const raw = detail.episodes[currentEpisodeIndex];
    if (!raw) return '';
    return buildProxyUrl(raw, detail.source, proxyToken);
  }, [detail, currentEpisodeIndex, proxyToken]);

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

  // 非 m3u8 资源（如 mp4 直链）警告
  const isUnsupportedFormat = useMemo(() => {
    if (!detail || !detail.episodes) return false;
    const raw = detail.episodes[currentEpisodeIndex];
    if (!raw) return false;
    return !isM3u8Url(raw);
  }, [detail, currentEpisodeIndex]);

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/play?${params.toString()}`);
  }, [router, searchParams]);

  const handleSelectEpisode = useCallback((index: number) => {
    setCurrentEpisodeIndex(index);
    setShowEpisodePanel(false);
    // 同步 URL 中的 episode 参数（与原 /play 一致：1-based）
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
        {!loadingDetail && !detailError && currentPlayUrl && !isUnsupportedFormat && (
          <TeslaPlayer
            key={`${detail?.source}-${currentEpisodeIndex}`}
            url={currentPlayUrl}
            title={fullTitle}
            poster={detail?.poster}
            live={false}
            onBackToOriginal={backToOriginal}
          />
        )}
        {!loadingDetail && !detailError && isUnsupportedFormat && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/80">
            <p className="text-amber-300">
              当前资源为非 m3u8 格式（如 mp4 直链），Broadway.js 软解仅支持 H.264 TS 流。
            </p>
            <button
              type="button"
              onClick={backToOriginal}
              className="rounded bg-white/10 px-3 py-1.5 text-sm hover:bg-white/20"
            >
              切回原版播放器
            </button>
          </div>
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
          Broadway.js · YUVCanvas · Canvas 软解模式 · 不依赖 &lt;video&gt;
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
