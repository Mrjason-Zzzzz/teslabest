'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

import { ArrowLeft, ChevronLeft, ChevronRight, Heart, Star, ArrowUpDown, Loader2 } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import type { SearchResult } from '@/lib/types';

import PageLayout from '@/components/PageLayout';
import TeslaPlayer from '@/components/TeslaPlayer';
import { fetchTVDetail, resolveTVEpisodeUrl } from '@/components/tv/player/utils';

type LoadingStage = 'searching' | 'preferring' | 'fetching' | 'ready' | 'error';

const LOADING_STAGES = [
  { key: 'searching', label: '正在搜索播放源...' },
  { key: 'preferring', label: '正在优选最佳播放源...' },
  { key: 'fetching', label: '正在获取视频详情...' },
  { key: 'ready', label: '准备就绪，即将开始播放...' },
];

function normalizeTitle(title: string): string {
  return title
    .replace(/[\s\u3000]/g, '')
    .replace(/[()（）[\]【】{}「」『』<>《》]/g, '')
    .replace(/[^\w\u4e00-\u9fa5]/g, '')
    .toLowerCase();
}

function getVideoType(item: SearchResult): 'movie' | 'tv' {
  if (item.source === 'emby' || item.source?.startsWith('emby_') || item.source === 'openlist') {
    return item.type_name === '电影' ? 'movie' : 'tv';
  }
  const typeName = item.type_name?.toLowerCase() || '';
  if (typeName.includes('电影') || typeName.includes('movie')) return 'movie';
  return 'tv';
}

function filterSourcesForCurrentVideo(
  items: SearchResult[],
  currentTitle: string,
  currentYear: string,
  currentType?: string
): SearchResult[] {
  const normalizedCurrent = normalizeTitle(currentTitle);
  const currentVideoType = currentType === 'movie' ? 'movie' : 'tv';

  return items.filter((item) => {
    if (normalizeTitle(item.title) !== normalizedCurrent) return false;
    if (currentYear && /^\d{4}$/.test(currentYear)) {
      const itemYear = item.year || '';
      const yearMatch =
        itemYear === currentYear ||
        !itemYear ||
        itemYear.trim() === '' ||
        itemYear === 'unknown' ||
        !/^\d{4}$/.test(itemYear);
      if (!yearMatch) return false;
    }
    if (currentType) {
      const itemType = getVideoType(item);
      if (itemType !== currentVideoType) return false;
    }
    return true;
  });
}

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

  const [loadingStage, setLoadingStage] = useState<LoadingStage>('searching');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [allSources, setAllSources] = useState<SearchResult[]>([]);
  const [currentDetail, setCurrentDetail] = useState<SearchResult | null>(null);
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(initialEpisode);
  const [playUrl, setPlayUrl] = useState('');
  const [isAutoPlayingNext, setIsAutoPlayingNext] = useState(false);

  const [rightTab, setRightTab] = useState<'episodes' | 'sources'>('episodes');
  const [episodePage, setEpisodePage] = useState(0);
  const [episodeOrderAsc, setEpisodeOrderAsc] = useState(true);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const EPISODES_PER_PAGE = 50;

  const detailSeqRef = useRef(0);
  const searchSeqRef = useRef(0);

  const currentSource = currentDetail?.source || '';
  const currentId = currentDetail?.id || '';

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
        if (!initialTitle) throw new Error('缺少必要参数：title');

        const allResults = await searchSources(initialTitle);
        if (allResults.length === 0) throw new Error('未找到匹配的播放源');

        const stypeParam = stype || (year ? 'tv' : undefined);
        let filtered = filterSourcesForCurrentVideo(allResults, initialTitle, year, stypeParam);

        if (filtered.length === 0) {
          const normalizedCurrent = normalizeTitle(initialTitle);
          filtered = allResults.filter((s) => normalizeTitle(s.title) === normalizedCurrent);
        }

        if (filtered.length === 0 && source && id) {
          const current = allResults.find((s) => s.source === source && s.id === id);
          if (current) filtered = [current];
        }

        if (filtered.length === 0) {
          console.warn('[TeslaPlay] 未找到匹配的源，使用所有搜索结果');
          filtered = allResults;
        }

        setAllSources(filtered);

        let selected: SearchResult | null = null;
        if (source && id) {
          selected = filtered.find((s) => s.source === source && s.id === id) || null;
        }

        if (!selected) {
          if (filtered.length > 1) {
            setLoadingStage('preferring');
            await new Promise((r) => setTimeout(r, 500));
          }
          selected = preferBestSource(filtered);
        }

        if (!selected) throw new Error('未找到可用的播放源');

        setLoadingStage('fetching');
        const detail = await fetchDetail(selected.source, selected.id, initialTitle);

        if (cancelled) return;
        setCurrentDetail(detail);
        const epIdx = initialEpisode < (detail.episodes?.length || 0) ? initialEpisode : 0;
        setCurrentEpisodeIndex(epIdx);
        setLoadingStage('ready');
      } catch (e) {
        if (cancelled) return;
        console.error('[TeslaPlay] init error:', e);
        setErrorMsg(e instanceof Error ? e.message : '加载失败');
        setLoadingStage('error');
      }
    };
    init();
    return () => { cancelled = true; };
  }, [source, id, initialTitle, initialEpisode, year, stype, fetchDetail, searchSources, preferBestSource]);

  useEffect(() => {
    if (!currentDetail || !currentDetail.episodes || currentEpisodeIndex >= currentDetail.episodes.length) {
      setPlayUrl('');
      return;
    }
    let disposed = false;
    const rawUrl = currentDetail.episodes[currentEpisodeIndex];
    resolveTVEpisodeUrl(rawUrl, currentDetail.source, currentDetail.proxyMode)
      .then((u) => { if (!disposed) { setPlayUrl(u); setIsAutoPlayingNext(false); } })
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
    const nextIndex = episodeOrderAsc ? currentEpisodeIndex + 1 : currentEpisodeIndex - 1;
    const episodes = currentDetail.episodes;
    if (nextIndex >= 0 && nextIndex < episodes.length) {
      setIsAutoPlayingNext(true);
      setTimeout(() => {
        setCurrentEpisodeIndex(nextIndex);
        const params = new URLSearchParams(window.location.search);
        params.set('episode', String(nextIndex + 1));
        window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
      }, 1500);
    }
  }, [currentDetail, currentEpisodeIndex, episodeOrderAsc]);

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
    const episodes = currentDetail.episodes;
    const titles = currentDetail.episodes_titles || [];
    const total = episodes.length;
    const start = episodePage * EPISODES_PER_PAGE;
    const end = Math.min(start + EPISODES_PER_PAGE, total);
    const result: { idx: number; label: string }[] = [];
    for (let i = start; i < end; i++) {
      const realIndex = episodeOrderAsc ? i : total - 1 - i;
      const label = titles[realIndex] || `第 ${realIndex + 1} 集`;
      result.push({ idx: realIndex, label });
    }
    return result;
  }, [currentDetail, episodePage, episodeOrderAsc]);

  const isLoading = !currentDetail || !playUrl;
  const currentStageIndex = LOADING_STAGES.findIndex((s) => s.key === loadingStage);
  const progressPercent = currentStageIndex < 0 ? 0 : ((currentStageIndex + 1) / LOADING_STAGES.length) * 100;

  return (
    <PageLayout activePath="/play">
      <div className="min-h-screen">
        {/* 面包屑标题 */}
        <div className="hidden px-4 pt-4 md:block">
          <div className="flex items-center gap-2 text-sm">
            <button
              type="button"
              onClick={() => router.back()}
              className="flex items-center gap-1 text-gray-500 transition-colors hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200"
            >
              <ArrowLeft className="h-4 w-4" />
              返回
            </button>
            <span className="text-gray-300">|</span>
            <span className="font-medium text-gray-800 dark:text-gray-100">{initialTitle}</span>
            {currentDetail && currentDetail.episodes?.length > 1 && (
              <>
                <span className="text-gray-400">›</span>
                <span className="text-green-600">{episodeTitle}</span>
              </>
            )}
            {currentDetail?.vod_remarks && (
              <span className="rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-900/30 dark:text-blue-400">
                {currentDetail.vod_remarks}
              </span>
            )}
          </div>
        </div>

        {/* 主体 */}
        <div className="mx-auto flex max-w-7xl gap-4 px-4 py-4">
          {/* 左侧：播放器 + 详情 */}
          <div className={`min-w-0 flex-1 transition-all duration-300 ${rightPanelCollapsed ? '' : ''}`}>
            {/* 播放器容器 */}
            <div className="relative aspect-video w-full overflow-hidden rounded-xl bg-black shadow-lg">
              {isLoading && loadingStage !== 'error' && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-white dark:bg-gray-900">
                  <Loader2 className="h-8 w-8 animate-spin text-green-500" />
                  <div className="w-56">
                    <div className="mb-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800">
                      <div
                        className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-500 transition-all duration-500"
                        style={{ width: `${progressPercent}%` }}
                      />
                    </div>
                  </div>
                  <p className="text-sm font-medium text-gray-600 dark:text-gray-300">
                    {currentStageIndex >= 0 ? LOADING_STAGES[currentStageIndex]?.label : '加载中...'}
                  </p>
                </div>
              )}

              {loadingStage === 'error' && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-gray-900">
                  <p className="text-red-500">{errorMsg}</p>
                  <div className="flex gap-2">
                    <button
                      type="button"
                      onClick={() => window.location.reload()}
                      className="rounded-lg bg-gray-100 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200"
                    >
                      重试
                    </button>
                    <button
                      type="button"
                      onClick={backToOriginal}
                      className="rounded-lg bg-green-500 px-4 py-1.5 text-sm text-white hover:bg-green-600"
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
                    onBackToOriginal={backToOriginal}
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
              <div className="mt-4 flex gap-4">
                {currentDetail.poster && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={currentDetail.poster}
                    alt={currentDetail.title}
                    className="h-36 w-24 flex-shrink-0 rounded-lg object-cover shadow-md"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex items-start justify-between">
                    <h1 className="text-xl font-bold text-gray-900 dark:text-gray-100">{currentDetail.title}</h1>
                    <button
                      type="button"
                      className="flex items-center gap-1 rounded-full bg-pink-50 px-3 py-1 text-xs text-pink-500 ring-1 ring-pink-200 transition-colors hover:bg-pink-100 dark:bg-pink-950/30 dark:text-pink-400 dark:ring-pink-800 dark:hover:bg-pink-900/30"
                    >
                      <Heart className="h-3.5 w-3.5" />
                      收藏
                    </button>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    {currentDetail.rating !== undefined && currentDetail.rating > 0 && (
                      <span className="flex items-center gap-0.5 text-yellow-500">
                        <Star className="h-3.5 w-3.5 fill-current" />
                        <span className="font-medium">{currentDetail.rating.toFixed(1)}</span>
                        <span className="text-gray-400">评价</span>
                      </span>
                    )}
                    {currentDetail.year && <span>· {currentDetail.year}</span>}
                    {currentDetail.type_name && <span>· {currentDetail.type_name}</span>}
                    {currentDetail.source_name && (
                      <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-800 dark:text-gray-400">
                        源：{currentDetail.source_name}
                      </span>
                    )}
                  </div>
                  {currentDetail.desc && (
                    <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300">
                      {currentDetail.desc}
                    </p>
                  )}
                </div>
              </div>
            )}
          </div>

          {/* 右侧面板（可折叠） */}
          {currentDetail && currentDetail.episodes && currentDetail.episodes.length > 0 && (
            <>
              <div
                className={`flex-shrink-0 transition-all duration-300 ${
                  rightPanelCollapsed ? 'w-0 overflow-hidden opacity-0' : 'w-72'
                }`}
              >
                <div className="overflow-hidden rounded-xl bg-white/80 shadow-sm ring-1 ring-gray-200/50 backdrop-blur dark:bg-gray-900/80 dark:ring-gray-700/50">
                  <div className="flex border-b border-gray-100 dark:border-gray-800">
                    <button
                      type="button"
                      onClick={() => setRightTab('episodes')}
                      className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                        rightTab === 'episodes'
                          ? 'border-b-2 border-green-500 text-green-600'
                          : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      }`}
                    >
                      选集
                    </button>
                    <button
                      type="button"
                      onClick={() => setRightTab('sources')}
                      className={`flex-1 py-2.5 text-sm font-medium transition-colors ${
                        rightTab === 'sources'
                          ? 'border-b-2 border-green-500 text-green-600'
                          : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                      }`}
                    >
                      换源
                    </button>
                  </div>

                  {rightTab === 'episodes' && (
                    <div className="flex flex-col overflow-hidden">
                      {totalPages > 1 && (
                        <div className="flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800">
                          <div className="flex flex-wrap gap-1">
                            {Array.from({ length: totalPages }, (_, i) => {
                              const start = episodeOrderAsc ? i * EPISODES_PER_PAGE + 1 : (totalPages - i - 1) * EPISODES_PER_PAGE + 1;
                              const end = episodeOrderAsc
                                ? Math.min((i + 1) * EPISODES_PER_PAGE, currentDetail.episodes!.length)
                                : Math.min(totalPages * EPISODES_PER_PAGE - i * EPISODES_PER_PAGE, currentDetail.episodes!.length);
                              return (
                                <button
                                  key={i}
                                  type="button"
                                  onClick={() => setEpisodePage(i)}
                                  className={`rounded px-2 py-0.5 text-xs transition-colors ${
                                    i === episodePage
                                      ? 'bg-green-500/10 text-green-600 dark:bg-green-500/20 dark:text-green-400'
                                      : 'text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-gray-800 dark:hover:text-gray-200'
                                  }`}
                                >
                                  {start}-{end}
                                </button>
                              );
                            })}
                          </div>
                          <button
                            type="button"
                            onClick={() => { setEpisodeOrderAsc(!episodeOrderAsc); setEpisodePage(0); }}
                            className="flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800"
                          >
                            <ArrowUpDown className="h-3 w-3" />
                            {episodeOrderAsc ? '倒序' : '正序'}
                          </button>
                        </div>
                      )}
                      <div className="max-h-[500px] overflow-y-auto p-3">
                        <div className="grid grid-cols-5 gap-2">
                          {currentPageEpisodes.map(({ idx, label }) => (
                            <button
                              key={idx}
                              type="button"
                              onClick={() => handleSelectEpisode(idx)}
                              className={`rounded px-1 py-1.5 text-xs transition-colors ${
                                idx === currentEpisodeIndex
                                  ? 'bg-green-500 font-medium text-white shadow-sm'
                                  : 'bg-gray-50 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
                              }`}
                            >
                              {label.startsWith('第 ') && label.endsWith(' 集')
                                ? String(idx + 1).padStart(2, '0')
                                : label.slice(0, 6)}
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="border-t border-gray-100 px-3 py-2 text-center text-xs text-gray-400 dark:border-gray-800 dark:text-gray-500">
                        共 {currentDetail.episodes.length} 集 · 当前第 {currentEpisodeIndex + 1} 集
                      </div>
                    </div>
                  )}

                  {rightTab === 'sources' && (
                    <div className="max-h-[500px] overflow-y-auto">
                      {allSources.length === 0 ? (
                        <div className="p-4 text-center text-xs text-gray-400">暂无其他源</div>
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
                                    ? 'bg-green-50 text-green-700 ring-1 ring-green-200 dark:bg-green-950/30 dark:text-green-400 dark:ring-green-800'
                                    : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800'
                                }`}
                              >
                                <div className="min-w-0 flex-1">
                                  <div className="truncate text-sm font-medium">{s.source_name || s.source}</div>
                                  <div className="mt-0.5 flex items-center gap-2 text-xs text-gray-400">
                                    {s.episodes?.length ? `${s.episodes.length} 集` : ''}
                                    {s.weight !== undefined && s.weight > 0 && <span>权重 {s.weight}</span>}
                                  </div>
                                </div>
                                {isActive && <span className="ml-2 text-xs text-green-600 dark:text-green-400">当前</span>}
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </div>

              {/* 折叠/展开按钮 */}
              <button
                type="button"
                onClick={() => setRightPanelCollapsed(!rightPanelCollapsed)}
                className="sticky top-4 h-8 w-5 flex-shrink-0 self-start rounded-l-md bg-white/80 shadow-sm ring-1 ring-gray-200/50 backdrop-blur transition-colors hover:bg-gray-50 dark:bg-gray-900/80 dark:ring-gray-700/50 dark:hover:bg-gray-800"
                title={rightPanelCollapsed ? '展开侧栏' : '收起侧栏'}
              >
                {rightPanelCollapsed ? (
                  <ChevronLeft className="mx-auto h-4 w-4 text-gray-500 dark:text-gray-400" />
                ) : (
                  <ChevronRight className="mx-auto h-4 w-4 text-gray-500 dark:text-gray-400" />
                )}
              </button>
            </>
          )}
        </div>
      </div>
    </PageLayout>
  );
}

export default function TeslaPlayPage() {
  return (
    <Suspense
      fallback={
        <div className="flex min-h-screen items-center justify-center">
          <Loader2 className="h-6 w-6 animate-spin text-green-500" />
        </div>
      }
    >
      <TeslaPlayPageInner />
    </Suspense>
  );
}
