'use client';

/* eslint-disable no-console */

import Hls from 'hls.js';
import { Play, Pause, Loader2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

function formatTime(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${h > 0 ? `${h}:` : ''}${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

export default function TeslaTestPage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // 测试源列表
  const testSources = [
    { name: '测试流 1', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' },
    { name: '测试流 2', url: 'https://bitdash-a.akamaihd.net/content/sintel/hls/playlist.m3u8' },
  ];

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const source = testSources[0];
    console.log('[TestPlayer] 开始加载:', source.name, source.url);

    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        console.log('[TestPlayer] MANIFEST_PARSED');
        console.log('[TestPlayer] levels:', hls.levels.map((l) => `${l.width}x${l.height}`));
        setLoading(false);
        video.play().catch((e) => {
          console.error('[TestPlayer] 自动播放失败:', e);
          setError('自动播放被浏览器阻止，请手动点击播放');
        });
      });

      hls.on(Hls.Events.BUFFER_CREATED, () => console.log('[TestPlayer] BUFFER_CREATED'));
      hls.on(Hls.Events.BUFFER_FLUSHED, () => console.log('[TestPlayer] BUFFER_FLUSHED'));
      hls.on(Hls.Events.FRAG_LOADED, () => console.log('[TestPlayer] FRAG_LOADED'));
      hls.on(Hls.Events.FRAG_DECODED, () => console.log('[TestPlayer] FRAG_DECODED'));
      hls.on(Hls.Events.ERROR, (_evt, data) => {
        console.error('[TestPlayer] HLS ERROR:', data.type, data.details);
        if (data.fatal) {
          setError(`HLS 错误: ${data.details}`);
          setLoading(false);
        }
      });

      hls.loadSource(source.url);
      hls.attachMedia(video);
    } else {
      setError('浏览器不支持 hls.js');
      setLoading(false);
    }

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onLoadedMetadata = () => setDuration(video.duration || 0);
    const onPlay = () => setPlaying(true);
    const onPause = () => setPlaying(false);
    const onEnded = () => setPlaying(false);
    const onError = () => {
      console.error('[TestPlayer] Video ERROR:', video.error);
      setError(`视频错误 (code ${video.error?.code})`);
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('loadedmetadata', onLoadedMetadata);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('ended', onEnded);
    video.addEventListener('error', onError);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('ended', onEnded);
      video.removeEventListener('error', onError);
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      video.removeAttribute('src');
      video.load();
    };
  }, []);

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch((e) => {
        console.error('[TestPlayer] 播放失败:', e);
        setError('播放失败');
      });
    } else {
      video.pause();
    }
  };

  return (
    <div className="min-h-screen bg-black p-4">
      <h1 className="text-xl font-bold text-white mb-4">Tesla 播放器测试页</h1>
      <p className="text-sm text-white/60 mb-4">
        使用纯 hls.js + &lt;video&gt; 播放，不加任何复杂逻辑。查看控制台日志。
      </p>

      <div className="relative aspect-video bg-black rounded-lg overflow-hidden">
        <video
          ref={videoRef}
          className="w-full h-full"
          playsInline
        />

        {/* 加载状态 */}
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="flex items-center gap-3">
              <Loader2 className="h-6 w-6 animate-spin text-white" />
              <span className="text-white">加载中...</span>
            </div>
          </div>
        )}

        {/* 错误状态 */}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/80">
            <div className="text-center px-4">
              <p className="text-red-400 font-bold">{error}</p>
              <button
                onClick={() => window.location.reload()}
                className="mt-4 px-4 py-2 bg-white/10 hover:bg-white/20 rounded text-white"
              >
                重试
              </button>
            </div>
          </div>
        )}

        {/* 播放按钮 */}
        {!loading && !error && (
          <button
            onClick={togglePlay}
            className="absolute bottom-4 left-4 p-2 bg-white/20 hover:bg-white/30 rounded-full"
          >
            {playing ? <Pause className="h-6 w-6 text-white" /> : <Play className="h-6 w-6 text-white" />}
          </button>
        )}
      </div>

      {/* 时间显示 */}
      <div className="mt-4 text-white/80 text-sm">
        当前时间: {formatTime(currentTime)} / {formatTime(duration)}
      </div>

      {/* 测试源切换 */}
      <div className="mt-4 flex gap-2">
        {testSources.map((src, idx) => (
          <button
            key={idx}
            onClick={() => window.location.reload()}
            className="px-3 py-1 bg-white/10 hover:bg-white/20 rounded text-white text-sm"
          >
            {src.name}
          </button>
        ))}
      </div>

      {/* 控制台日志显示 */}
      <div className="mt-4 p-3 bg-zinc-900 rounded text-xs text-white/60 font-mono h-40 overflow-auto">
        控制台日志会显示在这里...
      </div>
    </div>
  );
}
