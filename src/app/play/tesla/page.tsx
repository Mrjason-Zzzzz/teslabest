'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

import { ArrowLeft, ChevronDown, Loader2, Search, Zap, Sparkles, Film, MonitorPlay, Settings2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SearchResult } from '@/lib/types';

import TeslaPlayer from '@/components/TeslaPlayer';
import { fetchTVDetail, resolveTVEpisodeUrl } from '@/components/tv/player/utils';

type LoadingStage = 'searching' | 'preferring' | 'fetching' | 'ready' | 'error';

const LOADING_STAGES = [
  { key: 'searching', icon: Search, label: '正在搜索播放源...', color: 'text-green-400', bg: 'bg-green-500' },
  { key: 'preferring', icon: Zap, label: '正在优选最佳播放源...', color: 'text-yellow-400', bg: 'bg-yellow-500' },
  { key: 'fetching', icon: Film, label: '正在获取视频详情...', color: 'text-blue-400', bg: 'bg-blue-500' },
  { key: 'ready', icon: Sparkles, label: '准备就绪，即将开始播放...', color: 'text-emerald-400', bg: 'bg-emerald-500' },
];

function TeslaPlayPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const source = searchParams.get('source') || '';
  const id = searchParams.get('id') || '';
  const initialTitle = searchParams.get('title') || '';
  const year = searchParams.get('year') || '';
  const stype = searchParams.get('stype') || '';
  const episodeParam = searchParams.get('episode');
  const initialEpisode = episodeParam ? Math.max(0, parseInt(episodeParam, 10) - 1) : 0;

  const [loadingStage, setLoadingStage] = useState<LoadingStage>(
    source && id ? 'fetching' : 'searching'
  );
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [allSources, setAllSources] = useState<SearchResult[]>([]);
  const [currentDetail, setCurrentDetail] = useState<SearchResult | null>(null);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(initialEpisode);
  const [playUrl, setPlayUrl] = useState('');
  const [isAutoPlayingNext, setIsAutoPlayingNext] = useState(false);

  const [rightTab, setRightTab] = useState<'episodes' | 'sources'>('episodes');
  const [episodePage, setEpisodePage] = useState(0);
  const EPISODES_PER_PAGE = 50;

  const detailSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const currentSource = currentDetail?.source || '';
  const currentId = currentDetail?.id || '';

  useEffect(() => {
    document.title = initialTitle ? `${initialTitle} - Tesla 播放` : 'Tesla 播放';
  }, [initialTitle]);

  const searchSources = useCallback(async (query: string): Promise<SearchResult[]> => {
    if (!query) return [];
    const seq = ++searchSeqRef.current;
    setLoadingStage('searching');

    try {
      const res = await fetch(`/api/search?q=${encodeURIComponent(query.trim())}`);
      if (!res.ok) throw new Error('搜索失败');
      const data = await res.json();
      if (seq !== searchSeqRef.current) return [];
      return (data.results || []) as SearchResult[];
    } catch (e) {
      if (seq !== searchSeqRef.current) return [];
      console.error('[TeslaPlay] search error:', e);
      throw e;
    }
  }, []);

  const preferBestSource = useCallback((sources: SearchResult[]): SearchResult => {
    if (sources.length <= 1) return sources[0];
    const sorted = [...sources].sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0));
    return sorted[0];
  }, []);

  const fetchDetail = useCallback(async (src: string, vid: string, title: string): Promise<SearchResult> => {
    const seq = ++detailSeqRef.current;
    const { detail } = await fetchTVDetail({
      source: src || null,
      id: vid || null,
      title: title || null,
    });
    if (seq !== detailSeqRef.current) throw new Error('stale');
    return detail;
  }, []);

  useEffect(() => {
    let cancelled = false;

    const init = async () => {
      setErrorMsg(null);

      try {
        let sources: SearchResult[] = [];
        let selected: SearchResult | null = null;

        if (source && id) {
          setLoadingStage('fetching');
          try {
            selected = await fetchDetail(source, id, initialTitle);
            sources = [selected];
          } catch (e) {
            console.warn('[TeslaPlay] direct detail failed, falling back to search');
          }

          if (!selected && initialTitle) {
            sources = await searchSources(initialTitle);
            if (sources.length > 0) {
              setLoadingStage('preferring');
              await new Promise((r) => setTimeout(r, 400));
              selected = preferBestSource(sources);
            }
          }
        } else if (initialTitle) {
          sources = await searchSources(initialTitle);
          if (sources.length === 0) {
            throw new Error('未找到匹配的播放源');
          }
          setAllSources(sources);

          if (sources.length > 1) {
            setLoadingStage('preferring');
            await new Promise((r) => setTimeout(r, 600));
          }

          selected = preferBestSource(sources);
          setLoadingStage('fetching');
          selected = await fetchDetail(selected.source, selected.id, initialTitle);
        } else {
          throw new Error('缺少必要参数：title 或 source/id');
        }

        if (!selected) {
          throw new Error('未找到可用的播放源');
        }

        if (cancelled) return;

        if (sources.length === 0) sources = [selected];
        setAllSources(sources);
        setCurrentDetail(selected);

        const epIdx = initialEpisode < (selected.episodes?.length || 0) ? initialEpisode : 0;
        setCurrentEpisodeIndex(epIdx);

        setLoadingStage('ready');
        await new Promise((r) => setTimeout(r, 300));
      } catch (e) {
        if (cancelled) return;
        console.error('[TeslaPlay] init error:', e);
        setErrorMsg(e instanceof Error ? e.message : '加载失败');
        setLoadingStage('error');
      }
    };

    init();
    return () => { cancelled = true; };
  }, [source, id, initialTitle, initialEpisode, fetchDetail, searchSources, preferBestSource]);

  useEffect(() => {
    if (!currentDetail || !currentDetail.episodes || currentEpisodeIndex >= currentDetail.episodes.length) {
      setPlayUrl('');
      return;
    }
    let disposed = false;
    const rawUrl = currentDetail.episodes[currentEpisodeIndex];
    resolveTVEpisodeUrl(rawUrl, currentDetail.source, currentDetail.proxyMode)
      .then((u) => {
        if (disposed) return;
        setPlayUrl(u);
        setIsAutoPlayingNext(false);
      })
      .catch((err) => {
        if (disposed) return;
        console.error('[TeslaPlay] resolve episode url failed, fallback to raw', err);
        setPlayUrl(rawUrl);
        setIsAutoPlayingNext(false);
      });
    return () => { disposed = true; };
  }, [currentDetail, currentEpisodeIndex]);

  const handlePlayEnded = useCallback(() => {
    if (!currentDetail || !currentDetail.episodes) return;
    if (currentEpisodeIndex < currentDetail.episodes.length - 1) {
      setIsAutoPlayingNext(true);
      setTimeout(() => {
        setCurrentEpisodeIndex(currentEpisodeIndex + 1);
        const params = new URLSearchParams(window.location.search);
        params.set('episode', String(currentEpisodeIndex + 2));
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
      }, 1500);
    }
  }, [currentDetail, currentEpisodeIndex]);

  const handleSelectEpisode = useCallback((index: number) => {
    setCurrentEpisodeIndex(index);
    const params = new URLSearchParams(window.location.search);
    params.set('episode', String(index + 1));
    if (currentDetail) {
      params.set('source', currentDetail.source);
      params.set('id', currentDetail.id);
    }
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [currentDetail]);

  const handleSwitchSource = useCallback(async (src: SearchResult) => {
    if (src.source === currentSource && src.id === currentId) return;
    setLoadingStage('fetching');
    try {
      const detail = await fetchDetail(src.source, src.id, initialTitle);
      setCurrentDetail(detail);
      const epIdx = initialEpisode < (detail.episodes?.length || 0) ? initialEpisode : 0;
      setCurrentEpisodeIndex(epIdx);
      setLoadingStage('ready');
      setTimeout(() => setLoadingStage((s) => s === 'ready' ? 'ready' : s), 100);
    } catch (e) {
      console.error('[TeslaPlay] switch source error:', e);
      setErrorMsg(e instanceof Error ? e.message : '切换源失败');
      setLoadingStage('error');
    }
  }, [currentSource, currentId, fetchDetail, initialTitle, initialEpisode]);

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/play?${params.toString()}`);
  }, [router, searchParams]);

  const episodeTitle = useMemo(() => {
    if (!currentDetail) return '';
    const titles = currentDetail.episodes_titles || [];
    return titles[currentEpisodeIndex] || `第 ${currentEpisodeIndex + 1} 集`;
  }, [currentDetail, currentEpisodeIndex]);

  const fullTitle = useMemo(() => {
    const parts: string[] = [];
    if (initialTitle) parts.push(initialTitle);
    if (year) parts.push(year);
    if (episodeTitle) parts.push(episodeTitle);
    return parts.join(' - ');
  }, [initialTitle, year, episodeTitle]);

  const playRecordKey = useMemo(() => {
    if (!currentDetail) return undefined;
    return `${currentDetail.source}_${currentDetail.id}_ep${currentEpisodeIndex}`;
  }, [currentDetail, currentEpisodeIndex]);

  const totalPages = useMemo(() => {
    if (!currentDetail?.episodes) return 0;
    return Math.ceil(currentDetail.episodes.length / EPISODES_PER_PAGE);
  }, [currentDetail]);

  const currentPageEpisodes = useMemo(() => {
    if (!currentDetail?.episodes) return [] as { idx: number; label: string }[];
    const start = episodePage * EPISODES_PER_PAGE;
    const end = Math.min(start + EPISODES_PER_PAGE, currentDetail.episodes.length);
    const result: { idx: number; label: string }[] = [];
    for (let i = start; i < end; i++) {
      const label = currentDetail.episodes_titles?.[i] || `第 ${i + 1} 集`;
      result.push({ idx: i, label });
    }
    return result;
  }, [currentDetail, episodePage]);

  const isLoading = loadingStage !== 'error' && (!currentDetail || !playUrl || loadingStage === 'ready');
  const currentStageIndex = LOADING_STAGES.findIndex((s) => s.key === loadingStage);
  const progressPercent = loadingStage === 'error' ? 0 : ((currentStageIndex + 1) / LOADING_STAGES.length) * 100;

  return (
    <div className="fixed inset-0 flex flex-col bg-neutral-950 text-white">
      {/* 顶部栏 */}
      <div className="flex items-center justify-between border-b border-white/5 bg-neutral-950/90 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex items-center gap-1 text-sm text-white/60 transition-colors hover:text-white"
          >
            <ArrowLeft className="h-4 w-4" />
            <span>返回</span>
          </button>
          <div className="h-4 w-px bg-white/10" />
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium text-white/90">{initialTitle || '视频播放'}</span>
            {currentDetail && currentDetail.episodes && currentDetail.episodes.length > 1 && (
              <>
                <span className="text-white/30">›</span>
                <span className="text-rose-400">{episodeTitle}</span>
              </>
            )}
            {currentDetail?.vod_remarks && (
              <span className="ml-1 rounded bg-rose-500/15 px-1.5 py-0.5 text-xs text-rose-400">
                {currentDetail.vod_remarks}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={backToOriginal}
            className="flex items-center gap-1.5 rounded-lg bg-white/5 px-3 py-1.5 text-xs text-white/60 transition-colors hover:bg-white/10 hover:text-white"
          >
            <MonitorPlay className="h-3.5 w-3.5" />
            原版
          </button>
          <button
            type="button"
            className="flex items-center gap-1 rounded-lg p-1.5 text-white/50 transition-colors hover:bg-white/10 hover:text-white"
          >
            <Settings2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* 主体区域 */}
      <div className="flex flex-1 overflow-hidden">
        {/* 左侧：播放器 + 详情 */}
        <div className="flex min-w-0 flex-1 flex-col">
          {/* 播放器容器 */}
          <div className="relative aspect-video w-full bg-black">
            {isLoading && loadingStage !== 'error' && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4">
                <div className="relative">
                  <div className="relative h-20 w-20">
                    <div className="absolute inset-0 animate-pulse rounded-2xl bg-gradient-to-br from-green-500/30 to-emerald-500/20" />
                    <div className="absolute inset-2 flex items-center justify-center rounded-xl bg-gradient-to-br from-green-500 to-emerald-600 shadow-lg shadow-green-500/30">
                      {loadingStage !== 'error' && currentStageIndex >= 0 && (() => {
                        const Icon = LOADING_STAGES[currentStageIndex]?.icon || Search;
                        return <Icon className="h-8 w-8 text-white" />;
                      })()}
                    </div>
                  </div>
                  <div className="absolute -left-1 top-1/4 h-1.5 w-1.5 animate-bounce rounded-full bg-green-400/60" style={{ animationDelay: '0s' }} />
                  <div className="absolute -right-1 top-1/3 h-1 w-1 animate-bounce rounded-full bg-green-400/40" style={{ animationDelay: '0.3s' }} />
                  <div className="absolute left-1/2 -top-2 h-1.5 w-1.5 animate-ping rounded-full bg-green-400/30" style={{ animationDelay: '0.6s' }} />
                </div>

                <div className="w-56">
                  <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-white/5">
                    <div
                      className={`h-full rounded-full transition-all duration-500 ${
                        loadingStage !== 'error' && currentStageIndex >= 0
                          ? LOADING_STAGES[currentStageIndex]?.bg
                          : 'bg-green-500'
                      }`}
                      style={{ width: `${progressPercent}%` }}
                    />
                  </div>
                  <div className="flex justify-center gap-1">
                    {LOADING_STAGES.map((s, i) => (
                      <div
                        key={s.key}
                        className={`h-1.5 w-1.5 rounded-full transition-all ${
                          i <= currentStageIndex ? `${s.bg} opacity-100` : 'bg-white/10'
                        }`}
                      />
                    ))}
                  </div>
                </div>

                <p className={`text-sm font-medium ${
                  loadingStage !== 'error' && currentStageIndex >= 0
                    ? LOADING_STAGES[currentStageIndex]?.color
                    : 'text-white/60'
                }`}>
                  {loadingStage !== 'error' && currentStageIndex >= 0
                    ? LOADING_STAGES[currentStageIndex]?.label
                    : '加载中...'}
                </p>
              </div>
            )}

            {loadingStage === 'error' && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 px-6 text-center">
                <p className="text-red-400">{errorMsg}</p>
                <div className="flex gap-2">
                  <button
                    type="button"
                    onClick={() => window.location.reload()}
                    className="rounded-lg bg-white/10 px-4 py-1.5 text-sm hover:bg-white/20"
                  >
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={backToOriginal}
                    className="rounded-lg bg-rose-500/20 px-4 py-1.5 text-sm text-rose-300 hover:bg-rose-500/30"
                  >
                    返回原版
                  </button>
                </div>
              </div>
            )}

            {!isLoading && loadingStage !== 'error' && playUrl && currentDetail && (
              <>
                <TeslaPlayer
                  key={`${currentDetail.source}-${currentEpisodeIndex}`}
                  url={playUrl}
                  title={fullTitle}
                  poster={currentDetail.poster}
                  live={false}
                  onEnded={handlePlayEnded}
                  playRecordKey={playRecordKey}
                />
                {isAutoPlayingNext && (
                  <div className="absolute inset-x-0 bottom-20 z-10 flex justify-center">
                    <div className="rounded-full bg-black/80 px-4 py-2 backdrop-blur">
                      <span className="text-sm text-white/80">播放完毕，正在跳转下一集…</span>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>

          {/* 视频详情 */}
          {currentDetail && (
            <div className="flex-1 overflow-y-auto px-4 py-4">
              <div className="flex gap-4">
                {currentDetail.poster && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={currentDetail.poster}
                    alt={currentDetail.title}
                    className="h-36 w-24 flex-shrink-0 rounded-lg object-cover shadow-lg"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <h1 className="truncate text-lg font-bold">{currentDetail.title}</h1>
                  <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-white/50">
                    {currentDetail.rating !== undefined && currentDetail.rating > 0 && (
                      <span className="text-yellow-400">★ {currentDetail.rating.toFixed(1)}</span>
                    )}
                    {currentDetail.year && <span>{currentDetail.year}</span>}
                    {currentDetail.type_name && <span>{currentDetail.type_name}</span>}
                    {currentDetail.source_name && (
                      <span className="rounded bg-white/5 px-1.5 py-0.5">
                        源：{currentDetail.source_name}
                      </span>
                    )}
                  </div>
                  {currentDetail.desc && (
                    <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-white/60">
                      {currentDetail.desc}
                    </p>
                  )}
                </div>
              </div>
            </div>
          )}
        </div>

        {/* 右侧面板 */}
        {currentDetail && currentDetail.episodes && currentDetail.episodes.length > 0 && (
          <div className="flex w-72 flex-shrink-0 flex-col border-l border-white/5 bg-neutral-950/50">
            <div className="flex border-b border-white/5">
              <button
                type="button"
                onClick={() => setRightTab('episodes')}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                  rightTab === 'episodes'
                    ? 'border-b-2 border-green-500 text-green-400'
                    : 'text-white/50 hover:text-white/80'
                }`}
              >
                选集
              </button>
              <button
                type="button"
                onClick={() => setRightTab('sources')}
                className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                  rightTab === 'sources'
                    ? 'border-b-2 border-green-500 text-green-400'
                    : 'text-white/50 hover:text-white/80'
                }`}
              >
                换源
              </button>
            </div>

            {rightTab === 'episodes' && (
              <div className="flex flex-1 flex-col overflow-hidden">
                {totalPages > 1 && (
                  <div className="flex flex-wrap gap-1 border-b border-white/5 px-3 py-2">
                    {Array.from({ length: totalPages }, (_, i) => {
                      const start = i * EPISODES_PER_PAGE + 1;
                      const end = Math.min((i + 1) * EPISODES_PER_PAGE, currentDetail.episodes!.length);
                      return (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setEpisodePage(i)}
                          className={`rounded px-2 py-0.5 text-xs transition-colors ${
                            i === episodePage
                              ? 'bg-green-500/20 text-green-400'
                              : 'text-white/50 hover:bg-white/10 hover:text-white/80'
                          }`}
                        >
                          {start}-{end}
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="flex-1 overflow-y-auto p-3">
                  <div className="grid grid-cols-5 gap-2">
                    {currentPageEpisodes.map(({ idx, label }) => (
                      <button
                        key={idx}
                        type="button"
                        onClick={() => handleSelectEpisode(idx)}
                        className={`rounded px-1 py-1.5 text-xs transition-colors ${
                          idx === currentEpisodeIndex
                            ? 'bg-green-500 font-medium text-white'
                            : 'bg-white/5 text-white/70 hover:bg-white/15'
                        }`}
                      >
                        {label.startsWith('第 ') && label.endsWith(' 集')
                          ? String(idx + 1).padStart(2, '0')
                          : label.slice(0, 6)}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="border-t border-white/5 px-3 py-2 text-center text-xs text-white/40">
                  共 {currentDetail.episodes.length} 集 · 当前第 {currentEpisodeIndex + 1} 集
                </div>
              </div>
            )}

            {rightTab === 'sources' && (
              <div className="flex-1 overflow-y-auto">
                {allSources.length === 0 ? (
                  <div className="p-4 text-center text-xs text-white/40">暂无其他源</div>
                ) : (
                  <div className="p-2">
                    {allSources.map((s) => {
                      const isActive = s.source === currentSource && s.id === currentId;
                      return (
                        <button
                          key={`${s.source}-${s.id}`}
                          type="button"
                          onClick={() => handleSwitchSource(s)}
                          className={`mb-1.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                            isActive
                              ? 'bg-green-500/10 text-green-400'
                              : 'bg-white/5 text-white/70 hover:bg-white/10'
                          }`}
                        >
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium">{s.source_name || s.source}</div>
                            <div className="mt-0.5 flex items-center gap-2 text-xs text-white/40">
                              {s.episodes?.length ? `${s.episodes.length} 集` : ''}
                              {s.weight !== undefined && s.weight > 0 && (
                                <span>权重 {s.weight}</span>
                              )}
                            </div>
                          </div>
                          {isActive && (
                            <span className="ml-2 text-xs text-green-400">当前</span>
                          )}
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default function TeslaPlayPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 flex items-center justify-center bg-neutral-950 text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <TeslaPlayPageInner />
    </Suspense>
  );
}
