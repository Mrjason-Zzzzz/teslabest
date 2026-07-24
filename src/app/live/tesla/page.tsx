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
    const response = await fetch(url, { signal: controller.signal, cache: 'no-store' });
    if (!response.ok) throw new Error(`请求失败（${response.status}）`);
    const data = await response.json();
    if (data?.success === false) throw new Error(data?.message || '接口返回失败');
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
  const [currentChannel, setCurrentChannel] = useState<LiveChannel | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [activeGroup, setActiveGroup] = useState('全部');
  const [panel, setPanel] = useState<'sources' | 'channels'>('channels');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [error, setError] = useState<string | null>(null);

  const channelCacheRef = useRef(new Map<string, LiveChannel[]>());
  const preferredChannelRef = useRef<{ id?: string; tvgId?: string; name?: string }>({
    id: initialChannelId || undefined,
  });
  const failedSourcesRef = useRef(new Set<string>());

  useEffect(() => {
    const controller = new AbortController();
    fetchJson('/api/live/sources', controller.signal)
      .then((data: any) => {
        const rawList: LiveSource[] = data?.data || data?.sources || [];
        const list = rawList.filter((source) => !source.disabled);
        setSources(list);
        const matched = list.find((source) => source.key === initialSourceKey) || list[0] || null;
        setCurrentSource(matched);
        if (!matched) setError('没有可用的电视直播源');
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') setError(reason?.message || '加载直播源失败');
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
      const wantsSpecificChannel = Boolean(preferred.id || preferred.tvgId || preferred.name);
      const matched =
        list.find((channel) => preferred.id && channel.id === preferred.id) ||
        list.find((channel) => preferred.tvgId && channel.tvgId === preferred.tvgId) ||
        list.find((channel) => preferred.name && channel.name === preferred.name) ||
        list.find((channel) => preferred.name && channel.name.includes(preferred.name)) ||
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
      15000,
    )
      .then((data: any) => {
        const list: LiveChannel[] = data?.data || data?.channels || [];
        channelCacheRef.current.set(currentSource.key, list);
        applyChannels(list);
      })
      .catch((reason) => {
        if (reason?.name !== 'AbortError') {
          setError(`${currentSource.name} 加载失败：${reason?.message || '未知错误'}`);
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
    return `/api/proxy/m3u8?url=${encodeURIComponent(currentChannel.url)}&moontv-source=${encodeURIComponent(currentSource.key)}${allowCORS}`;
  }, [currentChannel, currentSource]);

  const groups = useMemo(() => {
    const values = Array.from(new Set(channels.map((channel) => channel.group).filter(Boolean)));
    return ['全部', ...values];
  }, [channels]);

  const filteredChannels = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    return channels.filter((channel) => {
      const groupMatched = activeGroup === '全部' || channel.group === activeGroup;
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
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  const selectChannel = useCallback((channel: LiveChannel) => {
    if (!currentSource) return;
    failedSourcesRef.current.clear();
    preferredChannelRef.current = {
      id: channel.id,
      tvgId: channel.tvgId,
      name: channel.name,
    };
    setCurrentChannel(channel);
    setPlaybackNotice('');
    syncUrl(currentSource, channel);
  }, [currentSource, syncUrl]);

  const selectSource = useCallback((source: LiveSource) => {
    preferredChannelRef.current = currentChannel
      ? { tvgId: currentChannel.tvgId, name: currentChannel.name }
      : preferredChannelRef.current;
    failedSourcesRef.current.clear();
    setPlaybackNotice(`正在从 ${source.name} 查找同名频道…`);
    setCurrentChannel(null);
    setCurrentSource(source);
    setPanel('channels');
  }, [currentChannel]);

  const tryNextSource = useCallback((message: string) => {
    if (!currentSource || !sources.length) return;
    failedSourcesRef.current.add(currentSource.key);
    preferredChannelRef.current = currentChannel
      ? { tvgId: currentChannel.tvgId, name: currentChannel.name }
      : preferredChannelRef.current;

    const currentIndex = Math.max(0, sources.findIndex((source) => source.key === currentSource.key));
    const next = sources
      .map((_, offset) => sources[(currentIndex + offset + 1) % sources.length])
      .find((source) => !failedSourcesRef.current.has(source.key));

    if (!next) {
      setPlaybackNotice(`所有直播源均未产生有效画面：${message}。请手动选择源或频道。`);
      setPanel('sources');
      return;
    }

    setPlaybackNotice(`当前线路无有效画面，正在自动尝试 ${next.name}…`);
    setCurrentChannel(null);
    setCurrentSource(next);
  }, [currentSource, currentChannel, sources]);

  useEffect(() => {
    if (
      !currentSource ||
      loadingChannels ||
      currentChannel ||
      !channels.length ||
      !preferredChannelRef.current.name
    ) return;
    tryNextSource(`${currentSource.name} 没有同名频道`);
  }, [currentSource, currentChannel, channels, loadingChannels, tryNextSource]);

  const restoreInitialChannel = useCallback(() => {
    failedSourcesRef.current.clear();
    preferredChannelRef.current = { id: initialChannelId || undefined };
    const source = sources.find((item) => item.key === initialSourceKey) || sources[0];
    if (!source) return;
    setPlaybackNotice('正在恢复进入页面时的直播源');
    setCurrentSource(source);
  }, [sources, initialSourceKey, initialChannelId]);

  const backToOriginal = useCallback(() => {
    router.push(`/live?${searchParams.toString()}`);
  }, [router, searchParams]);

  return (
    <div className="fixed inset-0 overflow-hidden bg-[#090a0d] text-white">
      <header className="flex h-14 items-center justify-between border-b border-white/10 bg-[#0d0f13] px-3 md:px-5">
        <div className="flex min-w-0 items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-white/8 text-white/75 active:scale-95"
            aria-label="返回"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Radio className="h-4 w-4 shrink-0 text-rose-400" />
              <h1 className="truncate text-sm font-semibold md:text-base">
                {currentChannel?.name || '电视直播'}
              </h1>
            </div>
            <p className="truncate text-xs text-white/45">
              {currentSource?.name || '正在加载直播源'}
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={restoreInitialChannel}
          className="flex min-h-11 items-center gap-2 rounded-xl bg-white/8 px-3 text-xs text-white/70 active:scale-95"
        >
          <RotateCcw className="h-4 w-4" />
          恢复
        </button>
      </header>

      <main className="grid h-[calc(100%-3.5rem)] min-h-0 lg:grid-cols-[minmax(0,1fr)_390px]">
        <section className="relative min-h-[42vh] bg-black lg:min-h-0">
          {loadingSources && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/65">
              <Loader2 className="h-8 w-8 animate-spin text-emerald-400" />
              <span>正在加载直播源…</span>
            </div>
          )}
          {!loadingSources && currentChannel && playUrl && (
            <TeslaPlayer
              key={`${currentSource?.key}-${currentChannel.id}`}
              url={playUrl}
              title={`${currentSource?.name || ''} · ${currentChannel.name}`}
              poster={currentChannel.logo}
              live
              onBackToOriginal={backToOriginal}
              onPlaybackReady={() => {
                failedSourcesRef.current.clear();
                setPlaybackNotice('');
                if (currentSource && currentChannel) syncUrl(currentSource, currentChannel);
              }}
              onPlaybackError={tryNextSource}
            />
          )}
          {!loadingSources && !currentChannel && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/50">
              <Tv className="h-10 w-10" />
              <span>请从频道列表选择节目</span>
            </div>
          )}
          {playbackNotice && (
            <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
              <div className="max-w-[92%] rounded-full bg-black/85 px-4 py-2 text-center text-xs shadow-xl backdrop-blur">
                {playbackNotice}
              </div>
            </div>
          )}
        </section>

        <aside className="flex min-h-0 flex-col border-t border-white/10 bg-[#101217] lg:border-l lg:border-t-0">
          <div className="grid grid-cols-2 gap-2 border-b border-white/10 p-3">
            <button
              type="button"
              onClick={() => setPanel('sources')}
              className={`min-h-12 rounded-xl px-3 text-sm font-medium ${panel === 'sources' ? 'bg-rose-600 text-white' : 'bg-white/6 text-white/60'}`}
            >
              <Server className="mr-2 inline h-4 w-4" />
              直播源（{sources.length}）
            </button>
            <button
              type="button"
              onClick={() => setPanel('channels')}
              className={`min-h-12 rounded-xl px-3 text-sm font-medium ${panel === 'channels' ? 'bg-rose-600 text-white' : 'bg-white/6 text-white/60'}`}
            >
              <Tv className="mr-2 inline h-4 w-4" />
              频道（{channels.length}）
            </button>
          </div>

          {error && (
            <div className="mx-3 mt-3 flex items-start justify-between gap-2 rounded-xl border border-amber-400/20 bg-amber-400/10 p-3 text-xs text-amber-100">
              <span>{error}</span>
              <button
                type="button"
                onClick={() => currentSource && setCurrentSource({ ...currentSource })}
                className="min-h-9 shrink-0 rounded-lg bg-white/10 px-3"
              >
                重试
              </button>
            </div>
          )}

          {panel === 'sources' ? (
            <div className="min-h-0 flex-1 overflow-y-auto p-3">
              <p className="mb-3 text-xs leading-5 text-white/45">
                车机不再使用系统下拉框。点击任意大按钮即可换源，播放失败会自动尝试下一源。
              </p>
              <div className="grid grid-cols-2 gap-2">
                {sources.map((source) => (
                  <button
                    key={source.key}
                    type="button"
                    onClick={() => selectSource(source)}
                    className={`min-h-14 rounded-xl border px-3 py-2 text-left text-sm transition active:scale-[0.98] ${currentSource?.key === source.key ? 'border-rose-400 bg-rose-500/20 text-white' : 'border-white/8 bg-white/5 text-white/70'}`}
                  >
                    <span className="block truncate font-medium">{source.name}</span>
                    <span className="mt-1 block text-[11px] text-white/35">
                      {source.channelNumber ? `${source.channelNumber} 个频道` : '点击加载频道'}
                    </span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <>
              <div className="space-y-2 border-b border-white/10 p-3">
                <div className="relative">
                  <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                  <input
                    type="text"
                    value={searchKeyword}
                    onChange={(event) => setSearchKeyword(event.target.value)}
                    placeholder="搜索频道"
                    className="min-h-12 w-full rounded-xl bg-white/7 pl-10 pr-3 text-sm outline-none placeholder:text-white/35 focus:ring-1 focus:ring-rose-400"
                  />
                </div>
                <div className="flex gap-2 overflow-x-auto pb-1">
                  {groups.map((group) => (
                    <button
                      key={group}
                      type="button"
                      onClick={() => setActiveGroup(group)}
                      className={`min-h-10 shrink-0 rounded-full px-4 text-xs ${activeGroup === group ? 'bg-white text-black' : 'bg-white/7 text-white/60'}`}
                    >
                      {group}
                    </button>
                  ))}
                </div>
              </div>

              <div className="min-h-0 flex-1 overflow-y-auto p-3">
                {loadingChannels ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-sm text-white/50">
                    <Loader2 className="h-5 w-5 animate-spin" /> 加载频道…
                  </div>
                ) : filteredChannels.length === 0 ? (
                  <div className="py-10 text-center text-sm text-white/40">没有匹配频道</div>
                ) : (
                  <div className="grid grid-cols-2 gap-2">
                    {filteredChannels.map((channel) => (
                      <button
                        key={channel.id}
                        type="button"
                        onClick={() => selectChannel(channel)}
                        className={`min-h-14 rounded-xl border px-3 py-2 text-left text-sm leading-5 transition active:scale-[0.98] ${currentChannel?.id === channel.id ? 'border-rose-400 bg-rose-500/20 text-white' : 'border-white/8 bg-white/5 text-white/70'}`}
                      >
                        <span className="line-clamp-2 break-words">{channel.name}</span>
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
        <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <TeslaLivePageInner />
    </Suspense>
  );
}
