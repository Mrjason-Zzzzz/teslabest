'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { ArrowLeft, Loader2, Radio } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useState } from 'react';

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
  const [error, setError] = useState<string | null>(null);

  // 拉取源列表
  useEffect(() => {
    fetch('/api/web-live/sources')
      .then((r) => r.json())
      .then((data: any) => {
        const list: WebLiveSource[] = data?.sources || [];
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

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/web-live?${params.toString()}`);
  }, [router, searchParams]);

  const fullTitle = useMemoTitle(streamInfo, currentSource);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="relative flex-1">
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
          />
        )}
        {!loadingSources && !error && !videoUrl && loadingStream && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3">
            <Loader2 className="h-8 w-8 animate-spin" />
            <span>正在获取直播流…</span>
          </div>
        )}
      </div>

      {/* 源列表 */}
      <div className="max-h-[35vh] border-t border-white/10 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-2 px-4 py-2 text-sm">
          <ArrowLeft
            className="h-4 w-4 cursor-pointer text-white/60 hover:text-white"
            onClick={() => router.back()}
          />
          <Radio className="h-4 w-4 text-rose-400" />
          <span className="font-medium">网页直播</span>
          <span className="text-white/40">({sources.length})</span>
        </div>
        <div className="max-h-[28vh] overflow-y-auto px-2 pb-2">
          {sources.length === 0 ? (
            <div className="py-4 text-center text-white/40">无源</div>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
              {sources.map((s) => (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => handleSelectSource(s)}
                  className={`truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${
                    currentSource?.key === s.key
                      ? 'bg-rose-600 text-white'
                      : 'bg-white/5 text-white/70 hover:bg-white/15'
                  }`}
                  title={`${s.platform} - ${s.name}`}
                >
                  {s.name}
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
