'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import {
  ArrowLeft,
  Loader2,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Tv,
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

import TeslaPlayer from '@/components/TeslaPlayer';

interface LiveSource {
  key: string;
  name: string;
  url: string;
  ua?: string;
  epg?: string;
  from: 'config' | 'custom';
  channelNumber?: number;
  disabled?: boolean;
  proxyMode?: 'full' | 'm3u8-only' | 'direct';
}

interface LiveChannel {
  id: string;
  tvgId: string;
  name: string;
  logo: string;
  group: string;
  url: string;
}

async function fetchJson(url: string, signal: AbortSignal, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  const forwardAbort = () => controller.abort();
  signal.addEventListener('abort', forwardAbort, { once: true });
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
    });
    if (!response.ok) throw new Error(`请求失败（${response.status}）`);
    const data = await response.json();
    if (data?.success === false)
      throw new Error(data?.message || '接口返回失败');
    return data;
  } finally {
    window.clearTimeout(timer);
    signal.removeEventListener('abort', forwardAbort);
  }
}

function TeslaLivePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialSourceKey = searchParams.get('source') || '';
  const initialChannelId = searchParams.get('id') || '';

  const [sources, setSources] = useState<LiveSource[]>([]);
  const [currentSource, setCurrentSource] = useState<LiveSource | null>(null);
  const [channels, setChannels] = useState<LiveChannel[]>([]);
  const [currentChannel, setCurrentChannel] = useState<LiveChannel | null>(
    null
  );
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [activeGroup, setActiveGroup] = useState('全部');
  const [panel, setPanel] = useState<'sources' | 'channels'>('channels');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [playbackIssue, setPlaybackIssue] = useState(false);
  const [playbackAttempt, setPlaybackAttempt] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const channelCacheRef = useRef(new Map<string, LiveChannel[]>());
  const preferredChannelRef = useRef<{
    id?: string;
    tvgId?: string;
    name?: string;
  }>({
    id: initialChannelId || undefined,
  });

  useEffect(() => {
    if ((window as any).RUNTIME_CONFIG?.LIVE_ENABLED !== true) {
      router.replace('/');
    }
  }, [router]);

  useEffect(() => {
    const controller = new AbortController();
    fetchJson('/api/live/sources', controller.signal)
      .then((data: any) => {
        const rawList: LiveSource[] = data?.data || data?.sources || [];
        const list = rawList.filter((source) => !source.disabled);
        setSources(list);
        const matched =
          list.find((source) => source.key === initialSourceKey) ||
          list[0] ||
          null;
        setCurrentSource(matched);
        if (!matched) setError('没有可用的电视直播源');
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError')
          setError(reason?.message || '加载直播源失败');
      })
      .finally(() => setLoadingSources(false));
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (!currentSource) return;
    const controller = new AbortController();
    const cached = channelCacheRef.current.get(currentSource.key);

    const applyChannels = (list: LiveChannel[]) => {
      setChannels(list);
      const preferred = preferredChannelRef.current;
      const wantsSpecificChannel = Boolean(
        preferred.id || preferred.tvgId || preferred.name
      );
      const matched =
        list.find((channel) => preferred.id && channel.id === preferred.id) ||
        list.find(
          (channel) => preferred.tvgId && channel.tvgId === preferred.tvgId
        ) ||
        list.find(
          (channel) => preferred.name && channel.name === preferred.name
        ) ||
        list.find(
          (channel) => preferred.name && channel.name.includes(preferred.name)
        ) ||
        (!wantsSpecificChannel ? list[0] : null) ||
        null;
      setCurrentChannel(matched);
      if (matched) {
        preferredChannelRef.current = {
          id: matched.id,
          tvgId: matched.tvgId,
          name: matched.name,
        };
      }
      if (!list.length) setError(`${currentSource.name} 暂无可用频道`);
    };

    setLoadingChannels(true);
    setError(null);
    setActiveGroup('全部');

    if (cached?.length) {
      applyChannels(cached);
      setLoadingChannels(false);
      return () => controller.abort();
    }

    fetchJson(
      `/api/live/channels?source=${encodeURIComponent(currentSource.key)}`,
      controller.signal,
      15000
    )
      .then((data: any) => {
        const list: LiveChannel[] = data?.data || data?.channels || [];
        channelCacheRef.current.set(currentSource.key, list);
        applyChannels(list);
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') {
          setError(
            `${currentSource.name} 加载失败：${reason?.message || '未知错误'}`
          );
        }
      })
      .finally(() => setLoadingChannels(false));

    return () => controller.abort();
  }, [currentSource?.key]);

  const playUrl = useMemo(() => {
    if (!currentChannel || !currentSource) return '';
    const proxyMode = currentSource.proxyMode || 'full';
    if (proxyMode === 'direct') return currentChannel.url;
    const allowCORS = proxyMode === 'm3u8-only' ? '&allowCORS=true' : '';
    return `/api/proxy/m3u8?url=${encodeURIComponent(
      currentChannel.url
    )}&moontv-source=${encodeURIComponent(currentSource.key)}${allowCORS}`;
  }, [currentChannel, currentSource]);

  const groups = useMemo(() => {
    const values = Array.from(
      new Set(channels.map((channel) => channel.group).filter(Boolean))
    );
    return ['全部', ...values];
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    return channels.filter((channel) => {
      const groupMatched =
        activeGroup === '全部' || channel.group === activeGroup;
      const keywordMatched =
        !keyword ||
        channel.name.toLowerCase().includes(keyword) ||
        channel.group.toLowerCase().includes(keyword);
      return groupMatched && keywordMatched;
    });
  }, [channels, searchKeyword, activeGroup]);

  const syncUrl = useCallback((source: LiveSource, channel: LiveChannel) => {
    const params = new URLSearchParams(window.location.search);
    params.set('source', source.key);
    params.set('id', channel.id);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params.toString()}`
    );
  }, []);

  const selectChannel = useCallback(
    (channel: LiveChannel) => {
      if (!currentSource) return;
      preferredChannelRef.current = {
        id: channel.id,
        tvgId: channel.tvgId,
        name: channel.name,
      };
      setCurrentChannel(channel);
      setPlaybackIssue(false);
      setPlaybackNotice('');
      syncUrl(currentSource, channel);
    },
    [currentSource, syncUrl]
  );

  const selectSource = useCallback(
    (source: LiveSource) => {
      preferredChannelRef.current = currentChannel
        ? { tvgId: currentChannel.tvgId, name: currentChannel.name }
        : preferredChannelRef.current;
      setPlaybackIssue(false);
      setPlaybackNotice(`正在从 ${source.name} 查找同名频道…`);
      setCurrentChannel(null);
      setCurrentSource(source);
      setPanel('channels');
    },
    [currentChannel]
  );

  const handlePlaybackError = useCallback((message: string) => {
    setPlaybackIssue(true);
    setPlaybackNotice(
      `当前源暂时无法播放：${message}。请重试当前源，或手动选择其他直播源。`
    );
  }, []);

  const retryCurrentPlayback = useCallback(() => {
    if (!currentSource || !currentChannel) return;
    setPlaybackIssue(false);
    setPlaybackNotice('正在重试当前源…');
    setPlaybackAttempt((attempt) => attempt + 1);
  }, [currentSource, currentChannel]);

  const restoreInitialChannel = useCallback(() => {
    preferredChannelRef.current = { id: initialChannelId || undefined };
    const source =
      sources.find((item) => item.key === initialSourceKey) || sources[0];
    if (!source) return;
    setPlaybackNotice('正在恢复进入页面时的直播源');
    setCurrentSource(source);
  }, [sources, initialSourceKey, initialChannelId]);

  return (
    <div className='fixed inset-0 overflow-hidden bg-[#06080c] text-white'>
      <header className='flex h-16 items-center justify-between border-b border-white/10 bg-[#0a0d12] px-4 lg:px-6'>
        <div className='flex min-w-0 items-center gap-3'>
          <button
            type='button'
            onClick={() => router.back()}
            className='flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-white/80 transition active:scale-95'
            aria-label='返回'
          >
            <ArrowLeft className='h-5 w-5' />
          </button>
          <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-rose-500/15'>
            <Tv className='h-5 w-5 text-rose-400' />
          </div>
          <div className='min-w-0'>
            <h1 className='truncate text-base font-semibold lg:text-lg'>
              {currentChannel?.name || '电视直播'}
            </h1>
            <p className='mt-0.5 truncate text-xs text-white/45'>
              {currentSource?.name || '正在载入频道'} · Tesla 直播
            </p>
          </div>
        </div>
        <div className='flex items-center gap-2'>
          <div className='hidden items-center gap-2 rounded-full bg-emerald-400/10 px-3 py-2 text-xs text-emerald-300 sm:flex'>
            <span className='h-2 w-2 rounded-full bg-emerald-400' />
            实时直播
          </div>
          <button
            type='button'
            onClick={restoreInitialChannel}
            className='flex min-h-12 items-center gap-2 rounded-2xl bg-white/10 px-4 text-sm text-white/75 transition active:scale-95'
          >
            <RotateCcw className='h-4 w-4' />
            恢复
          </button>
        </div>
      </header>

      <main className='grid h-[calc(100%-4rem)] min-h-0 grid-rows-[minmax(300px,56vh)_minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-1'>
        <section className='min-h-0 bg-[#050609] p-2 lg:p-4 lg:pr-2'>
          <div className='relative h-full min-h-[300px] overflow-hidden rounded-2xl bg-black ring-1 ring-white/10'>
            {loadingSources && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/65'>
                <Loader2 className='h-9 w-9 animate-spin text-rose-400' />
                <span className='text-sm'>正在加载电视直播…</span>
              </div>
            )}
            {!loadingSources && currentChannel && playUrl && (
              <TeslaPlayer
                key={`${currentSource?.key}-${currentChannel.id}-${playbackAttempt}`}
                url={playUrl}
                title={currentChannel.name}
                poster={currentChannel.logo}
                live
                onPlaybackReady={() => {
                  setPlaybackIssue(false);
                  setPlaybackNotice('');
                  if (currentSource && currentChannel)
                    syncUrl(currentSource, currentChannel);
                }}
                onPlaybackError={handlePlaybackError}
              />
            )}
            {!loadingSources && !currentChannel && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/45'>
                <Tv className='h-11 w-11' />
                <span>从右侧选择频道开始播放</span>
              </div>
            )}
            {playbackNotice && (
              <div className='absolute inset-x-0 top-4 z-30 flex justify-center px-4'>
                <div className='max-w-[92%] rounded-2xl border border-white/10 bg-black/85 px-4 py-3 text-center text-sm shadow-2xl backdrop-blur'>
                  <p>{playbackNotice}</p>
                  {playbackIssue && (
                    <div className='mt-3 flex flex-wrap justify-center gap-2'>
                      <button
                        type='button'
                        onClick={retryCurrentPlayback}
                        className='min-h-12 rounded-xl bg-rose-500 px-5 font-medium text-white active:scale-95'
                      >
                        重试当前频道
                      </button>
                      <button
                        type='button'
                        onClick={() => setPanel('sources')}
                        className='min-h-12 rounded-xl bg-white/15 px-5 text-white active:scale-95'
                      >
                        选择其他直播源
                      </button>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className='flex min-h-0 flex-col border-t border-white/10 bg-[#0c0f15] lg:m-4 lg:ml-2 lg:overflow-hidden lg:rounded-2xl lg:border lg:border-white/10'>
          <div className='grid grid-cols-2 gap-2 border-b border-white/10 p-3'>
            <button
              type='button'
              onClick={() => setPanel('channels')}
              className={`min-h-12 rounded-xl px-3 text-sm font-medium transition ${
                panel === 'channels'
                  ? 'bg-rose-500 text-white shadow-lg shadow-rose-950/40'
                  : 'bg-white/5 text-white/55'
              }`}
            >
              <Tv className='mr-2 inline h-4 w-4' />
              频道 {channels.length}
            </button>
            <button
              type='button'
              onClick={() => setPanel('sources')}
              className={`min-h-12 rounded-xl px-3 text-sm font-medium transition ${
                panel === 'sources'
                  ? 'bg-rose-500 text-white shadow-lg shadow-rose-950/40'
                  : 'bg-white/5 text-white/55'
              }`}
            >
              <Server className='mr-2 inline h-4 w-4' />
              来源 {sources.length}
            </button>
          </div>

          {error && (
            <div className='mx-3 mt-3 flex items-center justify-between gap-3 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs text-amber-100'>
              <span className='line-clamp-2'>{error}</span>
              <button
                type='button'
                onClick={() =>
                  currentSource && setCurrentSource({ ...currentSource })
                }
                className='min-h-10 shrink-0 rounded-lg bg-white/10 px-3'
              >
                重试
              </button>
            </div>
          )}

          {panel === 'sources' ? (
            <div className='min-h-0 flex-1 overflow-y-auto p-3'>
              <div className='mb-3 rounded-xl bg-white/5 p-3 text-xs leading-5 text-white/45'>
                切换来源后会优先寻找同名频道。播放失败不会擅自跳到其他来源。
              </div>
              <div className='grid grid-cols-2 gap-2'>
                {sources.map((source) => (
                  <button
                    key={source.key}
                    type='button'
                    onClick={() => selectSource(source)}
                    className={`min-h-16 rounded-xl border px-3 py-3 text-left transition active:scale-[0.98] ${
                      currentSource?.key === source.key
                        ? 'border-rose-400 bg-rose-500/20 text-white'
                        : 'border-white/10 bg-white/5 text-white/65'
                    }`}
                  >
                    <span className='block truncate text-sm font-medium'>
                      {source.name}
                    </span>
                    <span className='mt-1 block text-[11px] text-white/35'>
                      {source.channelNumber
                        ? `${source.channelNumber} 个频道`
                        : '点击加载'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className='space-y-2 border-b border-white/10 p-3'>
                <div className='relative'>
                  <Search className='absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35' />
                  <input
                    type='text'
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder='搜索频道或分组'
                    className='min-h-12 w-full rounded-xl bg-white/10 pl-11 pr-3 text-sm outline-none placeholder:text-white/30 focus:ring-1 focus:ring-rose-400'
                  />
                </div>
                <div className='flex gap-2 overflow-x-auto pb-1'>
                  {groups.map((group) => (
                    <button
                      key={group}
                      type='button'
                      onClick={() => setActiveGroup(group)}
                      className={`min-h-10 shrink-0 rounded-full px-4 text-xs transition ${
                        activeGroup === group
                          ? 'bg-white text-black'
                          : 'bg-white/5 text-white/55'
                      }`}
                    >
                      {group}
                    </button>
                  ))}
                </div>
              </div>
              <div className='min-h-0 flex-1 overflow-y-auto p-3'>
                {loadingChannels ? (
                  <div className='flex items-center justify-center gap-2 py-10 text-sm text-white/50'>
                    <Loader2 className='h-5 w-5 animate-spin' /> 加载频道…
                  </div>
                ) : filteredChannels.length === 0 ? (
                  <div className='py-10 text-center text-sm text-white/40'>
                    没有匹配频道
                  </div>
                ) : (
                  <div className='grid grid-cols-2 gap-2'>
                    {filteredChannels.map((channel) => (
                      <button
                        key={channel.id}
                        type='button'
                        onClick={() => selectChannel(channel)}
                        className={`min-h-16 rounded-xl border px-3 py-3 text-left text-sm leading-5 transition active:scale-[0.98] ${
                          currentChannel?.id === channel.id
                            ? 'border-rose-400 bg-rose-500/20 text-white'
                            : 'border-white/10 bg-white/5 text-white/65'
                        }`}
                      >
                        <span className='line-clamp-2 break-words font-medium'>
                          {channel.name}
                        </span>
                        <span className='mt-1 block truncate text-[11px] text-white/30'>
                          {channel.group || '直播频道'}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </aside>
      </main>
    </div>
  );
}

export default function TeslaLivePage() {
  return (
    <Suspense
      fallback={
        <div className='fixed inset-0 flex items-center justify-center bg-black text-white'>
          <Loader2 className='h-6 w-6 animate-spin' />
        </div>
      }
    >
      <TeslaLivePageInner />
    </Suspense>
  );
}
