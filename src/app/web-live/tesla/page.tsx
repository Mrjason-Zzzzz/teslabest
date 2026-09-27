'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import {
  ArrowLeft,
  Loader2,
  Plus,
  Radio,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Trash2,
  X,
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
import { detectWebLivePlatform } from '@/lib/tesla/web-live-source';

interface WebLiveSource {
  key: string;
  name: string;
  platform: string;
  roomId: string;
  avatar?: string;
  title?: string;
  status?: 'live' | 'offline';
  from?: 'custom' | 'config';
}

interface StreamTransport {
  id: string;
  label: string;
  url: string;
  originalUrl?: string;
  streamType?: 'hls' | 'flv';
}

interface StreamQuality {
  id: string;
  label: string;
  transports: StreamTransport[];
}

function isTeslaStream(item: any): boolean {
  const url = String(item?.url || '').toLowerCase();
  return (
    Boolean(item?.url) &&
    item?.streamType !== 'flv' &&
    !/\.flv(?:\?|$)/.test(url)
  );
}

function TeslaWebLivePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPlatform = searchParams.get('platform') || '';
  const initialRoomId = searchParams.get('roomId') || '';

  const [sources, setSources] = useState<WebLiveSource[]>([]);
  const [currentSource, setCurrentSource] = useState<WebLiveSource | null>(
    null
  );
  const [qualityOptions, setQualityOptions] = useState<StreamQuality[]>([]);
  const [activeQualityId, setActiveQualityId] = useState('');
  const [activeTransportId, setActiveTransportId] = useState('');
  const [videoUrl, setVideoUrl] = useState('');
  const [streamInfo, setStreamInfo] = useState<{
    name?: string;
    title?: string;
  } | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingStream, setLoadingStream] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [streamReloadToken, setStreamReloadToken] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [savingSource, setSavingSource] = useState(false);
  const [deleteConfirmKey, setDeleteConfirmKey] = useState('');
  const [newSource, setNewSource] = useState({
    name: '',
    platform: 'douyin',
    roomId: '',
  });
  const triedTransportIdsRef = useRef(new Set<string>());
  const automaticReparseAttemptsRef = useRef(0);

  useEffect(() => {
    if ((window as any).RUNTIME_CONFIG?.WEB_LIVE_ENABLED !== true) {
      router.replace('/');
    }
  }, [router]);

  const loadSources = useCallback(() => {
    setLoadingSources(true);
    setError(null);
    fetch('/api/web-live/sources', { cache: 'no-store' })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok)
          throw new Error(
            data?.error || `直播间列表加载失败（${response.status}）`
          );
        const list: WebLiveSource[] = Array.isArray(data)
          ? data
          : data?.sources || [];
        setCanManage(!Array.isArray(data) && data?.canManage === true);
        setSources(list);
        const matched =
          list.find(
            (source) =>
              source.platform === initialPlatform &&
              source.roomId === initialRoomId
          ) ||
          list[0] ||
          null;
        setCurrentSource((previous) => {
          if (previous && list.some((source) => source.key === previous.key))
            return previous;
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

  const manageSource = useCallback(
    async (payload: Record<string, unknown>) => {
      setSavingSource(true);
      setError(null);
      try {
        const response = await fetch('/api/admin/web-live', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data?.error || '操作失败');
        setPlaybackNotice(
          payload.action === 'delete' ? '直播间已删除' : '直播间已添加'
        );
        setDeleteConfirmKey('');
        setNewSource({ name: '', platform: 'douyin', roomId: '' });
        loadSources();
      } catch (requestError) {
        setError(
          requestError instanceof Error ? requestError.message : '操作失败'
        );
      } finally {
        setSavingSource(false);
      }
    },
    [loadSources]
  );

  const addSource = useCallback(() => {
    if (!newSource.roomId.trim()) {
      setError('请填写房间 ID 或粘贴完整直播链接');
      return;
    }
    void manageSource({ action: 'add', ...newSource });
  }, [manageSource, newSource]);

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
    setQualityOptions([]);
    setActiveQualityId('');
    setActiveTransportId('');
    triedTransportIdsRef.current.clear();

    const params = new URLSearchParams({
      source: currentSource.key,
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
        if (!response.ok)
          throw new Error(
            data?.error || `直播流解析失败（${response.status}）`
          );
        if (!data.url) throw new Error('平台没有返回可播放直播流');

        const parsedQualities: StreamQuality[] = Array.isArray(data.qualities)
          ? data.qualities
              .map((quality: any, qualityIndex: number) => ({
                id: String(quality.id || `quality-${qualityIndex + 1}`),
                label: String(quality.label || `清晰度 ${qualityIndex + 1}`),
                transports: Array.isArray(quality.transports)
                  ? quality.transports
                      .filter(isTeslaStream)
                      .map((item: any, transportIndex: number) => ({
                        id: String(
                          item.id || `transport-${transportIndex + 1}`
                        ),
                        label: String(
                          item.label || `备用线路 ${transportIndex + 1}`
                        ),
                        url: String(item.url),
                        originalUrl: item.originalUrl,
                        streamType: item.streamType,
                      }))
                  : [],
              }))
              .filter((quality: StreamQuality) => quality.transports.length > 0)
          : [];

        // Backward compatibility for old resolver responses.
        if (parsedQualities.length === 0) {
          const transports: StreamTransport[] = Array.isArray(data.alternatives)
            ? data.alternatives
                .filter(isTeslaStream)
                .map((item: any, index: number) => ({
                  id: String(item.id || `transport-${index + 1}`),
                  label: String(item.label || `备用线路 ${index + 1}`),
                  url: String(item.url),
                  originalUrl: item.originalUrl,
                  streamType: item.streamType,
                }))
            : [];
          if (
            isTeslaStream(data) &&
            !transports.some((item) => item.url === data.url)
          ) {
            transports.unshift({
              id: 'default',
              label: '默认线路',
              url: String(data.url),
              originalUrl: data.originalUrl,
              streamType: data.streamType,
            });
          }
          parsedQualities.push({ id: 'AUTO', label: '自动', transports });
        }

        if (parsedQualities.length === 0) {
          throw new Error('当前直播间没有可用于 Tesla 播放的 HLS 线路');
        }

        const firstQuality = parsedQualities[0];
        const firstTransport = firstQuality.transports[0];
        setQualityOptions(parsedQualities);
        setActiveQualityId(firstQuality.id);
        setActiveTransportId(firstTransport.id);
        setVideoUrl(firstTransport.url);
        triedTransportIdsRef.current.add(firstTransport.id);
        setStreamInfo({ name: data.name, title: data.title });
        setPlaybackNotice(
          data.qualityNotice ||
            `已加载 ${parsedQualities.length} 档清晰度，线路将自动择优`
        );
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
    automaticReparseAttemptsRef.current = 0;
    setCurrentSource(source);
    const params = new URLSearchParams();
    params.set('platform', source.platform);
    params.set('roomId', source.roomId);
    window.history.replaceState(
      null,
      '',
      `${window.location.pathname}?${params.toString()}`
    );
  }, []);

  const reconnectStream = useCallback(() => {
    automaticReparseAttemptsRef.current = 0;
    setError(null);
    setStreamReloadToken((value) => value + 1);
  }, []);

  const activateQuality = useCallback(
    (quality: StreamQuality, notice?: string) => {
      const firstTransport = quality.transports[0];
      if (!firstTransport) return;
      triedTransportIdsRef.current.clear();
      triedTransportIdsRef.current.add(firstTransport.id);
      setActiveQualityId(quality.id);
      setActiveTransportId(firstTransport.id);
      setVideoUrl(firstTransport.url);
      setError(null);
      setPlaybackNotice(notice || `已切换清晰度：${quality.label}`);
    },
    []
  );

  const handleSelectQuality = useCallback(
    (qualityId: string) => {
      const quality = qualityOptions.find((item) => item.id === qualityId);
      if (!quality || quality.id === activeQualityId) return;
      activateQuality(quality);
    },
    [qualityOptions, activeQualityId, activateQuality]
  );

  const handlePlaybackError = useCallback(
    (message: string) => {
      const activeQuality = qualityOptions.find(
        (item) => item.id === activeQualityId
      );
      const nextTransport = activeQuality?.transports.find(
        (transport) => !triedTransportIdsRef.current.has(transport.id)
      );
      if (nextTransport) {
        triedTransportIdsRef.current.add(nextTransport.id);
        setActiveTransportId(nextTransport.id);
        setVideoUrl(nextTransport.url);
        setPlaybackNotice('当前链路异常，系统已自动切换备用通道');
        return;
      }

      const activeIndex = qualityOptions.findIndex(
        (item) => item.id === activeQualityId
      );
      if (activeIndex > 0) {
        const lowerQuality = qualityOptions[activeIndex - 1];
        activateQuality(
          lowerQuality,
          `网络波动，已自动降至 ${lowerQuality.label}`
        );
        return;
      }

      if (automaticReparseAttemptsRef.current < 1) {
        automaticReparseAttemptsRef.current += 1;
        setPlaybackNotice(
          `当前最低清晰度仍不稳定：${message}。正在重新解析一次直播地址…`
        );
        window.setTimeout(
          () => setStreamReloadToken((value) => value + 1),
          1200
        );
        return;
      }

      setError(
        `当前房间的 Tesla 可播线路持续异常：${message}。已停止循环重连，请手动重试或换直播间。`
      );
      setPlaybackNotice('');
    },
    [qualityOptions, activeQualityId, activateQuality]
  );

  const filteredSources = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return sources;
    return sources.filter(
      (source) =>
        source.name.toLowerCase().includes(keyword) ||
        source.platform.toLowerCase().includes(keyword) ||
        (source.title || '').toLowerCase().includes(keyword)
    );
  }, [sources, searchKeyword]);

  const restoreInitialSource = useCallback(() => {
    const initial =
      sources.find(
        (source) =>
          source.platform === initialPlatform && source.roomId === initialRoomId
      ) || sources[0];
    if (!initial) return;
    setPlaybackNotice('正在恢复进入页面时的直播间');
    handleSelectSource(initial);
  }, [sources, initialPlatform, initialRoomId, handleSelectSource]);

  const fullTitle = useMemoTitle(streamInfo, currentSource);
  const activeQuality =
    qualityOptions.find((option) => option.id === activeQualityId) || null;

  return (
    <div className='tesla-live-route min-h-[100dvh] overflow-x-hidden overflow-y-auto bg-[#06080c] text-white lg:fixed lg:inset-0 lg:overflow-hidden'>
      <header className='sticky top-0 z-40 flex h-16 items-center justify-between border-b border-white/10 bg-[#0a0d12] px-4 lg:static lg:px-6'>
        <div className='flex min-w-0 items-center gap-3'>
          <button
            type='button'
            onClick={() => router.back()}
            className='flex h-12 w-12 shrink-0 items-center justify-center rounded-2xl bg-white/10 text-white/80 transition active:scale-95'
            aria-label='返回'
          >
            <ArrowLeft className='h-5 w-5' />
          </button>
          <div className='flex h-11 w-11 shrink-0 items-center justify-center rounded-2xl bg-violet-500/15'>
            <Radio className='h-5 w-5 text-violet-400' />
          </div>
          <div className='min-w-0'>
            <h1 className='truncate text-base font-semibold lg:text-lg'>
              {fullTitle}
            </h1>
            <p className='mt-0.5 truncate text-xs text-white/45'>
              {currentSource
                ? `${platformLabel(currentSource.platform)} · ${
                    currentSource.name
                  }`
                : '网络直播'}
              {activeQuality ? ` · ${activeQuality.label}` : ''}
            </p>
          </div>
        </div>
        <button
          type='button'
          onClick={reconnectStream}
          disabled={!currentSource || loadingStream}
          className='flex min-h-12 items-center gap-2 rounded-2xl bg-violet-500 px-4 text-sm font-medium text-white transition active:scale-95 disabled:opacity-40'
        >
          <RefreshCw
            className={`h-4 w-4 ${loadingStream ? 'animate-spin' : ''}`}
          />
          重新连接
        </button>
      </header>

      <main className='grid min-h-[calc(100dvh-4rem)] grid-rows-[minmax(14rem,48dvh)_auto] lg:h-[calc(100%-4rem)] lg:min-h-0 lg:grid-cols-[minmax(0,1fr)_420px] lg:grid-rows-1'>
        <section className='bg-[#050609] p-2 lg:min-h-0 lg:p-4 lg:pr-2'>
          <div className='relative h-full min-h-[14rem] overflow-hidden rounded-2xl bg-black ring-1 ring-white/10'>
            {loadingSources && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/65'>
                <Loader2 className='h-9 w-9 animate-spin text-violet-400' />
                <span className='text-sm'>正在加载网络直播…</span>
              </div>
            )}

            {error && (
              <div className='absolute inset-0 z-20 flex flex-col items-center justify-center gap-4 bg-black px-6 text-center'>
                <div className='flex h-12 w-12 items-center justify-center rounded-full bg-red-500/15'>
                  <Radio className='h-5 w-5 text-red-300' />
                </div>
                <p className='max-w-xl text-sm leading-6 text-red-200'>
                  {error}
                </p>
                <button
                  type='button'
                  onClick={() =>
                    currentSource ? reconnectStream() : loadSources()
                  }
                  className='flex min-h-12 items-center gap-2 rounded-xl bg-violet-500 px-5 text-sm font-medium active:scale-95'
                >
                  <RefreshCw className='h-4 w-4' />
                  重新连接
                </button>
              </div>
            )}

            {!loadingSources && !error && videoUrl && (
              <TeslaPlayer
                key={`${currentSource?.key}-${activeTransportId}-${streamReloadToken}`}
                url={videoUrl}
                title={fullTitle}
                live
                qualityOptions={qualityOptions.map(({ id, label }) => ({
                  id,
                  label,
                }))}
                quality={activeQualityId}
                onQualityChange={handleSelectQuality}
                sourceKey={currentSource?.platform}
                sourceName={currentSource?.name}
                onPlaybackReady={() => {
                  automaticReparseAttemptsRef.current = 0;
                  setSources((current) =>
                    current.map((source) =>
                      source.key === currentSource?.key
                        ? { ...source, status: 'live' }
                        : source
                    )
                  );
                  setPlaybackNotice('');
                }}
                onPlaybackError={handlePlaybackError}
              />
            )}

            {!loadingSources && !error && !videoUrl && loadingStream && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 text-white/65'>
                <Loader2 className='h-9 w-9 animate-spin text-violet-400' />
                <span>正在获取 HLS 直播线路…</span>
              </div>
            )}

            {!loadingSources && !error && !currentSource && (
              <div className='absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center text-white/50'>
                <Server className='h-11 w-11' />
                <p>后台暂无直播间，请先在控制面板添加。</p>
              </div>
            )}

            {playbackNotice && (
              <div className='pointer-events-none absolute inset-x-0 top-4 z-30 flex justify-center px-4'>
                <div className='max-w-[92%] rounded-2xl border border-white/10 bg-black/85 px-4 py-3 text-center text-sm shadow-2xl backdrop-blur'>
                  {playbackNotice}
                </div>
              </div>
            )}
          </div>
        </section>

        <aside className='flex min-h-[24rem] flex-col border-t border-white/10 bg-[#0c0f15] lg:m-4 lg:ml-2 lg:min-h-0 lg:overflow-hidden lg:rounded-2xl lg:border lg:border-white/10'>
          <div className='flex min-h-16 items-center justify-between border-b border-white/10 px-4'>
            <div>
              <div className='text-sm font-semibold'>
                直播间 · {sources.length}
              </div>
              <div className='mt-1 text-[11px] text-white/40'>
                {activeQuality
                  ? `${activeQuality.label} · 自动择优 HLS 线路`
                  : '选择直播间开始播放'}
              </div>
            </div>
            <div className='flex items-center gap-2'>
              {canManage && (
                <button
                  type='button'
                  onClick={() => setShowManage((value) => !value)}
                  className='flex min-h-11 items-center gap-1 rounded-xl bg-violet-500/20 px-3 text-xs text-violet-200 active:scale-95'
                >
                  {showManage ? (
                    <X className='h-4 w-4' />
                  ) : (
                    <Plus className='h-4 w-4' />
                  )}
                  {showManage ? '收起' : '管理'}
                </button>
              )}
              <div className='hidden items-center gap-2 rounded-full bg-violet-400/10 px-3 py-2 text-xs text-violet-200 xl:flex'>
                <span className='h-2 w-2 rounded-full bg-violet-400' />
                Tesla 可播线路
              </div>
            </div>
          </div>

          {canManage && showManage && (
            <div className='space-y-3 border-b border-violet-400/20 bg-violet-500/5 p-3'>
              <div className='grid grid-cols-3 gap-2'>
                {[
                  ['douyin', '抖音'],
                  ['huya', '虎牙'],
                  ['bilibili', 'B站'],
                ].map(([value, label]) => (
                  <button
                    key={value}
                    type='button'
                    onClick={() =>
                      setNewSource((current) => ({
                        ...current,
                        platform: value,
                      }))
                    }
                    className={`min-h-11 rounded-xl text-sm ${
                      newSource.platform === value
                        ? 'bg-violet-500 text-white'
                        : 'bg-white/5 text-white/60'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <input
                value={newSource.roomId}
                onChange={(event) =>
                  setNewSource((current) => ({
                    ...current,
                    roomId: event.target.value,
                    platform:
                      detectWebLivePlatform(event.target.value) ||
                      current.platform,
                  }))
                }
                placeholder='粘贴直播间链接，自动识别平台和房间号'
                className='min-h-11 w-full rounded-xl bg-white/10 px-3 text-sm outline-none focus:ring-1 focus:ring-violet-400'
              />
              <input
                value={newSource.name}
                onChange={(event) =>
                  setNewSource((current) => ({
                    ...current,
                    name: event.target.value,
                  }))
                }
                placeholder='名称（选填，留空自动生成）'
                className='min-h-11 w-full rounded-xl bg-white/10 px-3 text-sm outline-none focus:ring-1 focus:ring-violet-400'
              />
              <button
                type='button'
                onClick={addSource}
                disabled={savingSource}
                className='flex min-h-11 w-full items-center justify-center gap-2 rounded-xl bg-violet-500 text-sm font-medium disabled:opacity-50'
              >
                {savingSource ? (
                  <Loader2 className='h-4 w-4 animate-spin' />
                ) : (
                  <Plus className='h-4 w-4' />
                )}
                添加并刷新
              </button>
            </div>
          )}

          <div className='space-y-2 border-b border-white/10 p-3'>
            {qualityOptions.length > 0 && (
              <div>
                <div className='mb-2 text-xs font-medium text-white/45'>
                  清晰度
                </div>
                <div className='grid grid-cols-3 gap-2'>
                  {qualityOptions.map((option) => (
                    <button
                      key={option.id}
                      type='button'
                      onClick={() => handleSelectQuality(option.id)}
                      className={`min-h-11 rounded-xl px-2 text-sm font-medium transition active:scale-95 ${
                        option.id === activeQualityId
                          ? 'bg-violet-500 text-white shadow-lg shadow-violet-950/40'
                          : 'bg-white/5 text-white/60'
                      }`}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <div className='relative'>
              <Search className='absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-white/35' />
              <input
                type='text'
                value={searchKeyword}
                onChange={(event) => setSearchKeyword(event.target.value)}
                placeholder='搜索平台、主播或标题'
                className='min-h-12 w-full rounded-xl bg-white/10 pl-11 pr-3 text-sm outline-none placeholder:text-white/30 focus:ring-1 focus:ring-violet-400'
              />
            </div>
            <div className='grid grid-cols-2 gap-2'>
              <button
                type='button'
                onClick={loadSources}
                className='min-h-12 rounded-xl bg-white/5 px-3 text-sm text-white/65 active:scale-95'
              >
                刷新列表
              </button>
              <button
                type='button'
                onClick={restoreInitialSource}
                className='flex min-h-12 items-center justify-center gap-2 rounded-xl bg-white/5 px-3 text-sm text-white/65 active:scale-95'
              >
                <RotateCcw className='h-4 w-4' />
                恢复进入项
              </button>
            </div>
          </div>

          <div className='min-h-0 flex-1 space-y-2 overflow-y-auto p-3'>
            {filteredSources.length === 0 ? (
              <div className='py-10 text-center text-sm text-white/40'>
                没有匹配直播间
              </div>
            ) : (
              filteredSources.map((source) => {
                const active = currentSource?.key === source.key;
                return (
                  <div
                    key={source.key}
                    className={`flex min-h-16 w-full items-center gap-3 rounded-xl border px-3 py-3 text-left transition active:scale-[0.98] ${
                      active
                        ? 'border-violet-400 bg-violet-500/20 text-white'
                        : 'border-white/10 bg-white/5 text-white/65'
                    }`}
                  >
                    <button
                      type='button'
                      onClick={() => handleSelectSource(source)}
                      className='flex min-w-0 flex-1 items-center gap-3 text-left'
                    >
                      <span
                        className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${
                          active ? 'bg-violet-400/20' : 'bg-white/5'
                        }`}
                      >
                        <Radio className='h-4 w-4' />
                      </span>
                      <span className='min-w-0 flex-1'>
                        <span className='block truncate text-sm font-medium'>
                          {source.name}
                        </span>
                        <span className='mt-1 block truncate text-xs text-white/35'>
                          {platformLabel(source.platform)}
                          {source.status === 'live'
                            ? ' · 直播中'
                            : source.status === 'offline'
                            ? ' · 待刷新'
                            : ''}
                        </span>
                      </span>
                      {active && (
                        <span className='rounded-full bg-white/10 px-2 py-1 text-[11px]'>
                          当前
                        </span>
                      )}
                    </button>
                    {canManage && source.from !== 'config' && (
                      <button
                        type='button'
                        onClick={() => {
                          if (deleteConfirmKey === source.key) {
                            void manageSource({
                              action: 'delete',
                              key: source.key,
                            });
                          } else {
                            setDeleteConfirmKey(source.key);
                          }
                        }}
                        disabled={savingSource}
                        className={`min-h-11 shrink-0 rounded-xl px-3 text-xs ${
                          deleteConfirmKey === source.key
                            ? 'bg-red-500 text-white'
                            : 'bg-white/5 text-red-300'
                        }`}
                        aria-label={`删除 ${source.name}`}
                      >
                        {deleteConfirmKey === source.key ? (
                          '确认删除'
                        ) : (
                          <Trash2 className='h-4 w-4' />
                        )}
                      </button>
                    )}
                  </div>
                );
              })
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
  if (streamInfo?.title && streamInfo?.name)
    return `${streamInfo.name} - ${streamInfo.title}`;
  if (streamInfo?.title) return streamInfo.title;
  if (streamInfo?.name) return streamInfo.name;
  return source?.name || '网络直播';
}

export default function TeslaWebLivePage() {
  return (
    <Suspense
      fallback={
        <div className='fixed inset-0 flex items-center justify-center bg-slate-950 text-white'>
          <Loader2 className='h-6 w-6 animate-spin' />
        </div>
      }
    >
      <TeslaWebLivePageInner />
    </Suspense>
  );
}
