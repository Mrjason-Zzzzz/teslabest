'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { ArrowLeft, Loader2, Radio, RefreshCw, RotateCcw, Search, Server } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import TeslaPlayer from '@/components/TeslaPlayer';

interface WebLiveSource {
  key: string;
  name: string;
  platform: string;
  roomId: string;
  avatar?: string;
  title?: string;
  status?: 'live' | 'offline';
}

interface StreamOption {
  id: string;
  label: string;
  url: string;
  originalUrl?: string;
  streamType?: 'hls' | 'flv';
}

function TeslaWebLivePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPlatform = searchParams.get('platform') || '';
  const initialRoomId = searchParams.get('roomId') || '';

  const [sources, setSources] = useState<WebLiveSource[]>([]);
  const [currentSource, setCurrentSource] = useState<WebLiveSource | null>(null);
  const [streamOptions, setStreamOptions] = useState<StreamOption[]>([]);
  const [activeOptionId, setActiveOptionId] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [streamInfo, setStreamInfo] = useState<{ name?: string; title?: string } | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingStream, setLoadingStream] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [streamReloadToken, setStreamReloadToken] = useState(0);
  const [rightTab, setRightTab] = useState<'rooms' | 'lines'>('rooms');
  const [error, setError] = useState<string | null>(null);
  const triedLineIdsRef = useRef(new Set<string>());

  const loadSources = useCallback(() => {
    setLoadingSources(true);
    setError(null);
    fetch('/api/web-live/sources', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || `直播间列表加载失败（${response.status}）`);
        const list: WebLiveSource[] = Array.isArray(data) ? data : (data?.sources || []);
        setSources(list);
        const matched =
          list.find((source) => source.platform === initialPlatform && source.roomId === initialRoomId) ||
          list[0] ||
          null;
        setCurrentSource((previous) => {
          if (previous && list.some((source) => source.key === previous.key)) return previous;
          return matched;
        });
        if (!matched) setPlaybackNotice('后台暂未配置可用直播间');
        setLoadingSources(false);
      })
      .catch((requestError) => {
        setError(requestError?.message || '加载直播间失败');
        setLoadingSources(false);
      });
  }, [initialPlatform, initialRoomId]);

  useEffect(() => loadSources(), [loadSources]);

  useEffect(() => {
    if (!currentSource) return;
    const controller = new AbortController();
    let requestTimedOut = false;
    const timeoutId = window.setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, 16000);
    setLoadingStream(true);
    setError(null);
    setPlaybackNotice('正在解析实时直播流…');
    setVideoUrl('');
    setStreamOptions([]);
    setActiveOptionId('');
    triedLineIdsRef.current.clear();

    const params = new URLSearchParams({
      platform: currentSource.platform,
      roomId: currentSource.roomId,
    });
    fetch(`/api/web-live/stream?${params.toString()}`, {
      cache: 'no-store',
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        window.clearTimeout(timeoutId);
        if (!response.ok) throw new Error(data?.error || `直播流解析失败（${response.status}）`);
        if (!data.url) throw new Error('平台没有返回可播放直播流');

        const parsedOptions: StreamOption[] = Array.isArray(data.alternatives)
          ? data.alternatives.filter((item: any) => item?.url).map((item: any, index: number) => ({
              id: String(item.id || `line-${index + 1}`),
              label: String(item.label || `线路 ${index + 1}`),
              url: String(item.url),
              originalUrl: item.originalUrl,
              streamType: item.streamType,
            }))
          : [];
        if (!parsedOptions.some((item) => item.url === data.url)) {
          parsedOptions.unshift({
            id: 'default',
            label: '默认线路',
            url: data.url,
            originalUrl: data.originalUrl,
            streamType: data.streamType,
          });
        }

        const firstOption = parsedOptions[0];
        setStreamOptions(parsedOptions);
        setActiveOptionId(firstOption.id);
        setVideoUrl(firstOption.url);
        triedLineIdsRef.current.add(firstOption.id);
        setStreamInfo({ name: data.name, title: data.title });
        setPlaybackNotice(`已解析 ${parsedOptions.length} 条线路，正在连接…`);
        setRightTab(parsedOptions.length > 1 ? 'lines' : 'rooms');
        setLoadingStream(false);
      })
      .catch((requestError) => {
        window.clearTimeout(timeoutId);
        if (requestError?.name === 'AbortError') {
          if (requestTimedOut) {
            setError('直播平台响应超时，请点击“重新解析”或切换其他直播间');
            setPlaybackNotice('');
            setLoadingStream(false);
          }
          return;
        }
        setError(requestError?.message || '获取直播流失败');
        setPlaybackNotice('');
        setLoadingStream(false);
      });
    return () => {
      window.clearTimeout(timeoutId);
      controller.abort();
    };
  }, [currentSource, streamReloadToken]);

  const handleSelectSource = useCallback((source: WebLiveSource) => {
    setCurrentSource(source);
    setRightTab('lines');
    const params = new URLSearchParams();
    params.set('platform', source.platform);
    params.set('roomId', source.roomId);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

  const handleSelectLine = useCallback((option: StreamOption) => {
    if (option.id === activeOptionId) return;
    triedLineIdsRef.current.add(option.id);
    setActiveOptionId(option.id);
    setVideoUrl(option.url);
    setError(null);
    setPlaybackNotice(`已切换：${option.label}`);
  }, [activeOptionId]);

  const handlePlaybackError = useCallback((message: string) => {
    const next = streamOptions.find((option) => !triedLineIdsRef.current.has(option.id));
    if (next) {
      triedLineIdsRef.current.add(next.id);
      setActiveOptionId(next.id);
      setVideoUrl(next.url);
      setPlaybackNotice(`当前线路异常，已自动切换到 ${next.label}`);
      setRightTab('lines');
      return;
    }
    setPlaybackNotice(`所有线路均出现异常：${message}。可点击“重新解析”获取新地址。`);
    setRightTab('lines');
  }, [streamOptions]);

  const filteredSources = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return sources;
    return sources.filter((source) =>
      source.name.toLowerCase().includes(keyword) ||
      source.platform.toLowerCase().includes(keyword) ||
      (source.title || '').toLowerCase().includes(keyword)
    );
  }, [sources, searchKeyword]);

  const restoreInitialSource = useCallback(() => {
    const initial = sources.find(
      (source) => source.platform === initialPlatform && source.roomId === initialRoomId,
    ) || sources[0];
    if (!initial) return;
    setPlaybackNotice('正在恢复进入页面时的直播间');
    handleSelectSource(initial);
  }, [sources, initialPlatform, initialRoomId, handleSelectSource]);

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/web-live?${params.toString()}`);
  }, [router, searchParams]);

  const fullTitle = useMemoTitle(streamInfo, currentSource);
  const activeOption = streamOptions.find((option) => option.id === activeOptionId) || null;

  return (
    <div className="min-h-screen bg-slate-950 text-white">
      <header className="sticky top-0 z-40 border-b border-white/10 bg-slate-950/95 px-3 py-2 backdrop-blur sm:px-5">
        <div className="mx-auto flex max-w-[1600px] items-center gap-3">
          <button
            type="button"
            onClick={() => router.back()}
            className="rounded-lg p-2 text-white/70 hover:bg-white/10 hover:text-white"
            aria-label="返回"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
          <Radio className="h-5 w-5 text-rose-500" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold sm:text-base">{fullTitle}</div>
            <div className="truncate text-xs text-white/45">
              {currentSource ? `${platformLabel(currentSource.platform)} · ${currentSource.name}` : '网络直播'}
              {activeOption ? ` · ${activeOption.label}` : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setStreamReloadToken((value) => value + 1)}
            disabled={!currentSource || loadingStream}
            className="flex min-h-10 items-center gap-1.5 rounded-lg bg-rose-600 px-3 py-2 text-xs font-medium hover:bg-rose-500 disabled:opacity-40"
          >
            <RefreshCw className={`h-4 w-4 ${loadingStream ? 'animate-spin' : ''}`} />
            重新解析
          </button>
        </div>
      </header>

      <main className="mx-auto grid max-w-[1600px] grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,1fr)_360px] lg:p-4">
        <section className="min-w-0">
          <div className="relative aspect-video min-h-[260px] overflow-hidden rounded-xl bg-black shadow-2xl ring-1 ring-white/10 sm:min-h-[420px] lg:min-h-0">
            {loadingSources && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span>正在加载直播间…</span>
              </div>
            )}

            {error && (
              <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 bg-black px-6 text-center">
                <p className="max-w-xl text-sm text-red-300">{error}</p>
                <div className="flex flex-wrap justify-center gap-2">
                  <button
                    type="button"
                    onClick={() => currentSource ? setStreamReloadToken((value) => value + 1) : loadSources()}
                    className="flex min-h-11 items-center gap-1 rounded-lg bg-rose-600 px-4 py-2 text-sm hover:bg-rose-500"
                  >
                    <RefreshCw className="h-4 w-4" />
                    重试
                  </button>
                  <button
                    type="button"
                    onClick={backToOriginal}
                    className="min-h-11 rounded-lg bg-white/10 px-4 py-2 text-sm hover:bg-white/20"
                  >
                    切回原版
                  </button>
                </div>
              </div>
            )}

            {!loadingSources && !error && videoUrl && (
              <TeslaPlayer
                key={`${currentSource?.key}-${activeOptionId}-${streamReloadToken}`}
                url={videoUrl}
                title={fullTitle}
                live
                defaultMode="video"
                onBackToOriginal={backToOriginal}
                onPlaybackReady={() => setPlaybackNotice('')}
                onPlaybackError={handlePlaybackError}
              />
            )}

            {!loadingSources && !error && !videoUrl && loadingStream && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
                <Loader2 className="h-8 w-8 animate-spin" />
                <span>正在获取直播线路…</span>
              </div>
            )}

            {!loadingSources && !error && !currentSource && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/60">
                <Server className="h-10 w-10" />
                <p>后台暂无可用直播间，请先在控制面板添加直播间。</p>
              </div>
            )}

            {playbackNotice && (
              <div className="pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4">
                <div className="max-w-[92%] rounded-full bg-black/85 px-4 py-2 text-center text-xs text-white shadow-lg backdrop-blur">
                  {playbackNotice}
                </div>
              </div>
            )}
          </div>

          <div className="mt-3 rounded-xl border border-white/10 bg-white/5 p-3 text-sm">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <div className="font-medium">{streamInfo?.name || currentSource?.name || '未选择直播间'}</div>
                <div className="mt-1 text-xs text-white/45">{streamInfo?.title || '选择右侧直播间和播放线路'}</div>
              </div>
              <div className="rounded-full bg-white/10 px-3 py-1 text-xs text-white/60">
                {streamOptions.length} 条可用线路
              </div>
            </div>
          </div>
        </section>

        <aside className="min-w-0 lg:sticky lg:top-[72px] lg:self-start">
          <div className="overflow-hidden rounded-xl border border-white/10 bg-slate-900/95 shadow-xl">
            <div className="grid grid-cols-2 border-b border-white/10">
              <button
                type="button"
                onClick={() => setRightTab('rooms')}
                className={`min-h-12 text-sm font-medium ${rightTab === 'rooms' ? 'border-b-2 border-rose-500 text-rose-400' : 'text-white/55 hover:bg-white/5'}`}
              >
                直播间 ({sources.length})
              </button>
              <button
                type="button"
                onClick={() => setRightTab('lines')}
                className={`min-h-12 text-sm font-medium ${rightTab === 'lines' ? 'border-b-2 border-emerald-500 text-emerald-400' : 'text-white/55 hover:bg-white/5'}`}
              >
                播放线路 ({streamOptions.length})
              </button>
            </div>

            {rightTab === 'rooms' && (
              <div>
                <div className="border-b border-white/10 p-3">
                  <div className="relative">
                    <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35" />
                    <input
                      type="text"
                      value={searchKeyword}
                      onChange={(event) => setSearchKeyword(event.target.value)}
                      placeholder="搜索平台、主播或标题"
                      className="h-11 w-full rounded-lg bg-white/10 pl-9 pr-3 text-sm outline-none placeholder:text-white/35 focus:ring-1 focus:ring-rose-500"
                    />
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={loadSources}
                      className="min-h-10 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15"
                    >
                      刷新列表
                    </button>
                    <button
                      type="button"
                      onClick={restoreInitialSource}
                      className="flex min-h-10 items-center justify-center gap-1 rounded-lg bg-white/10 px-3 py-2 text-xs hover:bg-white/15"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                      恢复进入项
                    </button>
                  </div>
                </div>
                <div className="max-h-[58vh] space-y-2 overflow-y-auto p-2">
                  {filteredSources.length === 0 ? (
                    <div className="py-8 text-center text-sm text-white/40">暂无其他直播间</div>
                  ) : filteredSources.map((source) => {
                    const active = currentSource?.key === source.key;
                    return (
                      <button
                        key={source.key}
                        type="button"
                        onClick={() => handleSelectSource(source)}
                        className={`flex min-h-14 w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${active ? 'bg-rose-600 text-white' : 'bg-white/5 text-white/75 hover:bg-white/10'}`}
                      >
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{source.name}</span>
                          <span className={`mt-0.5 block text-xs ${active ? 'text-white/75' : 'text-white/40'}`}>
                            {platformLabel(source.platform)}{source.status === 'live' ? ' · 直播中' : source.status === 'offline' ? ' · 状态待刷新' : ''}
                          </span>
                        </span>
                        {active && <span className="ml-2 text-xs">当前</span>}
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {rightTab === 'lines' && (
              <div className="max-h-[68vh] space-y-2 overflow-y-auto p-3">
                {streamOptions.length === 0 ? (
                  <div className="py-8 text-center text-sm text-white/40">选择直播间后显示播放线路</div>
                ) : streamOptions.map((option) => {
                  const active = option.id === activeOptionId;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => handleSelectLine(option)}
                      className={`flex min-h-14 w-full items-center justify-between rounded-lg px-3 py-2 text-left transition-colors ${active ? 'bg-emerald-600 text-white' : 'bg-white/5 text-white/75 hover:bg-white/10'}`}
                    >
                      <span>
                        <span className="block text-sm font-medium">{option.label}</span>
                        <span className={`mt-0.5 block text-xs ${active ? 'text-white/75' : 'text-white/40'}`}>
                          {(option.streamType || 'hls').toUpperCase()} · 点击立即换线
                        </span>
                      </span>
                      {active && <span className="text-xs">当前</span>}
                    </button>
                  );
                })}
                <button
                  type="button"
                  onClick={() => setStreamReloadToken((value) => value + 1)}
                  className="mt-2 flex min-h-12 w-full items-center justify-center gap-1.5 rounded-lg border border-white/10 bg-white/5 text-sm text-white/65 hover:bg-white/10"
                >
                  <RefreshCw className="h-4 w-4" />
                  重新解析全部线路
                </button>
              </div>
            )}
          </div>
        </aside>
      </main>
    </div>
  );
}

function platformLabel(platform: string): string {
  const labels: Record<string, string> = {
    huya: '虎牙',
    bilibili: '哔哩哔哩',
    douyin: '抖音',
    douyu: '斗鱼',
  };
  return labels[platform] || platform;
}

function useMemoTitle(
  streamInfo: { name?: string; title?: string } | null,
  source: WebLiveSource | null
): string {
  if (streamInfo?.title && streamInfo?.name) return `${streamInfo.name} - ${streamInfo.title}`;
  if (streamInfo?.title) return streamInfo.title;
  if (streamInfo?.name) return streamInfo.name;
  return source?.name || '网络直播';
}

export default function TeslaWebLivePage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 flex items-center justify-center bg-slate-950 text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <TeslaWebLivePageInner />
    </Suspense>
  );
}
