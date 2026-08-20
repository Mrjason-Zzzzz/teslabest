'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console */

import {
  ChevronLeft,
  ChevronRight,
  Heart,
  Star,
  ArrowUpDown,
  Loader2,
} from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  generateStorageKey,
  getAllPlayRecords,
  savePlayRecord,
} from '@/lib/db.client';
import {
  buildEpisodeProgressContentKey,
  loadLocalEpisodeProgress,
  saveLocalEpisodeProgress,
} from '@/lib/episode-progress';
import type { SearchResult } from '@/lib/types';

import PageLayout from '@/components/PageLayout';
import TeslaPlayer from '@/components/TeslaPlayer';
import {
  fetchTVDetail,
  resolveTVEpisodeUrl,
} from '@/components/tv/player/utils';
import {
  getTeslaSourceKey,
  getTeslaSourceScore,
  markTeslaSourceFailure,
  markTeslaSourceReady,
  rankTeslaSources,
} from '@/lib/tesla/source-health';

type LoadingStage = 'searching' | 'preferring' | 'fetching' | 'ready' | 'error';

const LOADING_STAGES = [
  { key: 'searching', label: '正在搜索播放源...' },
  { key: 'preferring', label: '正在优选最佳播放源...' },
  { key: 'fetching', label: '正在获取视频详情...' },
  { key: 'ready', label: '准备就绪，即将开始播放...' },
];

function formatResumeTime(seconds: number): string {
  const safe = Math.max(0, Math.floor(seconds));
  const hours = Math.floor(safe / 3600);
  const minutes = Math.floor((safe % 3600) / 60);
  const secs = safe % 60;
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(
        2,
        '0'
      )}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function normalizeTitle(title: string): string {
  return title
    .replace(/[\s\u3000]/g, '')
    .replace(/[()（）[\]【】{}「」『』<>《》]/g, '')
    .replace(/[^\w\u4e00-\u9fa5]/g, '')
    .toLowerCase();
}

function getVideoType(item: SearchResult): 'movie' | 'tv' {
  if (
    item.source === 'emby' ||
    item.source?.startsWith('emby_') ||
    item.source === 'openlist'
  ) {
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
  const initialEpisode = episodeParam
    ? Math.max(0, parseInt(episodeParam, 10) - 1)
    : 0;

  const [loadingStage, setLoadingStage] = useState<LoadingStage>('searching');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const [allSources, setAllSources] = useState<SearchResult[]>([]);
  const [currentDetail, setCurrentDetail] = useState<SearchResult | null>(null);
  const [sourceNotice, setSourceNotice] = useState('');
  const [currentEpisodeIndex, setCurrentEpisodeIndex] =
    useState(initialEpisode);
  const [playUrl, setPlayUrl] = useState('');
  const [resumeTime, setResumeTime] = useState(0);
  const [isAutoPlayingNext, setIsAutoPlayingNext] = useState(false);
  const [autoPlayEnabled, setAutoPlayEnabled] = useState(true);

  const [rightTab, setRightTab] = useState<'episodes' | 'sources'>('episodes');
  const [episodePage, setEpisodePage] = useState(0);
  const [episodeOrderAsc, setEpisodeOrderAsc] = useState(true);
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);
  const EPISODES_PER_PAGE = 50;

  const detailSeqRef = useRef(0);
  const searchSeqRef = useRef(0);
  const triedSourceKeysRef = useRef(new Set<string>());
  const playbackLoadStartedRef = useRef(performance.now());
  const resumeLookupSeqRef = useRef(0);
  const lastSavedProgressRef = useRef('');

  useEffect(() => {
    try {
      setAutoPlayEnabled(
        localStorage.getItem('tesla_vod_autoplay') !== 'disabled'
      );
    } catch {
      setAutoPlayEnabled(true);
    }
  }, []);

  useEffect(() => {
    try {
      localStorage.setItem(
        'tesla_vod_autoplay',
        autoPlayEnabled ? 'enabled' : 'disabled'
      );
    } catch {
      // Playback preferences are best-effort in private browsing.
    }
  }, [autoPlayEnabled]);

  const currentSource = currentDetail?.source || '';
  const currentId = currentDetail?.id || '';

  const episodeProgressContentKey = useMemo(
    () =>
      buildEpisodeProgressContentKey({
        doubanId: currentDetail?.douban_id,
        tmdbId: currentDetail?.tmdb_id,
        title: initialTitle || currentDetail?.title || '',
        year: year || currentDetail?.year,
        searchType: stype,
      }),
    [
      currentDetail?.douban_id,
      currentDetail?.tmdb_id,
      currentDetail?.title,
      currentDetail?.year,
      initialTitle,
      stype,
      year,
    ]
  );

  const getEpisodeResumeTime = useCallback(
    (episodeIndex: number) => {
      return (
        loadLocalEpisodeProgress(episodeProgressContentKey, episodeIndex) || 0
      );
    },
    [episodeProgressContentKey]
  );

  const searchSources = useCallback(
    async (query: string, background = false): Promise<SearchResult[]> => {
      if (!query) return [];
      const seq = ++searchSeqRef.current;
      if (!background) setLoadingStage('searching');
      try {
        const res = await fetch(
          `/api/search?q=${encodeURIComponent(query.trim())}`
        );
        if (!res.ok) throw new Error('搜索失败');
        const data = await res.json();
        if (seq !== searchSeqRef.current) return [];
        return (data.results || []) as SearchResult[];
      } catch (e) {
        if (seq !== searchSeqRef.current) return [];
        console.error('[TeslaPlay] search error:', e);
        throw e;
      }
    },
    []
  );

  const preferBestSource = useCallback(
    (sources: SearchResult[]): SearchResult => {
      return rankTeslaSources(sources)[0];
    },
    []
  );

  const fetchDetail = useCallback(
    async (src: string, vid: string, title: string): Promise<SearchResult> => {
      const seq = ++detailSeqRef.current;
      const { detail } = await fetchTVDetail({
        source: src || null,
        id: vid || null,
        title: title || null,
      });
      if (seq !== detailSeqRef.current) throw new Error('stale');
      return detail;
    },
    []
  );

  useEffect(() => {
    let cancelled = false;

    const filterSearchResults = (
      allResults: SearchResult[],
      active?: SearchResult
    ) => {
      const stypeParam = stype || (year ? 'tv' : undefined);
      let filtered = filterSourcesForCurrentVideo(
        allResults,
        initialTitle,
        year,
        stypeParam
      );

      if (filtered.length === 0) {
        const normalizedCurrent = normalizeTitle(initialTitle);
        filtered = allResults.filter(
          (item) => normalizeTitle(item.title) === normalizedCurrent
        );
      }

      if (filtered.length === 0 && source && id) {
        const current = allResults.find(
          (item) => item.source === source && item.id === id
        );
        if (current) filtered = [current];
      }

      if (filtered.length === 0) filtered = allResults;
      if (
        active &&
        !filtered.some(
          (item) => item.source === active.source && item.id === active.id
        )
      ) {
        filtered = [active, ...filtered];
      }
      return filtered;
    };

    const loadCandidatesInBackground = (active: SearchResult) => {
      searchSources(initialTitle, true)
        .then((results) => {
          if (cancelled || results.length === 0) return;
          setAllSources(filterSearchResults(results, active));
        })
        .catch((error) => {
          console.warn('[TeslaPlay] background source search failed:', error);
        });
    };

    const init = async () => {
      setErrorMsg(null);
      try {
        if (!initialTitle) throw new Error('缺少必要参数：title');

        // Fast path: the search result already supplied an exact source and id.
        // Start fetching its detail immediately; candidate discovery must never
        // let the slowest downstream source block first playback.
        if (source && id) {
          try {
            setLoadingStage('fetching');
            const directDetail = await fetchDetail(source, id, initialTitle);
            if (cancelled) return;
            setCurrentDetail(directDetail);
            setAllSources([directDetail]);
            const directEpisode =
              initialEpisode < (directDetail.episodes?.length || 0)
                ? initialEpisode
                : 0;
            setCurrentEpisodeIndex(directEpisode);
            setLoadingStage('ready');
            loadCandidatesInBackground(directDetail);
            return;
          } catch (directError) {
            console.warn(
              '[TeslaPlay] direct detail failed, falling back to source search:',
              directError
            );
          }
        }

        const allResults = await searchSources(initialTitle);
        if (allResults.length === 0) throw new Error('未找到匹配的播放源');
        const filtered = filterSearchResults(allResults);
        setAllSources(filtered);

        const requestedSource =
          source && id
            ? filtered.find(
                (item) => item.source === source && item.id === id
              ) || null
            : null;

        if (filtered.length > 1) setLoadingStage('preferring');
        const preferredSource = preferBestSource(filtered);
        let selected: SearchResult | null = preferredSource || requestedSource;

        if (requestedSource && preferredSource) {
          const requestedScore = getTeslaSourceScore(requestedSource);
          const preferredScore = getTeslaSourceScore(preferredSource);
          selected =
            preferredScore > requestedScore + 5
              ? preferredSource
              : requestedSource;
          if (selected !== requestedSource) {
            setSourceNotice(
              `已优选更稳定的资源：${selected.source_name || selected.source}`
            );
          }
        }

        if (!selected) throw new Error('未找到可用的播放源');
        setLoadingStage('fetching');
        const detail = await fetchDetail(
          selected.source,
          selected.id,
          initialTitle
        );

        if (cancelled) return;
        setCurrentDetail(detail);
        const epIdx =
          initialEpisode < (detail.episodes?.length || 0) ? initialEpisode : 0;
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
    return () => {
      cancelled = true;
    };
  }, [
    source,
    id,
    initialTitle,
    initialEpisode,
    year,
    stype,
    fetchDetail,
    searchSources,
    preferBestSource,
  ]);

  useEffect(() => {
    if (!currentDetail?.episodes?.length) {
      setResumeTime(0);
      return;
    }

    const seq = ++resumeLookupSeqRef.current;
    const explicitEpisode = episodeParam !== null;
    const requestedIndex = Math.min(
      Math.max(0, explicitEpisode ? initialEpisode : currentEpisodeIndex),
      currentDetail.episodes.length - 1
    );
    setResumeTime(getEpisodeResumeTime(requestedIndex));

    getAllPlayRecords()
      .then((records) => {
        if (seq !== resumeLookupSeqRef.current) return;
        const record =
          records[generateStorageKey(currentDetail.source, currentDetail.id)];
        let targetIndex = requestedIndex;
        let targetTime = getEpisodeResumeTime(targetIndex);

        if (record) {
          const recordIndex = Math.min(
            Math.max(0, (record.index || 1) - 1),
            currentDetail.episodes!.length - 1
          );
          if (!explicitEpisode) {
            targetIndex = recordIndex;
            targetTime = Math.max(
              record.play_time || 0,
              getEpisodeResumeTime(recordIndex)
            );
          } else if (recordIndex === targetIndex) {
            targetTime = Math.max(targetTime, record.play_time || 0);
          }
        }

        if (targetIndex !== currentEpisodeIndex) {
          setCurrentEpisodeIndex(targetIndex);
          const params = new URLSearchParams(window.location.search);
          params.set('episode', String(targetIndex + 1));
          window.history.replaceState(
            null,
            '',
            `${window.location.pathname}?${params.toString()}`
          );
        }
        setResumeTime(targetTime);
        if (targetTime > 10) {
          setSourceNotice(
            `继续播放：第 ${targetIndex + 1} 集 · ${formatResumeTime(
              targetTime
            )}`
          );
          window.setTimeout(() => setSourceNotice(''), 4500);
        }
      })
      .catch((error) => {
        console.warn(
          '[TeslaPlay] load play record failed, using local episode progress:',
          error
        );
      });
  }, [
    currentDetail?.source,
    currentDetail?.id,
    episodeParam,
    getEpisodeResumeTime,
    initialEpisode,
  ]);

  useEffect(() => {
    if (
      !currentDetail ||
      !currentDetail.episodes ||
      currentEpisodeIndex >= currentDetail.episodes.length
    ) {
      setPlayUrl('');
      return;
    }
    let disposed = false;
    const rawUrl = currentDetail.episodes[currentEpisodeIndex];
    resolveTVEpisodeUrl(rawUrl, currentDetail.source, currentDetail.proxyMode)
      .then((u) => {
        if (!disposed) {
          setPlayUrl(u);
          setIsAutoPlayingNext(false);
        }
      })
      .catch((err) => {
        if (disposed) return;
        console.error(
          '[TeslaPlay] resolve episode url failed, fallback to raw',
          err
        );
        setPlayUrl(rawUrl);
        setIsAutoPlayingNext(false);
      });
    return () => {
      disposed = true;
    };
  }, [currentDetail, currentEpisodeIndex]);

  useEffect(() => {
    if (!playUrl || !currentDetail) return;
    playbackLoadStartedRef.current = performance.now();
    triedSourceKeysRef.current.add(getTeslaSourceKey(currentDetail));
  }, [playUrl, currentDetail]);

  const switchEpisode = useCallback(
    (index: number) => {
      if (!currentDetail?.episodes?.length) return;
      const boundedIndex = Math.max(
        0,
        Math.min(index, currentDetail.episodes.length - 1)
      );
      setResumeTime(getEpisodeResumeTime(boundedIndex));
      setCurrentEpisodeIndex(boundedIndex);
      const params = new URLSearchParams(window.location.search);
      params.set('episode', String(boundedIndex + 1));
      params.set('source', currentDetail.source);
      params.set('id', currentDetail.id);
      window.history.replaceState(
        null,
        '',
        `${window.location.pathname}?${params.toString()}`
      );
    },
    [currentDetail, getEpisodeResumeTime]
  );

  const handlePlayEnded = useCallback(() => {
    if (!currentDetail?.episodes?.length) return;
    if (!autoPlayEnabled) {
      setSourceNotice('本集已播放完毕，自动连播已关闭');
      return;
    }
    // 排序只影响选集展示，剧情顺序始终按真实集数向后播放。
    const nextIndex = currentEpisodeIndex + 1;
    if (nextIndex >= currentDetail.episodes.length) {
      setSourceNotice('本剧集已播放完毕');
      return;
    }

    setIsAutoPlayingNext(true);
    window.setTimeout(() => {
      switchEpisode(nextIndex);
    }, 1000);
  }, [autoPlayEnabled, currentDetail, currentEpisodeIndex, switchEpisode]);

  const handleSelectEpisode = useCallback(
    (index: number) => {
      setIsAutoPlayingNext(false);
      switchEpisode(index);
    },
    [switchEpisode]
  );

  const handlePreviousEpisode = useCallback(() => {
    if (currentEpisodeIndex > 0) switchEpisode(currentEpisodeIndex - 1);
  }, [currentEpisodeIndex, switchEpisode]);

  const handleNextEpisode = useCallback(() => {
    if (
      currentDetail?.episodes?.length &&
      currentEpisodeIndex < currentDetail.episodes.length - 1
    ) {
      switchEpisode(currentEpisodeIndex + 1);
    }
  }, [currentDetail, currentEpisodeIndex, switchEpisode]);

  const handleSwitchSource = useCallback(
    async (src: SearchResult, notice?: string) => {
      if (src.source === currentSource && src.id === currentId) return;
      setLoadingStage('fetching');
      setErrorMsg(null);
      if (notice) setSourceNotice(notice);
      try {
        const detail = await fetchDetail(src.source, src.id, initialTitle);
        setCurrentDetail(detail);
        const episodeCount = detail.episodes?.length || 0;
        const epIdx =
          episodeCount > 0
            ? Math.min(currentEpisodeIndex, episodeCount - 1)
            : 0;
        setCurrentEpisodeIndex(epIdx);
        const params = new URLSearchParams(window.location.search);
        params.set('source', detail.source);
        params.set('id', detail.id);
        params.set('episode', String(epIdx + 1));
        window.history.replaceState(
          null,
          '',
          `${window.location.pathname}?${params.toString()}`
        );
        setLoadingStage('ready');
      } catch (e) {
        console.error('[TeslaPlay] switch source error:', e);
        setErrorMsg(e instanceof Error ? e.message : '切换源失败');
        setLoadingStage('error');
      }
    },
    [currentSource, currentId, fetchDetail, initialTitle, currentEpisodeIndex]
  );

  const rankedSources = useMemo(
    () => rankTeslaSources(allSources),
    [allSources, currentDetail]
  );
  const recommendedSource = rankedSources[0] || null;
  const originalSource = useMemo(
    () =>
      allSources.find((item) => item.source === source && item.id === id) ||
      null,
    [allSources, source, id]
  );

  const handlePlaybackReady = useCallback(() => {
    if (!currentDetail) return;
    const startMs = Math.max(
      0,
      performance.now() - playbackLoadStartedRef.current
    );
    markTeslaSourceReady(currentDetail, startMs);
    setSourceNotice(
      (previous) =>
        previous ||
        `已连接：${currentDetail.source_name || currentDetail.source}`
    );
    window.setTimeout(() => setSourceNotice(''), 3000);
  }, [currentDetail]);

  const handlePlaybackError = useCallback(
    (message: string) => {
      if (!currentDetail) return;
      markTeslaSourceFailure(
        currentDetail,
        message.includes('缓冲') || message.includes('卡顿')
      );
      const failedKey = getTeslaSourceKey(currentDetail);
      triedSourceKeysRef.current.add(failedKey);
      const next = rankTeslaSources(allSources).find(
        (item) => !triedSourceKeysRef.current.has(getTeslaSourceKey(item))
      );
      if (next) {
        handleSwitchSource(
          next,
          `当前源异常，自动切换到 ${next.source_name || next.source}`
        );
      } else {
        setSourceNotice(
          '当前影片的候选资源均已尝试，可手动恢复原源或返回原版播放器'
        );
      }
    },
    [allSources, currentDetail, handleSwitchSource]
  );

  const handleSelectRecommended = useCallback(() => {
    if (!recommendedSource) return;
    if (
      recommendedSource.source === currentSource &&
      recommendedSource.id === currentId
    ) {
      setSourceNotice('当前已经是综合评分最高的资源');
      return;
    }
    handleSwitchSource(
      recommendedSource,
      `正在切换到推荐源：${
        recommendedSource.source_name || recommendedSource.source
      }`
    );
  }, [recommendedSource, currentSource, currentId, handleSwitchSource]);

  const handleRestoreOriginalSource = useCallback(() => {
    if (!originalSource) {
      setSourceNotice('原始资源已不在当前候选列表');
      return;
    }
    triedSourceKeysRef.current.clear();
    handleSwitchSource(
      originalSource,
      `已恢复原资源：${originalSource.source_name || originalSource.source}`
    );
  }, [originalSource, handleSwitchSource]);

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

  const handlePlaybackProgress = useCallback(
    (time: number, total: number) => {
      if (
        !currentDetail ||
        !episodeProgressContentKey ||
        time < 1 ||
        total <= 0
      )
        return;
      const playTime = Math.floor(time);
      const totalTime = Math.floor(total);
      const saveIdentity = `${currentDetail.source}|${currentDetail.id}|${currentEpisodeIndex}|${playTime}`;
      if (lastSavedProgressRef.current === saveIdentity) return;
      lastSavedProgressRef.current = saveIdentity;

      try {
        saveLocalEpisodeProgress(
          episodeProgressContentKey,
          currentEpisodeIndex,
          time,
          total
        );
      } catch (error) {
        console.warn('[TeslaPlay] save local episode progress failed:', error);
      }

      void savePlayRecord(currentDetail.source, currentDetail.id, {
        title: currentDetail.title || initialTitle,
        source_name: currentDetail.source_name || currentDetail.source,
        year: String(currentDetail.year || year || ''),
        cover: currentDetail.poster || '',
        index: currentEpisodeIndex + 1,
        total_episodes: currentDetail.episodes?.length || 1,
        play_time: playTime,
        total_time: totalTime,
        save_time: Date.now(),
        search_title: initialTitle || currentDetail.title,
        origin: 'vod',
      }).catch((error) => {
        console.warn('[TeslaPlay] save unified play record failed:', error);
      });
    },
    [
      currentDetail,
      currentEpisodeIndex,
      episodeProgressContentKey,
      initialTitle,
      year,
    ]
  );

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
  const currentStageIndex = LOADING_STAGES.findIndex(
    (s) => s.key === loadingStage
  );
  const progressPercent =
    currentStageIndex < 0
      ? 0
      : ((currentStageIndex + 1) / LOADING_STAGES.length) * 100;

  return (
    <PageLayout activePath='/play'>
      <div className='min-h-screen'>
        {/* 面包屑标题 */}
        <div className='hidden px-4 pt-4 md:block'>
          <div className='flex items-center gap-2 text-sm pl-12'>
            <span className='font-medium text-gray-800 dark:text-gray-100'>
              {initialTitle}
            </span>
            {currentDetail && currentDetail.episodes?.length > 1 && (
              <>
                <span className='text-gray-400'>›</span>
                <span className='text-green-600'>{episodeTitle}</span>
              </>
            )}
            {currentDetail?.vod_remarks && (
              <span className='rounded bg-blue-100 px-1.5 py-0.5 text-xs text-blue-600 dark:bg-blue-900/30 dark:text-blue-400'>
                {currentDetail.vod_remarks}
              </span>
            )}
          </div>
        </div>

        {/* 主体 */}
        <div className='mx-auto max-w-[1600px] px-3 pb-6 pt-2 sm:px-4'>
          <div
            className={`grid items-start gap-4 transition-all duration-300 ease-in-out ${
              rightPanelCollapsed
                ? 'grid-cols-1'
                : 'grid-cols-1 lg:grid-cols-[minmax(0,1fr)_360px]'
            }`}
          >
            {/* 左侧：播放器 + 详情 */}
            <div className='min-w-0 rounded-xl border border-white/0 transition-all duration-300 ease-in-out dark:border-white/30'>
              {/* 播放器容器 */}
              <div className='relative mt-2 aspect-video w-full min-h-[220px] max-h-[78vh]'>
                <div className='h-full w-full overflow-hidden rounded-xl bg-black shadow-lg'>
                  {isLoading && loadingStage !== 'error' && (
                    <div className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-4 bg-white dark:bg-gray-900'>
                      <Loader2 className='h-8 w-8 animate-spin text-green-500' />
                      <div className='w-56'>
                        <div className='mb-2 h-1.5 overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800'>
                          <div
                            className='h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-500 transition-all duration-500'
                            style={{ width: `${progressPercent}%` }}
                          />
                        </div>
                      </div>
                      <p className='text-sm font-medium text-gray-600 dark:text-gray-300'>
                        {currentStageIndex >= 0
                          ? LOADING_STAGES[currentStageIndex]?.label
                          : '加载中...'}
                      </p>
                    </div>
                  )}

                  {loadingStage === 'error' && (
                    <div className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-white px-6 text-center dark:bg-gray-900'>
                      <p className='text-red-500'>{errorMsg}</p>
                      <div className='flex gap-2'>
                        <button
                          type='button'
                          onClick={() => window.location.reload()}
                          className='rounded-lg bg-gray-100 px-4 py-1.5 text-sm text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200'
                        >
                          重试
                        </button>
                        <button
                          type='button'
                          onClick={backToOriginal}
                          className='rounded-lg bg-green-500 px-4 py-1.5 text-sm text-white hover:bg-green-600'
                        >
                          返回原版
                        </button>
                      </div>
                    </div>
                  )}

                  {!isLoading &&
                    loadingStage !== 'error' &&
                    playUrl &&
                    currentDetail && (
                      <>
                        <TeslaPlayer
                          key={`${currentDetail.source}-${currentEpisodeIndex}`}
                          url={playUrl}
                          title={fullTitle}
                          poster={currentDetail.poster}
                          live={false}
                          sourceKey={currentDetail.source}
                          onEnded={handlePlayEnded}
                          onPrevious={
                            currentEpisodeIndex > 0
                              ? handlePreviousEpisode
                              : undefined
                          }
                          onNext={
                            currentEpisodeIndex <
                            currentDetail.episodes.length - 1
                              ? handleNextEpisode
                              : undefined
                          }
                          onBackToOriginal={backToOriginal}
                          playRecordKey={playRecordKey}
                          initialTime={resumeTime}
                          onProgress={handlePlaybackProgress}
                          onPlaybackReady={handlePlaybackReady}
                          onPlaybackError={handlePlaybackError}
                          danmakuTitle={
                            initialTitle || currentDetail.title || ''
                          }
                          danmakuYear={String(year || currentDetail.year || '')}
                          danmakuEpisodeNumber={currentEpisodeIndex + 1}
                          danmakuEpisodeLabel={episodeTitle}
                          danmakuMediaType={getVideoType(currentDetail)}
                          danmakuTotalEpisodes={
                            currentDetail.episodes?.length || 1
                          }
                        />
                        {sourceNotice && (
                          <div className='absolute inset-x-0 top-4 z-20 flex justify-center px-4 pointer-events-none'>
                            <div className='max-w-[90%] rounded-full bg-black/80 px-4 py-2 text-center text-xs text-white shadow-lg backdrop-blur'>
                              {sourceNotice}
                            </div>
                          </div>
                        )}
                        {isAutoPlayingNext && (
                          <div className='absolute inset-x-0 bottom-20 z-10 flex justify-center'>
                            <div className='rounded-full bg-black/80 px-4 py-2 backdrop-blur'>
                              <span className='text-sm text-white/80'>
                                播放完毕，正在跳转下一集…
                              </span>
                            </div>
                          </div>
                        )}
                      </>
                    )}
                </div>
              </div>

              {/* 视频详情 */}
              {currentDetail && (
                <div className='mt-4 flex gap-4'>
                  {currentDetail.poster && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={currentDetail.poster}
                      alt={currentDetail.title}
                      className='h-36 w-24 flex-shrink-0 rounded-lg object-cover shadow-md'
                    />
                  )}
                  <div className='min-w-0 flex-1'>
                    <div className='flex items-start justify-between'>
                      <h1 className='text-xl font-bold text-gray-900 dark:text-gray-100'>
                        {currentDetail.title}
                      </h1>
                      <button
                        type='button'
                        className='flex items-center gap-1 rounded-full bg-pink-50 px-3 py-1 text-xs text-pink-500 ring-1 ring-pink-200 transition-colors hover:bg-pink-100 dark:bg-pink-950/30 dark:text-pink-400 dark:ring-pink-800 dark:hover:bg-pink-900/30'
                      >
                        <Heart className='h-3.5 w-3.5' />
                        收藏
                      </button>
                    </div>
                    <div className='mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500 dark:text-gray-400'>
                      {currentDetail.rating !== undefined &&
                        currentDetail.rating > 0 && (
                          <span className='flex items-center gap-0.5 text-yellow-500'>
                            <Star className='h-3.5 w-3.5 fill-current' />
                            <span className='font-medium'>
                              {currentDetail.rating.toFixed(1)}
                            </span>
                            <span className='text-gray-400'>评价</span>
                          </span>
                        )}
                      {currentDetail.year && (
                        <span>· {currentDetail.year}</span>
                      )}
                      {currentDetail.type_name && (
                        <span>· {currentDetail.type_name}</span>
                      )}
                      {currentDetail.source_name && (
                        <span className='rounded bg-gray-100 px-1.5 py-0.5 text-gray-500 dark:bg-gray-800 dark:text-gray-400'>
                          源：{currentDetail.source_name}
                        </span>
                      )}
                    </div>
                    {currentDetail.desc && (
                      <p className='mt-3 line-clamp-3 text-sm leading-relaxed text-gray-600 dark:text-gray-300'>
                        {currentDetail.desc}
                      </p>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* 右侧面板（可折叠） */}
            {currentDetail &&
              currentDetail.episodes &&
              currentDetail.episodes.length > 0 &&
              !rightPanelCollapsed && (
                <div className='min-w-0 lg:sticky lg:top-4'>
                  <div className='overflow-hidden rounded-xl bg-white/80 shadow-sm ring-1 ring-gray-200/50 backdrop-blur dark:bg-gray-900/80 dark:ring-gray-700/50'>
                    <div className='flex border-b border-gray-100 dark:border-gray-800'>
                      <button
                        type='button'
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
                        type='button'
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
                      <div className='flex flex-col overflow-hidden'>
                        <div className='flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800'>
                          <span className='text-xs text-gray-500 dark:text-gray-400'>
                            播放完自动进入下一集
                          </span>
                          <button
                            type='button'
                            role='switch'
                            aria-checked={autoPlayEnabled}
                            onClick={() =>
                              setAutoPlayEnabled((enabled) => !enabled)
                            }
                            className={`relative h-6 w-11 rounded-full transition-colors ${
                              autoPlayEnabled
                                ? 'bg-green-500'
                                : 'bg-gray-300 dark:bg-gray-700'
                            }`}
                          >
                            <span
                              className={`absolute top-0.5 h-5 w-5 rounded-full bg-white shadow transition-transform ${
                                autoPlayEnabled
                                  ? 'translate-x-5'
                                  : 'translate-x-0.5'
                              }`}
                            />
                          </button>
                        </div>
                        {totalPages > 1 && (
                          <div className='flex items-center justify-between border-b border-gray-100 px-3 py-2 dark:border-gray-800'>
                            <div className='flex flex-wrap gap-1'>
                              {Array.from({ length: totalPages }, (_, i) => {
                                const start = episodeOrderAsc
                                  ? i * EPISODES_PER_PAGE + 1
                                  : (totalPages - i - 1) * EPISODES_PER_PAGE +
                                    1;
                                const end = episodeOrderAsc
                                  ? Math.min(
                                      (i + 1) * EPISODES_PER_PAGE,
                                      currentDetail.episodes!.length
                                    )
                                  : Math.min(
                                      totalPages * EPISODES_PER_PAGE -
                                        i * EPISODES_PER_PAGE,
                                      currentDetail.episodes!.length
                                    );
                                return (
                                  <button
                                    key={i}
                                    type='button'
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
                              type='button'
                              onClick={() => {
                                setEpisodeOrderAsc(!episodeOrderAsc);
                                setEpisodePage(0);
                              }}
                              className='flex items-center gap-1 rounded px-2 py-0.5 text-xs text-gray-500 transition-colors hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-gray-800'
                            >
                              <ArrowUpDown className='h-3 w-3' />
                              {episodeOrderAsc ? '倒序' : '正序'}
                            </button>
                          </div>
                        )}
                        <div className='max-h-[500px] overflow-y-auto p-3'>
                          <div className='grid grid-cols-1 gap-2 xl:grid-cols-2'>
                            {currentPageEpisodes.map(({ idx, label }) => (
                              <button
                                key={idx}
                                type='button'
                                onClick={() => handleSelectEpisode(idx)}
                                className={`rounded px-2.5 py-2 text-xs transition-colors ${
                                  idx === currentEpisodeIndex
                                    ? 'bg-green-500 font-medium text-white shadow-sm'
                                    : 'bg-gray-50 text-gray-700 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-200 dark:hover:bg-gray-700'
                                }`}
                              >
                                <span
                                  className='block min-h-[2.5rem] break-words text-left leading-5'
                                  title={label}
                                >
                                  {label.startsWith('第 ') &&
                                  label.endsWith(' 集')
                                    ? `第 ${String(idx + 1).padStart(
                                        2,
                                        '0'
                                      )} 集`
                                    : label}
                                </span>
                              </button>
                            ))}
                          </div>
                        </div>
                        <div className='border-t border-gray-100 px-3 py-2 text-center text-xs text-gray-400 dark:border-gray-800 dark:text-gray-500'>
                          共 {currentDetail.episodes.length} 集 · 当前第{' '}
                          {currentEpisodeIndex + 1} 集
                        </div>
                      </div>
                    )}

                    {rightTab === 'sources' && (
                      <div className='max-h-[500px] overflow-y-auto'>
                        {allSources.length === 0 ? (
                          <div className='p-4 text-center text-xs text-gray-400'>
                            暂无其他源
                          </div>
                        ) : (
                          <div className='p-2'>
                            <div className='mb-3 grid grid-cols-2 gap-2'>
                              <button
                                type='button'
                                onClick={handleSelectRecommended}
                                className='rounded-lg bg-green-500 px-3 py-2 text-xs font-medium text-white hover:bg-green-600'
                              >
                                优选推荐源
                              </button>
                              <button
                                type='button'
                                onClick={handleRestoreOriginalSource}
                                className='rounded-lg bg-gray-100 px-3 py-2 text-xs text-gray-700 hover:bg-gray-200 dark:bg-gray-800 dark:text-gray-200'
                              >
                                恢复原资源
                              </button>
                            </div>
                            <div className='mb-2 px-1 text-xs text-gray-500'>
                              共 {allSources.length} 个源 ·
                              按实际成功率与启动速度排序
                            </div>
                            {allSources.map((s) => {
                              const isActive =
                                s.source === currentSource &&
                                s.id === currentId;
                              return (
                                <button
                                  key={`${s.source}-${s.id}`}
                                  type='button'
                                  onClick={() => handleSwitchSource(s)}
                                  className={`mb-1.5 flex w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${
                                    isActive
                                      ? 'bg-green-50 text-green-700 ring-1 ring-green-200 dark:bg-green-950/30 dark:text-green-400 dark:ring-green-800'
                                      : 'text-gray-700 hover:bg-gray-50 dark:text-gray-200 dark:hover:bg-gray-800'
                                  }`}
                                >
                                  <div className='min-w-0 flex-1'>
                                    <div className='flex items-center gap-2'>
                                      <span className='truncate text-sm font-medium'>
                                        {s.source_name || s.source}
                                      </span>
                                      {recommendedSource &&
                                        s.source === recommendedSource.source &&
                                        s.id === recommendedSource.id && (
                                          <span className='rounded bg-emerald-100 px-1.5 py-0.5 text-[10px] text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300'>
                                            推荐
                                          </span>
                                        )}
                                    </div>
                                    <div className='mt-0.5 flex items-center gap-2 text-xs text-gray-400'>
                                      {s.episodes?.length
                                        ? `${s.episodes.length} 集`
                                        : ''}
                                      <span>
                                        评分{' '}
                                        {Math.round(getTeslaSourceScore(s))}
                                      </span>
                                    </div>
                                  </div>
                                  <div className='ml-2 flex items-center gap-1'>
                                    {isActive && (
                                      <span className='text-xs text-green-600 dark:text-green-400'>
                                        当前
                                      </span>
                                    )}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}
          </div>
        </div>
      </div>
    </PageLayout>
  );
}

export default function TeslaPlayPage() {
  return (
    <Suspense
      fallback={
        <div className='flex min-h-screen items-center justify-center'>
          <Loader2 className='h-6 w-6 animate-spin text-green-500' />
        </div>
      }
    >
      <TeslaPlayPageInner />
    </Suspense>
  );
}
