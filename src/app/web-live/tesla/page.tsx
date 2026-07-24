'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { ArrowLeft, Loader2, Radio, RotateCcw, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import TeslaPlayer from '@/components/TeslaPlayer';

/**
 * /web-live/tesla
 *
 * 特斯拉车机适配版网页直播页。接收与 /web-live 相同的 query 参数：
 *   - platform, roomId
 *
 * 仅保留：源列表 + 播放。底层播放器为 TeslaPlayer（Broadway + Canvas）。
 */

interface WebLiveSource {
  key: string;
  name: string;
  platform: string;
  roomId: string;
  avatar?: string;
  title?: string;
  status?: 'live' | 'offline';
}

function TeslaWebLivePageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialPlatform = searchParams.get('platform') || '';
  const initialRoomId = searchParams.get('roomId') || '';

  const [sources, setSources] = useState<WebLiveSource[]>([]);
  const [currentSource, setCurrentSource] = useState<WebLiveSource | null>(null);
  const [videoUrl, setVideoUrl] = useState('');
  const [streamInfo, setStreamInfo] = useState<{ name?: string; title?: string } | null>(null);
  const [loadingSources, setLoadingSources] = useState(true);
  const [loadingStream, setLoadingStream] = useState(false);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [playbackNotice, setPlaybackNotice] = useState('');
  const [error, setError] = useState<string | null>(null);

  // 拉取源列表
  useEffect(() => {
    fetch('/api/web-live/sources')
      .then((r) => r.json())
      .then((data: any) => {
        // /api/web-live/sources 直接返回数组
        const list: WebLiveSource[] = Array.isArray(data) ? data : (data?.sources || []);
        setSources(list);
        const matched =
          list.find((s) => s.platform === initialPlatform && s.roomId === initialRoomId) ||
          list[0] ||
          null;
        if (matched) setCurrentSource(matched);
        setLoadingSources(false);
      })
      .catch((e) => {
        setError(e?.message || '加载直播源失败');
        setLoadingSources(false);
      });
  }, []);

  // 加载流地址
  useEffect(() => {
    if (!currentSource) return;
    setLoadingStream(true);
    setError(null);
    setVideoUrl('');
    fetch(`/api/web-live/stream?platform=${currentSource.platform}&roomId=${currentSource.roomId}`)
      .then(async (r) => {
        const data = await r.json();
        if (!r.ok) throw new Error(data?.error || `HTTP ${r.status}`);
        setVideoUrl(data.url);
        setStreamInfo({ name: data.name, title: data.title });
        setLoadingStream(false);
      })
      .catch((e) => {
        setError(e?.message || '获取直播流失败');
        setLoadingStream(false);
      });
  }, [currentSource]);

  const handleSelectSource = useCallback((s: WebLiveSource) => {
    setCurrentSource(s);
    const params = new URLSearchParams();
    params.set('platform', s.platform);
    params.set('roomId', s.roomId);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, []);

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

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      {/* 播放器区域 - 参考点播页面：flex-1 + min-h-0 防止溢出 */}
      <div className="relative flex-1 min-h-0">
        {loadingSources && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span>正在加载直播源…</span>
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
              切回原版网页直播
            </button>
          </div>
        )}
        {!loadingSources && !error && videoUrl && (
          <TeslaPlayer
            key={`${currentSource?.platform}-${currentSource?.roomId}`}
            url={videoUrl}
            title={fullTitle}
            live
            onBackToOriginal={backToOriginal}
            onPlaybackReady={() => setPlaybackNotice('')}
            onPlaybackError={(message) => {
              setPlaybackNotice(`当前直播流异常：${message}。可选择其他直播间或恢复初始项。`);
            }}
          />
        )}
        {playbackNotice && (
          <div className="pointer-events-none absolute inset-x-0 top-4 z-20 flex justify-center px-4">
            <div className="max-w-[92%] rounded-full bg-black/80 px-4 py-2 text-center text-xs text-white shadow-lg backdrop-blur">
              {playbackNotice}
            </div>
          </div>
        )}
        {!loadingSources && !error && !videoUrl && loadingStream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span>正在获取直播流…</span>
          </div>
        )}
      </div>

      {/* 源列表 - 底部固定高度，可滚动 */}
      <div className="flex-shrink-0 max-h-[42vh] border-t border-white/10 bg-zinc-950/95 backdrop-blur">
        <div className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm sm:px-4">
          <ArrowLeft
            className="h-4 w-4 cursor-pointer text-white/60 hover:text-white"
            onClick={() => router.back()}
          />
          <Radio className="h-4 w-4 text-rose-400" />
          <span className="font-medium">网页直播</span>
          <span className="text-white/40">({sources.length})</span>
          <div className="relative min-w-[180px] flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={searchKeyword}
              onChange={(event) => setSearchKeyword(event.target.value)}
              placeholder="搜索平台、主播或标题"
              className="w-full rounded bg-white/10 py-2 pl-7 pr-2 text-sm outline-none placeholder:text-white/40"
            />
          </div>
          <button
            type="button"
            onClick={restoreInitialSource}
            className="flex items-center gap-1 rounded bg-white/10 px-3 py-2 text-xs text-white/70 hover:bg-white/20 hover:text-white"
          >
            <RotateCcw className="h-3.5 w-3.5" />
            恢复
          </button>
        </div>
        <div className="overflow-y-auto px-2 pb-2" style={{ maxHeight: '32vh' }}>
          {filteredSources.length === 0 ? (
            <div className="py-4 text-center text-white/40">无源</div>
          ) : (
            <div className="grid grid-cols-2 gap-1.5 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-6 xl:grid-cols-8">
              {filteredSources.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => handleSelectSource(s)}
                  disabled={s.status === 'offline'}
                  className={`min-h-11 rounded px-2.5 py-2 text-left text-sm leading-5 transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                    currentSource?.key === s.key
                      ? 'bg-rose-600 text-white'
                      : 'bg-white/5 text-white/70 hover:bg-white/15'
                  }`}
                  title={`${s.platform} - ${s.name}`}
                >
                  <span className="block line-clamp-2 break-words">{s.name}</span>
                  <span className="mt-0.5 block truncate text-[10px] text-white/40">
                    {s.platform}{s.status === 'live' ? ' · 直播中' : s.status === 'offline' ? ' · 未开播' : ''}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function useMemoTitle(
  streamInfo: { name?: string; title?: string } | null,
  source: WebLiveSource | null
): string {
  if (streamInfo?.title && streamInfo?.name) {
    return `${streamInfo.name} - ${streamInfo.title}`;
  }
  if (streamInfo?.title) return streamInfo.title;
  if (streamInfo?.name) return streamInfo.name;
  return source?.name || '网页直播';
}

export default function TeslaWebLivePage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      }
    >
      <TeslaWebLivePageInner />
    </Suspense>
  );
}
