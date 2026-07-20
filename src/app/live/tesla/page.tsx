'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps */

import { ArrowLeft, Loader2, Radio, Search } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useCallback, useEffect, useMemo, useState } from 'react';

import TeslaPlayer from '@/components/TeslaPlayer';

/**
 * /live/tesla
 *
 * 特斯拉车机适配版直播页。接收与 /live 相同的 query 参数：
 *   - source, id (频道 id)
 *
 * 仅保留：源选择 + 频道列表 + 播放。不复制 EPG/收藏等高级功能。
 * 底层播放器为 TeslaPlayer（Broadway + Canvas）。
 */

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
  const [error, setError] = useState<string | null>(null);

  // 拉取源列表
  useEffect(() => {
    fetch('/api/live/sources')
      .then((r) => r.json())
      .then((data: any) => {
        // /api/live/sources 返回 { success, data }
        const rawList: LiveSource[] = data?.data || data?.sources || [];
        const list: LiveSource[] = rawList.filter((s: LiveSource) => !s.disabled);
        setSources(list);
        const matched = list.find((s) => s.key === initialSourceKey) || list[0];
        if (matched) setCurrentSource(matched);
        setLoadingSources(false);
      })
      .catch((e) => {
        setError(e?.message || '加载直播源失败');
        setLoadingSources(false);
      });
  }, []);

  // 拉取频道
  useEffect(() => {
    if (!currentSource) return;
    setLoadingChannels(true);
    setError(null);
    setChannels([]);
    setCurrentChannel(null);
    fetch(`/api/live/channels?source=${encodeURIComponent(currentSource.key)}`)
      .then((r) => r.json())
      .then((data: any) => {
        // /api/live/channels 返回 { success, data }
        const list: LiveChannel[] = data?.data || data?.channels || [];
        setChannels(list);
        const matched =
          list.find((c) => c.id === initialChannelId) || list[0] || null;
        if (matched) setCurrentChannel(matched);
        setLoadingChannels(false);
      })
      .catch((e) => {
        setError(e?.message || '加载频道失败');
        setLoadingChannels(false);
      });
  }, [currentSource]);

  // 计算播放 URL
  const playUrl = useMemo(() => {
    if (!currentChannel || !currentSource) return '';
    const proxyMode = currentSource.proxyMode || 'full';
    if (proxyMode === 'direct') return currentChannel.url;
    const allowCORS = proxyMode === 'm3u8-only' ? '&allowCORS=true' : '';
    return `/api/proxy/m3u8?url=${encodeURIComponent(currentChannel.url)}&moontv-source=${encodeURIComponent(currentSource.key)}${allowCORS}`;
  }, [currentChannel, currentSource]);

  const filteredChannels = useMemo(() => {
    if (!searchKeyword.trim()) return channels;
    const kw = searchKeyword.toLowerCase();
    return channels.filter(
      (c) =>
        c.name.toLowerCase().includes(kw) || c.group.toLowerCase().includes(kw)
    );
  }, [channels, searchKeyword]);

  const handleSelectChannel = useCallback((ch: LiveChannel) => {
    setCurrentChannel(ch);
    // 同步 URL
    const params = new URLSearchParams(window.location.search);
    params.set('source', currentSource?.key || '');
    params.set('id', ch.id);
    window.history.replaceState(null, '', `${window.location.pathname}?${params.toString()}`);
  }, [currentSource]);

  const backToOriginal = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    router.push(`/live?${params.toString()}`);
  }, [router, searchParams]);

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
              切回原版直播
            </button>
          </div>
        )}
        {!loadingSources && !error && currentChannel && playUrl && (
          <TeslaPlayer
            key={`${currentSource?.key}-${currentChannel.id}`}
            url={playUrl}
            title={`${currentSource?.name || ''} - ${currentChannel.name}`}
            poster={currentChannel.logo}
            live
            onBackToOriginal={backToOriginal}
          />
        )}
        {!loadingSources && !error && !currentChannel && (
          <div className="absolute inset-0 flex items-center justify-center text-white/60">
            请从下方列表选择频道
          </div>
        )}
      </div>

      {/* 频道列表 - 底部固定高度，可滚动 */}
      <div className="flex-shrink-0 max-h-[45vh] border-t border-white/10 bg-zinc-950/95 backdrop-blur">
        <div className="flex items-center gap-2 px-4 py-2">
          <ArrowLeft
            className="h-4 w-4 cursor-pointer text-white/60 hover:text-white"
            onClick={() => router.back()}
          />
          <select
            value={currentSource?.key || ''}
            onChange={(e) => {
              const next = sources.find((s) => s.key === e.target.value);
              if (next) setCurrentSource(next);
            }}
            className="rounded bg-white/10 px-2 py-1 text-sm outline-none"
          >
            {sources.map((s) => (
              <option key={s.key} value={s.key} className="bg-zinc-900">
                {s.name}
              </option>
            ))}
          </select>
          <div className="relative flex-1">
            <Search className="absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-white/40" />
            <input
              type="text"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              placeholder="搜索频道"
              className="w-full rounded bg-white/10 py-1 pl-7 pr-2 text-sm outline-none placeholder:text-white/40"
            />
          </div>
          <Radio className="h-4 w-4 text-rose-400" />
        </div>
        <div className="overflow-y-auto px-2 pb-2" style={{ maxHeight: '37vh' }}>
          {loadingChannels ? (
            <div className="flex items-center justify-center py-4 text-white/60">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载频道…
            </div>
          ) : filteredChannels.length === 0 ? (
            <div className="py-4 text-center text-white/40">无频道</div>
          ) : (
            <div className="grid grid-cols-2 gap-1 sm:grid-cols-3 md:grid-cols-4">
              {filteredChannels.map((ch) => (
                <button
                  key={ch.id}
                  type="button"
                  onClick={() => handleSelectChannel(ch)}
                  className={`truncate rounded px-2 py-1.5 text-left text-sm transition-colors ${
                    currentChannel?.id === ch.id
                      ? 'bg-rose-600 text-white'
                      : 'bg-white/5 text-white/70 hover:bg-white/15'
                  }`}
                  title={`${ch.group} - ${ch.name}`}
                >
                  {ch.name}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
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
