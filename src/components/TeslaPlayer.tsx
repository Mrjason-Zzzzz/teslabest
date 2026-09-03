'use client';

/* eslint-disable @typescript-eslint/no-explicit-any, @typescript-eslint/no-empty-function, no-empty */

import Hls from 'hls.js';
import {
  FastForward,
  Loader2,
  Maximize,
  Maximize2,
  MessageSquareText,
  Minimize,
  Pause,
  Play,
  RefreshCw,
  Rewind,
  Settings2,
  Volume2,
  VolumeX,
  WifiOff,
} from 'lucide-react';
import {
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { createAdFilteringPlaylistLoader } from '@/lib/hls/ad-filter';
import {
  bindTeslaMediaSession,
  claimTeslaAudioFocus,
  deferTeslaAudioFocusRelease,
  getTeslaAudioSession,
  setTeslaMediaSessionPosition,
  setTeslaMediaSessionState,
  unlockTeslaAudioSession,
  updateTeslaAudioSession,
} from '@/lib/tesla/audio-session';

import TeslaDanmakuOverlay, {
  type TeslaDanmakuChoices,
} from '@/components/TeslaDanmakuOverlay';
import { WebCodecsPlayer } from '@/components/webcodecs/WebCodecsPlayer';

type PlayMode = 'video' | 'webcodecs';

interface TeslaPlayerProps {
  url: string;
  title?: string;
  poster?: string;
  live?: boolean;
  defaultMode?: PlayMode;
  onBackToOriginal?: () => void;
  onEnded?: () => void;
  onPrevious?: () => void;
  onNext?: () => void;
  playRecordKey?: string;
  initialTime?: number;
  onProgress?: (currentTime: number, duration: number) => void;
  onPlaybackReady?: () => void;
  onPlaybackError?: (message: string) => void;
  resolveLiveSource?: () => Promise<string | undefined>;
  qualityOptions?: Array<{ id: string; label: string }>;
  quality?: string;
  onQualityChange?: (qualityId: string) => void;
  sourceKey?: string;
  danmakuTitle?: string;
  danmakuYear?: string;
  danmakuEpisodeNumber?: number;
  danmakuEpisodeLabel?: string;
  danmakuMediaType?: 'movie' | 'tv';
  danmakuTotalEpisodes?: number;
}

const PLAYBACK_RATES = [0.75, 1, 1.25, 1.5, 2];

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const hh = h > 0 ? `${h}:` : '';
  const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
  const ss = String(s).padStart(2, '0');
  return `${hh}${mm}:${ss}`;
}

// Persisting every three seconds caused hundreds of API requests per viewing
// session and competed with the audio scheduler on the vehicle browser.
const PROGRESS_SAVE_INTERVAL = 15000;

function getSavedProgress(key: string): number {
  if (typeof window === 'undefined') return 0;
  try {
    const saved = localStorage.getItem(`tesla_progress_${key}`);
    return saved ? parseFloat(saved) : 0;
  } catch {
    return 0;
  }
}

function saveProgress(key: string, time: number): void {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(`tesla_progress_${key}`, String(time));
  } catch {
    // ignore
  }
}

function getInitialMode(wanted: PlayMode): PlayMode {
  if (wanted === 'webcodecs' && WebCodecsPlayer.isSupported())
    return 'webcodecs';
  return 'video';
}

function getUrlKind(url: string): 'hls' | 'flv' | 'file' | 'unknown' {
  const clean = url.toLowerCase().split('#')[0];
  if (
    clean.includes('.m3u8') ||
    clean.includes('.m3u?') ||
    clean.includes('/m3u8')
  )
    return 'hls';
  if (/\.flv(?:\?|$)/.test(clean)) return 'flv';
  if (/\.(?:mp4|webm|mov|m4v|mkv|avi)(?:\?|$)/.test(clean)) return 'file';
  return 'unknown';
}

export default function TeslaPlayer({
  url,
  title,
  poster,
  live = false,
  defaultMode: defaultModeProp = 'webcodecs',
  onBackToOriginal,
  onEnded: onEndedCallback,
  onPrevious,
  onNext,
  playRecordKey,
  initialTime = 0,
  onProgress,
  onPlaybackReady,
  onPlaybackError,
  resolveLiveSource,
  qualityOptions = [],
  quality,
  onQualityChange,
  sourceKey,
  danmakuTitle,
  danmakuYear,
  danmakuEpisodeNumber,
  danmakuEpisodeLabel,
  danmakuMediaType,
  danmakuTotalEpisodes,
}: TeslaPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const wcPlayerRef = useRef<WebCodecsPlayer | null>(null);
  const hlsRef = useRef<any>(null);
  const hideControlsTimerRef = useRef<number | null>(null);
  const progressSaveTimerRef = useRef<number | null>(null);
  const bufferingTimeoutRef = useRef<number | null>(null);
  const canvasRafRef = useRef<number>(0);
  const playbackReadyReportedRef = useRef(false);
  const playbackErrorReportedRef = useRef(false);
  const userPausedRef = useRef(false);
  const liveStallRecoveryTimerRef = useRef<number | null>(null);
  const reconnectTimerRef = useRef<number | null>(null);
  const automaticReconnectAttemptsRef = useRef(0);
  const currentTimeRef = useRef(0);
  const durationRef = useRef(0);
  const playingRef = useRef(false);
  const scrubTimeRef = useRef<number | null>(null);
  const suppressClickRef = useRef(false);
  const seekGestureRef = useRef<{
    pointerId: number;
    startX: number;
    startY: number;
    startTime: number;
    width: number;
    active: boolean;
    cancelled: boolean;
    targetTime: number;
  } | null>(null);

  const [loading, setLoading] = useState(true);
  const [buffering, setBuffering] = useState(false);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [presentedVideoTime, setPresentedVideoTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [rate, setRate] = useState(1);
  const [showRateMenu, setShowRateMenu] = useState(false);
  const [showQualityMenu, setShowQualityMenu] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isWebFullscreen, setIsWebFullscreen] = useState(false);
  const [showControls, setShowControls] = useState(true);
  const [seekToTime, setSeekToTime] = useState<number | null>(null);
  const [showDebug] = useState(false);
  const [debugInfo, setDebugInfo] = useState<any>(null);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(true);
  const [audioUnlockRequired, setAudioUnlockRequired] = useState(true);
  const [engineLabel, setEngineLabel] = useState('Tesla 播放');
  const [networkOffline, setNetworkOffline] = useState(false);
  const [reconnectMessage, setReconnectMessage] = useState('');
  const [playbackSession, setPlaybackSession] = useState(0);
  const [scrubTime, setScrubTime] = useState<number | null>(null);
  const [seekGesturePreview, setSeekGesturePreview] = useState<{
    targetTime: number;
    delta: number;
  } | null>(null);
  const [danmakuEnabled, setDanmakuEnabled] = useState(false);
  const [danmakuStatus, setDanmakuStatus] = useState('');
  const [showDanmakuSettings, setShowDanmakuSettings] = useState(false);
  const [danmakuRows, setDanmakuRows] = useState(7);
  const [danmakuSpeed, setDanmakuSpeed] = useState(3);
  const [danmakuFontSize, setDanmakuFontSize] = useState(30);
  const [manualDanmakuAnimeId, setManualDanmakuAnimeId] = useState<
    number | null
  >(null);
  const [manualDanmakuEpisodeId, setManualDanmakuEpisodeId] = useState<
    number | null
  >(null);
  const [danmakuChoices, setDanmakuChoices] = useState<TeslaDanmakuChoices>({
    programmes: [],
    episodes: [],
    selectedAnimeId: null,
    selectedEpisodeId: null,
    automatic: true,
  });

  const [mode, setMode] = useState<PlayMode>(() =>
    getInitialMode(live ? 'webcodecs' : defaultModeProp)
  );

  useEffect(() => {
    const session = getTeslaAudioSession();
    setVolume(session.volume);
    setMuted(session.muted || !session.unlocked);
    setAudioUnlockRequired(!session.unlocked && !session.muted);
  }, []);

  useEffect(() => {
    if (live) return;
    try {
      // New Tesla-specific key: old desktop preferences must not silently
      // turn on a network-heavy overlay in the vehicle.
      setDanmakuEnabled(
        localStorage.getItem('tesla_danmaku_enabled') === 'true'
      );
      const storedRows = Number(
        localStorage.getItem('tesla_danmaku_rows') || '7'
      );
      const storedSpeed = Number(
        localStorage.getItem('tesla_danmaku_speed') || '3'
      );
      const storedFontSize = Number(
        localStorage.getItem('tesla_danmaku_font_size') || '30'
      );
      setDanmakuRows(
        Number.isFinite(storedRows)
          ? Math.max(3, Math.min(8, Math.round(storedRows)))
          : 7
      );
      setDanmakuSpeed(
        Number.isFinite(storedSpeed)
          ? Math.max(1, Math.min(5, Math.round(storedSpeed)))
          : 3
      );
      setDanmakuFontSize(
        Number.isFinite(storedFontSize)
          ? Math.max(18, Math.min(44, Math.round(storedFontSize)))
          : 30
      );
    } catch {
      setDanmakuEnabled(false);
    }
  }, [live]);

  useEffect(() => {
    if (live) return;
    try {
      localStorage.setItem('tesla_danmaku_rows', String(danmakuRows));
      localStorage.setItem('tesla_danmaku_speed', String(danmakuSpeed));
      localStorage.setItem('tesla_danmaku_font_size', String(danmakuFontSize));
    } catch {}
  }, [danmakuFontSize, danmakuRows, danmakuSpeed, live]);

  const toggleDanmaku = useCallback(() => {
    setDanmakuEnabled((current) => {
      const next = !current;
      try {
        localStorage.setItem('tesla_danmaku_enabled', String(next));
      } catch {}
      if (!next) {
        setDanmakuStatus('');
        setShowDanmakuSettings(false);
      }
      return next;
    });
  }, []);

  const handleDanmakuChoicesChange = useCallback(
    (choices: TeslaDanmakuChoices) => setDanmakuChoices(choices),
    []
  );

  const reportPlaybackReady = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    automaticReconnectAttemptsRef.current = 0;
    setReconnectMessage('');
    setNetworkOffline(false);
    if (playbackReadyReportedRef.current) return;
    playbackReadyReportedRef.current = true;
    onPlaybackReady?.();
  }, [onPlaybackReady]);

  const reportPlaybackError = useCallback(
    (message: string) => {
      if (playbackErrorReportedRef.current) return;
      playbackErrorReportedRef.current = true;
      onPlaybackError?.(message);
    },
    [onPlaybackError]
  );

  const requestReconnect = useCallback(
    (automatic = false) => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (!live && currentTimeRef.current > 0.5) {
        setSeekToTime(currentTimeRef.current);
      }
      playbackReadyReportedRef.current = false;
      playbackErrorReportedRef.current = false;
      setError(null);
      setLoading(true);
      setBuffering(true);
      setReconnectMessage(
        automatic ? '网络恢复，正在自动重新连接…' : '正在重新连接…'
      );
      // Claim before changing playbackSession so the silent media keeper bridges
      // the old and new audio graphs without yielding the vehicle audio session.
      void claimTeslaAudioFocus(title || 'Tesla 视频播放');
      setPlaybackSession((value) => value + 1);
    },
    [live, title]
  );

  const scheduleAutomaticReconnect = useCallback(
    (reason: string) => {
      if (typeof navigator !== 'undefined' && !navigator.onLine) {
        setNetworkOffline(true);
        setReconnectMessage('网络已断开，恢复后将自动继续播放');
        return;
      }
      if (reconnectTimerRef.current || userPausedRef.current) return;
      const attempt = ++automaticReconnectAttemptsRef.current;
      const delay = Math.min(
        12000,
        1500 * Math.pow(2, Math.min(attempt - 1, 3))
      );
      setReconnectMessage(
        `${reason}，${Math.ceil(delay / 1000)} 秒后自动重连（第 ${attempt} 次）`
      );
      reconnectTimerRef.current = window.setTimeout(
        () => requestReconnect(true),
        delay
      );
    },
    [requestReconnect]
  );

  useEffect(() => {
    const handleOffline = () => {
      setNetworkOffline(true);
      setBuffering(true);
      setReconnectMessage('网络已断开，恢复后将自动继续播放');
    };
    const handleOnline = () => {
      setNetworkOffline(false);
      requestReconnect(true);
    };
    window.addEventListener('offline', handleOffline);
    window.addEventListener('online', handleOnline);
    if (!navigator.onLine) handleOffline();
    return () => {
      window.removeEventListener('offline', handleOffline);
      window.removeEventListener('online', handleOnline);
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
    };
  }, [requestReconnect]);

  useEffect(() => {
    setMode(getInitialMode(live ? 'webcodecs' : defaultModeProp));
    setPresentedVideoTime(0);
    setError(null);
    setReconnectMessage('');
    playbackReadyReportedRef.current = false;
    playbackErrorReportedRef.current = false;
  }, [url, live, defaultModeProp]);

  const savedProgress = useMemo(() => {
    const legacyProgress = playRecordKey ? getSavedProgress(playRecordKey) : 0;
    return Math.max(
      legacyProgress,
      Number.isFinite(initialTime) ? initialTime : 0
    );
  }, [playRecordKey, initialTime]);

  useEffect(() => {
    if (savedProgress <= 0 || duration <= 0) return;
    const progressRatio = savedProgress / duration;
    if (progressRatio <= 0.05 || progressRatio >= 0.95) return;
    if (Math.abs(currentTimeRef.current - savedProgress) < 3) return;

    setSeekToTime(savedProgress);
    currentTimeRef.current = savedProgress;
    setCurrentTime(savedProgress);
    setPresentedVideoTime(savedProgress);
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.seek(savedProgress);
    } else if (videoRef.current) {
      videoRef.current.currentTime = savedProgress;
    }
  }, [savedProgress, duration, mode]);

  // ===== 播放控制（统一接口） =====

  const seek = useCallback(
    (t: number) => {
      currentTimeRef.current = t;
      if (mode === 'webcodecs') {
        wcPlayerRef.current?.seek(t);
      } else if (videoRef.current) {
        videoRef.current.currentTime = t;
      }
      setCurrentTime(t);
      setPresentedVideoTime(t);
    },
    [mode]
  );

  const togglePlay = useCallback(() => {
    const unlockAndRemember = async () => {
      const unlocked = await unlockTeslaAudioSession();
      if (!unlocked) return false;
      updateTeslaAudioSession({ unlocked: true, muted: false, volume });
      setMuted(false);
      setAudioUnlockRequired(false);
      return true;
    };

    if (mode === 'webcodecs') {
      const player = wcPlayerRef.current;
      if (!player) return;
      const session = getTeslaAudioSession();
      if (!session.unlocked || muted || !player.isAudioActive()) {
        unlockAndRemember()
          .then((unlocked) => unlocked && player.ensureAudible())
          .then(() => {
            if (!playingRef.current) player.play();
          })
          .catch(() => {});
        return;
      }
      void claimTeslaAudioFocus(title || 'Tesla 视频播放');
      player.togglePlay();
    } else if (videoRef.current) {
      const v = videoRef.current;
      const session = getTeslaAudioSession();
      if (!session.unlocked || v.muted || muted) {
        userPausedRef.current = false;
        unlockAndRemember().then((unlocked) => {
          if (!unlocked) return;
          v.muted = false;
          v.volume = volume;
          v.play().catch(() => {});
        });
        return;
      }
      if (v.paused) {
        userPausedRef.current = false;
        void claimTeslaAudioFocus(title || 'Tesla 视频播放');
        v.play().catch(() => {});
      } else {
        userPausedRef.current = true;
        v.pause();
        deferTeslaAudioFocusRelease(1200);
      }
    }
  }, [mode, muted, title, volume]);

  const toggleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.()?.catch(() => {});
    } else {
      document.exitFullscreen?.()?.catch(() => {});
    }
  }, []);

  const toggleWebFullscreen = useCallback(() => {
    setIsWebFullscreen((prev) => !prev);
  }, []);

  useEffect(() => {
    const handler = () => setIsFullscreen(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  const setPlaybackRate = useCallback(
    (r: number) => {
      if (mode === 'webcodecs') {
        // WebCodecs replays from the current media position with overlap-add
        // time stretching, so speed changes keep pitch and A/V in one timeline.
        wcPlayerRef.current?.setPlaybackRate(r);
        setRate(r);
        setShowRateMenu(false);
        return;
      }

      if (videoRef.current) {
        const media = videoRef.current as HTMLVideoElement & {
          webkitPreservesPitch?: boolean;
        };
        media.preservesPitch = true;
        media.webkitPreservesPitch = true;
        media.playbackRate = r;
      }
      setRate(r);
      setShowRateMenu(false);
    },
    [mode]
  );

  const toggleMute = useCallback(() => {
    const newMuted = !muted;
    updateTeslaAudioSession({ muted: newMuted, volume });
    if (mode === 'webcodecs') {
      wcPlayerRef.current?.setMuted(newMuted);
      if (!newMuted) {
        unlockTeslaAudioSession()
          .then((unlocked) => {
            if (!unlocked) return;
            updateTeslaAudioSession({ unlocked: true, muted: false, volume });
            wcPlayerRef.current?.setVolume(volume);
            return wcPlayerRef.current?.ensureAudible();
          })
          .catch(() => {});
      }
    } else if (videoRef.current) {
      videoRef.current.muted = newMuted;
      if (!newMuted) {
        unlockTeslaAudioSession().then((unlocked) => {
          if (!unlocked || !videoRef.current) return;
          updateTeslaAudioSession({ unlocked: true, muted: false, volume });
          videoRef.current.volume = volume;
          videoRef.current.muted = false;
          videoRef.current.play().catch(() => {});
        });
      }
    }
    setMuted(newMuted);
    setAudioUnlockRequired(false);
  }, [muted, volume, mode]);

  useEffect(() => {
    durationRef.current = duration;
  }, [duration]);

  useEffect(() => {
    playingRef.current = playing;
    setTeslaMediaSessionState(playing ? 'playing' : 'paused');
  }, [playing]);

  useEffect(() => {
    if (live) return;
    setTeslaMediaSessionPosition(duration, currentTime, rate);
  }, [currentTime, duration, live, rate]);

  useEffect(
    () =>
      bindTeslaMediaSession({
        title,
        poster,
        onPlay: () => {
          if (!playingRef.current) togglePlay();
        },
        onPause: () => {
          if (playingRef.current) togglePlay();
        },
        onPrevious: live ? undefined : onPrevious,
        onNext: live ? undefined : onNext,
        onSeekTo: live ? undefined : seek,
      }),
    [live, onNext, onPrevious, poster, seek, title, togglePlay]
  );

  const resetControlsTimer = useCallback(() => {
    if (hideControlsTimerRef.current)
      clearTimeout(hideControlsTimerRef.current);
    setShowControls(true);
    hideControlsTimerRef.current = window.setTimeout(() => {
      if (playing && !showRateMenu && !showQualityMenu) setShowControls(false);
    }, 3000);
  }, [playing, showRateMenu, showQualityMenu]);

  const persistProgress = useCallback(() => {
    if (live) return;
    const time = currentTimeRef.current;
    const total = durationRef.current;
    if (
      !Number.isFinite(time) ||
      !Number.isFinite(total) ||
      time < 1 ||
      total <= 0
    )
      return;
    if (playRecordKey) saveProgress(playRecordKey, time);
    onProgress?.(time, total);
  }, [live, onProgress, playRecordKey]);

  useEffect(() => {
    if (live) return;
    progressSaveTimerRef.current = window.setInterval(() => {
      if (playingRef.current) persistProgress();
    }, PROGRESS_SAVE_INTERVAL);

    const handlePageHide = () => persistProgress();
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'hidden') persistProgress();
    };
    window.addEventListener('pagehide', handlePageHide);
    document.addEventListener('visibilitychange', handleVisibilityChange);

    return () => {
      if (progressSaveTimerRef.current) {
        clearInterval(progressSaveTimerRef.current);
        progressSaveTimerRef.current = null;
      }
      window.removeEventListener('pagehide', handlePageHide);
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      persistProgress();
    };
  }, [live, persistProgress]);

  const beginSeekGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (live || durationRef.current <= 0 || event.button !== 0) return;
      const target = event.target as HTMLElement;
      if (target.closest('button, input, select, a, [data-no-seek-gesture]'))
        return;
      const width = Math.max(
        1,
        containerRef.current?.getBoundingClientRect().width || 1
      );
      seekGestureRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startTime: currentTimeRef.current,
        width,
        active: false,
        cancelled: false,
        targetTime: currentTimeRef.current,
      };
      event.currentTarget.setPointerCapture?.(event.pointerId);
      resetControlsTimer();
    },
    [live, resetControlsTimer]
  );

  const updateSeekGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = seekGestureRef.current;
      if (
        !gesture ||
        gesture.pointerId !== event.pointerId ||
        gesture.cancelled
      )
        return;
      const dx = event.clientX - gesture.startX;
      const dy = event.clientY - gesture.startY;
      if (!gesture.active) {
        if (Math.abs(dx) < 14 && Math.abs(dy) < 14) return;
        if (Math.abs(dy) > Math.abs(dx)) {
          gesture.cancelled = true;
          setSeekGesturePreview(null);
          return;
        }
        gesture.active = true;
        suppressClickRef.current = true;
      }
      event.preventDefault();
      const delta = Math.max(-300, Math.min(300, (dx / gesture.width) * 240));
      const targetTime = Math.max(
        0,
        Math.min(durationRef.current, gesture.startTime + delta)
      );
      gesture.targetTime = targetTime;
      setSeekGesturePreview({
        targetTime,
        delta: targetTime - gesture.startTime,
      });
    },
    []
  );

  const finishSeekGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = seekGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
      seekGestureRef.current = null;
      setSeekGesturePreview(null);
      if (gesture.active && !gesture.cancelled) {
        event.preventDefault();
        seek(gesture.targetTime);
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    },
    [seek]
  );

  const cancelSeekGesture = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const gesture = seekGestureRef.current;
      if (!gesture || gesture.pointerId !== event.pointerId) return;
      seekGestureRef.current = null;
      setSeekGesturePreview(null);
      suppressClickRef.current = false;
    },
    []
  );

  const clearBufferingTimeout = useCallback(() => {
    if (bufferingTimeoutRef.current) {
      clearTimeout(bufferingTimeoutRef.current);
      bufferingTimeoutRef.current = null;
    }
  }, []);

  const startBufferingTimeout = useCallback(() => {
    clearBufferingTimeout();
    bufferingTimeoutRef.current = window.setTimeout(
      () => {
        const message = live
          ? '直播持续缓冲，已尝试重新连接；当前线路可能不稳定'
          : '视频加载失败，请切换源或重试';
        setError(message);
        setLoading(false);
        reportPlaybackError(message);
      },
      live ? 45000 : 30000
    );
  }, [clearBufferingTimeout, live, reportPlaybackError]);

  // ===== 原生 video 回退模式初始化 =====
  useEffect(() => {
    if (mode === 'webcodecs') return;

    const container = containerRef.current;
    if (!container) return;

    let destroyed = false;
    let flvPlayer: any = null;
    let directFallbackTried = false;
    let liveRecoveryAttempts = 0;
    let visualWatchdogTimer: number | null = null;
    let videoFrameCallbackId = 0;
    let lastVideoFrameAt = Date.now();
    let lastVideoMediaTime = 0;
    let lastTotalVideoFrames = 0;
    const supportsVideoFrameCallback =
      typeof (HTMLVideoElement.prototype as any).requestVideoFrameCallback ===
      'function';

    const clearLiveStallRecovery = () => {
      if (liveStallRecoveryTimerRef.current) {
        clearTimeout(liveStallRecoveryTimerRef.current);
        liveStallRecoveryTimerRef.current = null;
      }
    };
    setLoading(true);
    setError(null);
    void claimTeslaAudioFocus(title || 'Tesla 视频播放');
    const audioSession = getTeslaAudioSession();
    const shouldStartMuted = audioSession.muted || !audioSession.unlocked;
    setVolume(audioSession.volume);
    setMuted(shouldStartMuted);
    setAudioUnlockRequired(!audioSession.unlocked && !audioSession.muted);

    // 创建 video 元素
    const videoEl = document.createElement('video') as HTMLVideoElement & {
      webkitPreservesPitch?: boolean;
    };
    videoEl.style.cssText =
      'position:absolute;top:0;left:0;width:100%;height:100%;object-fit:contain;z-index:1;';
    videoEl.muted = shouldStartMuted;
    videoEl.volume = audioSession.volume;
    videoEl.preservesPitch = true;
    videoEl.webkitPreservesPitch = true;
    videoEl.playsInline = true;
    videoEl.setAttribute('playsinline', '');
    videoEl.setAttribute('x-webkit-airplay', 'deny');
    videoEl.crossOrigin = 'anonymous';
    if (poster) videoEl.poster = poster;

    container.insertBefore(videoEl, container.firstChild);
    videoRef.current = videoEl;

    const onTimeUpdate = () => {
      if (destroyed) return;
      currentTimeRef.current = videoEl.currentTime;
      setCurrentTime(videoEl.currentTime);
    };
    const onDuration = () => {
      if (!destroyed && videoEl.duration > 0) {
        setDuration(videoEl.duration);
        setLoading(false);
      }
    };
    const onPlay = () => {
      if (!destroyed) {
        userPausedRef.current = false;
        setPlaying(true);
        const session = getTeslaAudioSession();
        setMuted(videoEl.muted);
        setAudioUnlockRequired(
          videoEl.muted && !session.muted && !session.unlocked
        );
        setBuffering(false);
        setLoading(false);
        clearBufferingTimeout();
        automaticReconnectAttemptsRef.current = 0;
      }
    };
    const onPause = () => {
      if (destroyed) return;
      if (live && !userPausedRef.current && !videoEl.ended) {
        // A network stall is buffering, not a user pause. Keep the control bar
        // in the playing state so the browser can resume as soon as data arrives.
        setPlaying(true);
        setBuffering(true);
        startBufferingTimeout();
        return;
      }
      setPlaying(false);
      setBuffering(false);
    };
    const onWaiting = () => {
      if (destroyed) return;
      if (!userPausedRef.current) setPlaying(true);
      setBuffering(true);
      startBufferingTimeout();

      if (live) {
        clearLiveStallRecovery();
        liveStallRecoveryTimerRef.current = window.setTimeout(() => {
          if (destroyed || userPausedRef.current || videoEl.readyState >= 3)
            return;
          liveRecoveryAttempts++;
          try {
            hlsRef.current?.startLoad(-1);
          } catch {}
          videoEl.play().catch(() => {});
        }, 8000);
      }
    };
    const onPlaying = () => {
      if (destroyed) return;
      clearLiveStallRecovery();
      liveRecoveryAttempts = 0;
      setPlaying(true);
      const session = getTeslaAudioSession();
      setMuted(videoEl.muted);
      setAudioUnlockRequired(
        videoEl.muted && !session.muted && !session.unlocked
      );
      setBuffering(false);
      clearBufferingTimeout();
      if (videoEl.videoWidth > 0 && videoEl.videoHeight > 0) {
        setLoading(false);
        reportPlaybackReady();
      }
    };
    const onEnded = () => {
      if (destroyed) return;
      setPlaying(false);
      clearBufferingTimeout();
      if (playRecordKey) saveProgress(playRecordKey, durationRef.current || 0);
      if (durationRef.current > 0)
        onProgress?.(durationRef.current, durationRef.current);
      setTimeout(() => onEndedCallback?.(), 500);
    };
    const onVideoError = () => {
      if (destroyed) return;
      const err = videoEl.error;
      if (err?.code === 2) {
        scheduleAutomaticReconnect('视频网络请求失败');
        return;
      }
      const message =
        '当前资源格式不受浏览器支持：' +
        (err?.message || err?.code || '未知错误');
      setError(message);
      reportPlaybackError(message);
    };

    videoEl.addEventListener('timeupdate', onTimeUpdate);
    videoEl.addEventListener('durationchange', onDuration);
    videoEl.addEventListener('play', onPlay);
    videoEl.addEventListener('pause', onPause);
    videoEl.addEventListener('waiting', onWaiting);
    videoEl.addEventListener('playing', onPlaying);
    videoEl.addEventListener('ended', onEnded);
    videoEl.addEventListener('error', onVideoError);

    const observeVideoFrame = (_now: number, metadata: any) => {
      if (destroyed) return;
      lastVideoFrameAt = Date.now();
      lastVideoMediaTime = metadata?.mediaTime ?? videoEl.currentTime;
      setLoading(false);
      setBuffering(false);
      reportPlaybackReady();
      videoFrameCallbackId = (videoEl as any).requestVideoFrameCallback(
        observeVideoFrame
      );
    };
    if (supportsVideoFrameCallback) {
      videoFrameCallbackId = (videoEl as any).requestVideoFrameCallback(
        observeVideoFrame
      );
    }

    visualWatchdogTimer = window.setInterval(() => {
      if (
        destroyed ||
        videoEl.paused ||
        userPausedRef.current ||
        videoEl.currentTime < 2
      )
        return;

      if (!supportsVideoFrameCallback) {
        const quality = (videoEl as any).getVideoPlaybackQuality?.();
        const totalFrames = quality?.totalVideoFrames || 0;
        if (totalFrames > lastTotalVideoFrames) {
          lastTotalVideoFrames = totalFrames;
          lastVideoFrameAt = Date.now();
          lastVideoMediaTime = videoEl.currentTime;
        }
      }

      const audioAdvancedWithoutFrames =
        videoEl.currentTime - lastVideoMediaTime > 3 &&
        Date.now() - lastVideoFrameAt > 6000;
      if (!audioAdvancedWithoutFrames) return;

      if (!live) {
        const message = '当前资源只有声音但没有可解码画面，正在自动换源';
        setError(message);
        reportPlaybackError(message);
        return;
      }

      liveRecoveryAttempts++;
      setBuffering(true);
      setReconnectMessage('检测到直播画面停止，正在恢复视频线路…');
      if (hlsRef.current && liveRecoveryAttempts <= 3) {
        try {
          hlsRef.current.recoverMediaError();
        } catch {}
        try {
          hlsRef.current.stopLoad();
          hlsRef.current.startLoad(-1);
        } catch {}
        videoEl.play().catch(() => {});
        lastVideoFrameAt = Date.now();
        lastVideoMediaTime = videoEl.currentTime;
      } else {
        scheduleAutomaticReconnect('直播有声音但画面已停止');
      }
    }, 3000);

    const attachDirectMedia = () => {
      if (destroyed) return;
      setEngineLabel('Tesla 播放');
      videoEl.src = url;
      videoEl.load();
      videoEl.play().catch(() => {});
    };

    const initializeVideoEngine = async () => {
      const kind = getUrlKind(url);

      if (kind === 'flv') {
        try {
          const flvModule: any = await import('flv.js');
          const flvjs = flvModule.default || flvModule;
          if (!destroyed && flvjs.isSupported()) {
            setEngineLabel('Tesla 播放');
            flvPlayer = flvjs.createPlayer({ type: 'flv', url, isLive: live });
            flvPlayer.attachMediaElement(videoEl);
            flvPlayer.load();
            flvPlayer.play().catch(() => {});
            return;
          }
        } catch (e) {
          console.warn('[TeslaPlayer] flv.js initialization failed:', e);
        }
        attachDirectMedia();
        return;
      }

      if ((kind === 'hls' || kind === 'unknown') && Hls.isSupported()) {
        setEngineLabel('Tesla 播放');
        const hls = new Hls({
          enableWorker: true,
          // The native fallback reads the same filtered playlist as the
          // WebCodecs path, so either player keeps an identical timeline.
          // hls.js exposes this constructor type internally; the loader keeps
          // the same runtime contract and is intentionally adapted here.
          pLoader: createAdFilteringPlaylistLoader(sourceKey, !live) as any,
          // Keep a small live edge cushion, but do not trade synchronization
          // for the large delay produced by a six-segment target.
          lowLatencyMode: false,
          autoStartLoad: true,
          startPosition: live ? -1 : seekToTime ?? savedProgress,
          liveSyncDurationCount: live ? 3 : undefined,
          liveMaxLatencyDurationCount: live ? 10 : undefined,
          maxLiveSyncPlaybackRate: live ? 1.03 : 1,
          maxBufferLength: live ? 24 : 45,
          maxMaxBufferLength: live ? 48 : 90,
          backBufferLength: live ? 8 : 20,
          fragLoadingTimeOut: 30000,
          manifestLoadingTimeOut: 20000,
          levelLoadingTimeOut: 20000,
          startLevel: 0,
          capLevelToPlayerSize: true,
          testBandwidth: false,
        });
        hlsRef.current = hls;

        hls.on(Hls.Events.ERROR, (_evt: any, data: any) => {
          if (destroyed || !data.fatal) return;

          if (live && liveRecoveryAttempts < 5) {
            liveRecoveryAttempts++;
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
              hls.startLoad(-1);
              return;
            }
            if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
              hls.recoverMediaError();
              return;
            }
          }

          // Extension-less MP4 endpoints are often mistaken for HLS. Try the
          // browser directly once before declaring the whole source broken.
          if (kind === 'unknown' && !directFallbackTried) {
            directFallbackTried = true;
            try {
              hls.destroy();
            } catch {}
            hlsRef.current = null;
            attachDirectMedia();
            return;
          }

          const message = 'HLS 资源无法播放：' + (data.details || data.type);
          if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
            scheduleAutomaticReconnect(message);
            return;
          }
          setError(message);
          reportPlaybackError(message);
        });

        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          videoEl.play().catch(() => {});
        });

        hls.attachMedia(videoEl);
        hls.loadSource(url);
        return;
      }

      if (
        kind === 'hls' &&
        videoEl.canPlayType('application/vnd.apple.mpegurl')
      ) {
        setEngineLabel('Tesla 播放');
      }
      attachDirectMedia();
    };

    initializeVideoEngine();

    return () => {
      destroyed = true;
      clearLiveStallRecovery();
      if (visualWatchdogTimer) clearInterval(visualWatchdogTimer);
      if (supportsVideoFrameCallback && videoFrameCallbackId) {
        try {
          (videoEl as any).cancelVideoFrameCallback(videoFrameCallbackId);
        } catch {}
      }
      if (canvasRafRef.current) cancelAnimationFrame(canvasRafRef.current);
      if (flvPlayer) {
        try {
          flvPlayer.destroy();
        } catch {}
        flvPlayer = null;
      }
      if (hlsRef.current) {
        try {
          hlsRef.current.destroy();
        } catch {}
        hlsRef.current = null;
      }
      if (videoEl) {
        videoEl.pause();
        videoEl.removeAttribute('src');
        videoEl.load();
        if (videoEl.parentNode) videoEl.parentNode.removeChild(videoEl);
      }
      videoRef.current = null;
      deferTeslaAudioFocusRelease(2500);
    };
  }, [
    url,
    mode,
    live,
    poster,
    playbackSession,
    reportPlaybackError,
    reportPlaybackReady,
    savedProgress,
    scheduleAutomaticReconnect,
    seekToTime,
    startBufferingTimeout,
    clearBufferingTimeout,
    title,
    sourceKey,
  ]);

  // ===== webcodecs 模式初始化 =====
  useEffect(() => {
    if (mode !== 'webcodecs' || !canvasRef.current) return;

    const kind = getUrlKind(url);
    if (kind === 'flv' || kind === 'file') {
      setMode('video');
      return;
    }

    let destroyed = false;
    let firstFrameWarningTimer: number | null = null;
    let firstFrameFailureTimer: number | null = null;
    setLoading(true);
    setError(null);

    try {
      const player = new WebCodecsPlayer(canvasRef.current, {
        liveHint: live,
        adFilterSource: sourceKey,
        resolveLiveSource,
        onTime: (t) => {
          if (!destroyed) {
            currentTimeRef.current = t;
            setCurrentTime(t);
          }
        },
        onVideoTime: (t) => {
          if (!destroyed) setPresentedVideoTime(t);
        },
        onDurationChange: (d) => {
          if (!destroyed) setDuration(d);
        },
        onStateChange: (s) => {
          if (destroyed) return;
          if (s === 'playing') {
            const session = getTeslaAudioSession();
            const audioActive = wcPlayerRef.current?.isAudioActive() ?? false;
            const shouldBeMuted = session.muted || !session.unlocked;
            setPlaying(true);
            setMuted(shouldBeMuted || !audioActive);
            setAudioUnlockRequired(!session.muted && !session.unlocked);
            if (session.unlocked && !session.muted && !audioActive) {
              wcPlayerRef.current?.ensureAudible().catch(() => {});
            }
            setBuffering(false);
            setLoading(false);
            clearBufferingTimeout();
            setEngineLabel('Tesla 播放');
            if (!live) reportPlaybackReady();
          } else if (s === 'paused') {
            setPlaying(false);
            setBuffering(false);
          } else if (s === 'buffering') {
            setBuffering(true);
            startBufferingTimeout();
          } else if (s === 'ended') {
            setPlaying(false);
            clearBufferingTimeout();
            if (playRecordKey)
              saveProgress(playRecordKey, durationRef.current || 0);
            if (durationRef.current > 0)
              onProgress?.(durationRef.current, durationRef.current);
            setTimeout(() => onEndedCallback?.(), 500);
          }
        },
        onFirstVideoFrame: () => {
          if (destroyed) return;
          if (firstFrameWarningTimer) {
            clearTimeout(firstFrameWarningTimer);
            firstFrameWarningTimer = null;
          }
          if (firstFrameFailureTimer) {
            clearTimeout(firstFrameFailureTimer);
            firstFrameFailureTimer = null;
          }
          // A delayed live stream may produce its first real Canvas frame
          // after the warning. Clear stale overlays immediately instead of
          // leaving a successful picture hidden behind a previous timeout.
          setError(null);
          setReconnectMessage('');
          setBuffering(false);
          setLoading(false);
          reportPlaybackReady();
        },
        onError: (msg) => {
          if (destroyed) return;
          console.warn('[TeslaPlayer] WebCodecs playback failed:', msg);
          // Keep all Tesla entrypoints on Canvas/WebCodecs. Native video can
          // become invisible while the vehicle is moving.
          setLoading(false);
          setBuffering(false);
          setError(msg);
          reportPlaybackError(msg);
        },
      });

      wcPlayerRef.current = player;
      player.setShowDebug(showDebug);
      const audioSession = getTeslaAudioSession();
      player.setVolume(audioSession.volume);
      player.setMuted(audioSession.muted || !audioSession.unlocked);

      const startPos = seekToTime !== null ? seekToTime : savedProgress;
      player.load(url, startPos).catch((e) => {
        if (destroyed) return;
        const message = e instanceof Error ? e.message : 'Tesla 播放器加载失败';
        console.warn('[TeslaPlayer] WebCodecs load failed:', e);
        setLoading(false);
        setBuffering(false);
        setError(message);
        reportPlaybackError(message);
      });

      // Live needs an explicit real-picture deadline because a channel can
      // keep returning audio/network data while the video track is dead. VOD
      // must not inherit that rule: slow MP4 range probing and sparse-keyframe
      // HLS are valid and are covered by the generic loading timeout instead.
      if (live) {
        firstFrameWarningTimer = window.setTimeout(() => {
          if (
            destroyed ||
            playbackReadyReportedRef.current ||
            (typeof navigator !== 'undefined' && !navigator.onLine)
          )
            return;
          setReconnectMessage('直播画面加载较慢，正在继续等待视频帧…');
          setBuffering(true);
        }, 30000);
        firstFrameFailureTimer = window.setTimeout(() => {
          if (
            destroyed ||
            playbackReadyReportedRef.current ||
            (typeof navigator !== 'undefined' && !navigator.onLine)
          )
            return;
          const message = '直播长时间未产生有效画面，请重试当前频道';
          console.warn('[TeslaPlayer]', message);
          setLoading(false);
          setBuffering(false);
          setError(message);
          reportPlaybackError(message);
        }, 90000);
      }

      const statsTimer = window.setInterval(() => {
        if (showDebug && !destroyed) {
          try {
            setDebugInfo(player.getStats());
          } catch {}
        }
      }, 500);

      return () => {
        destroyed = true;
        clearInterval(statsTimer);
        if (firstFrameWarningTimer) clearTimeout(firstFrameWarningTimer);
        if (firstFrameFailureTimer) clearTimeout(firstFrameFailureTimer);
        clearBufferingTimeout();
        player.destroy();
        wcPlayerRef.current = null;
      };
    } catch (e: any) {
      const message = e?.message || 'Tesla 播放器初始化失败';
      console.warn('[TeslaPlayer] WebCodecs initialization failed:', e);
      setLoading(false);
      setBuffering(false);
      setError(message);
      reportPlaybackError(message);
      return () => {
        destroyed = true;
      };
    }
    // Player instances are rebuilt only when their source identity changes.
    // Callback/state dependencies here would tear down the decoder mid-play.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [url, mode, live, playbackSession, sourceKey, resolveLiveSource]);

  useEffect(() => {
    wcPlayerRef.current?.setShowDebug(showDebug);
  }, [showDebug]);

  return (
    <div
      ref={containerRef}
      className={`relative w-full bg-black transition-all duration-300 ${
        isWebFullscreen
          ? 'fixed inset-0 z-[9999] h-screen w-screen rounded-none'
          : 'h-full'
      }`}
      style={
        isWebFullscreen
          ? {
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 9999,
              touchAction: 'pan-y',
            }
          : { touchAction: 'pan-y' }
      }
      onMouseMove={resetControlsTimer}
      onPointerDown={beginSeekGesture}
      onPointerMove={updateSeekGesture}
      onPointerUp={finishSeekGesture}
      onPointerCancel={cancelSeekGesture}
      onClick={(event) => {
        if (suppressClickRef.current) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        togglePlay();
      }}
    >
      {/* WebCodecs renders decoded VideoFrames directly to Canvas. */}
      {mode === 'webcodecs' && (
        <canvas
          ref={canvasRef}
          className='absolute inset-0 h-full w-full'
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            zIndex: 1,
          }}
        />
      )}

      {!live && (
        <TeslaDanmakuOverlay
          enabled={danmakuEnabled}
          title={danmakuTitle || title}
          year={danmakuYear}
          episodeNumber={danmakuEpisodeNumber}
          episodeLabel={danmakuEpisodeLabel}
          mediaType={danmakuMediaType}
          totalEpisodes={danmakuTotalEpisodes}
          currentTime={presentedVideoTime || currentTime}
          playing={playing}
          laneCount={danmakuRows}
          speed={danmakuSpeed}
          fontSize={danmakuFontSize}
          manualAnimeId={manualDanmakuAnimeId}
          manualEpisodeId={manualDanmakuEpisodeId}
          onStatusChange={setDanmakuStatus}
          onChoicesChange={handleDanmakuChoicesChange}
        />
      )}

      {/* 调试信息 */}
      {showDebug && debugInfo && mode === 'webcodecs' && (
        <div className='absolute top-2 left-2 z-20 bg-black/70 p-2 text-xs text-green-400 font-mono pointer-events-none'>
          <div>
            state: <b>{debugInfo.state}</b>
          </div>
          <div>
            render: {debugInfo.renderFps} fps decode: {debugInfo.decodeFps} fps
          </div>
          <div>
            queue: {debugInfo.queued} dropped: {debugInfo.dropped}
          </div>
          <div>
            {debugInfo.resolution} {debugInfo.codec}
          </div>
          <div>
            t={debugInfo.currentSec}s audioCtx={debugInfo.audioCtx}
          </div>
        </div>
      )}

      {(networkOffline || reconnectMessage) && !error && (
        <div className='pointer-events-none absolute inset-x-0 top-14 z-30 flex justify-center px-4'>
          <div className='flex items-center gap-2 rounded-full bg-black/85 px-4 py-2 text-xs text-white shadow-lg backdrop-blur'>
            {networkOffline ? (
              <WifiOff className='h-4 w-4 text-amber-400' />
            ) : (
              <RefreshCw className='h-4 w-4 animate-spin text-violet-400' />
            )}
            <span>
              {networkOffline ? '网络已断开，恢复后自动续播' : reconnectMessage}
            </span>
          </div>
        </div>
      )}

      {seekGesturePreview && !live && (
        <div className='pointer-events-none absolute inset-0 z-40 flex items-center justify-center'>
          <div className='rounded-2xl bg-black/80 px-6 py-4 text-center text-white shadow-2xl backdrop-blur'>
            <div className='flex items-center justify-center gap-2 text-lg font-semibold'>
              {seekGesturePreview.delta < 0 ? (
                <Rewind className='h-6 w-6' />
              ) : (
                <FastForward className='h-6 w-6' />
              )}
              <span>
                {seekGesturePreview.delta >= 0 ? '+' : ''}
                {Math.round(seekGesturePreview.delta)} 秒
              </span>
            </div>
            <div className='mt-1 text-sm text-white/70'>
              {formatTime(seekGesturePreview.targetTime)} /{' '}
              {formatTime(duration)}
            </div>
            <div className='mt-2 text-xs text-white/45'>松手跳转</div>
          </div>
        </div>
      )}

      {/* 加载状态 */}
      {loading && !error && (
        <div className='absolute inset-0 flex items-center justify-center bg-black/80 z-10'>
          <Loader2 className='h-10 w-10 animate-spin text-violet-500' />
        </div>
      )}

      {/* 缓冲状态 */}
      {buffering && !loading && (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none z-10'>
          <Loader2 className='h-8 w-8 animate-spin text-white/60' />
        </div>
      )}

      {/* 错误提示 */}
      {error && (
        <div className='absolute inset-0 flex items-center justify-center bg-black/80 z-20'>
          <div className='text-center px-4'>
            <p className='text-red-400 text-sm'>{error}</p>
            <div className='mt-3 flex gap-2 justify-center flex-wrap'>
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  requestReconnect(false);
                }}
                className='flex items-center gap-1 rounded bg-violet-500 px-4 py-1.5 text-sm text-white'
              >
                <RefreshCw className='h-4 w-4' />
                重新连接
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 暂停播放按钮 */}
      {!loading && !playing && !error && (
        <div className='absolute inset-0 flex items-center justify-center pointer-events-none z-10'>
          <button
            type='button'
            onClick={(e) => {
              e.stopPropagation();
              togglePlay();
            }}
            className='pointer-events-auto rounded-full bg-black/40 p-5 backdrop-blur-sm hover:bg-black/60 transition-all active:scale-95'
          >
            <Play className='h-10 w-10 text-white md:h-12 md:w-12' />
          </button>
        </div>
      )}

      {audioUnlockRequired && playing && (
        <div className='pointer-events-none absolute inset-x-0 bottom-20 z-20 flex justify-center px-4'>
          <button
            type='button'
            onClick={(event) => {
              event.stopPropagation();
              togglePlay();
            }}
            className='pointer-events-auto rounded-full bg-amber-500 px-4 py-2 text-sm font-medium text-black shadow-lg'
          >
            画面已播放，点击开启声音
          </button>
        </div>
      )}

      {/* 顶部标题栏 */}
      <div
        className={`pointer-events-none absolute inset-x-0 top-0 flex items-start justify-between bg-gradient-to-b from-black/60 to-transparent p-3 md:p-4 transition-opacity duration-200 z-10 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        <div className='pointer-events-auto'>
          <h1 className='text-sm md:text-base font-semibold drop-shadow max-w-[60vw] md:max-w-[70vw] truncate'>
            {title || '播放中'}
            {live && (
              <span className='ml-2 rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold uppercase'>
                LIVE
              </span>
            )}
          </h1>
        </div>
        <div className='pointer-events-auto flex items-center gap-1'>
          {!live && (
            <div className='rounded bg-violet-500/20 px-2 py-1 text-xs text-violet-300'>
              {engineLabel}
            </div>
          )}
        </div>
      </div>

      {/* 底部控制条 */}
      <div
        className={`pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/90 via-black/60 to-transparent px-2 pb-2 pt-12 md:px-3 md:pb-3 md:pt-16 transition-opacity duration-200 z-10 ${
          showControls ? 'opacity-100' : 'opacity-0'
        }`}
      >
        {/* 直播没有可拖动的固定时间轴。 */}
        {!live && (
          <div
            className='pointer-events-auto mb-1 md:mb-2'
            onClick={(event) => event.stopPropagation()}
            onPointerDown={(event) => event.stopPropagation()}
          >
            <input
              type='range'
              min={0}
              max={Math.max(duration, 1)}
              step={0.1}
              value={scrubTime ?? currentTime}
              onChange={(event) => {
                const value = Number(event.currentTarget.value);
                scrubTimeRef.current = value;
                setScrubTime(value);
              }}
              onPointerUp={(event) => {
                event.stopPropagation();
                const value =
                  scrubTimeRef.current ?? Number(event.currentTarget.value);
                seek(value);
                scrubTimeRef.current = null;
                setScrubTime(null);
              }}
              onKeyUp={(event) => {
                if (
                  event.key !== 'ArrowLeft' &&
                  event.key !== 'ArrowRight' &&
                  event.key !== 'Home' &&
                  event.key !== 'End'
                )
                  return;
                const value =
                  scrubTimeRef.current ?? Number(event.currentTarget.value);
                seek(value);
                scrubTimeRef.current = null;
                setScrubTime(null);
              }}
              className='h-10 w-full cursor-pointer accent-violet-500 touch-none'
              aria-label='播放进度'
            />
            {scrubTime !== null && (
              <div className='-mt-2 text-center text-xs text-white/80'>
                跳转至 {formatTime(scrubTime)}
              </div>
            )}
          </div>
        )}

        {/* 控制按钮行 */}
        <div className='pointer-events-auto flex items-center justify-between'>
          <div className='flex items-center gap-0.5 md:gap-1'>
            {!live && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  seek(Math.max(0, currentTime - 10));
                }}
                className='relative p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors'
                title='快退10秒'
              >
                <Rewind className='h-5 w-5' />
                <span className='absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-bold'>
                  10
                </span>
              </button>
            )}

            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                togglePlay();
              }}
              className='p-1.5 md:p-2 text-white hover:bg-white/10 rounded transition-colors'
            >
              {playing ? (
                <Pause className='h-6 w-6' />
              ) : (
                <Play className='h-6 w-6' />
              )}
            </button>

            {!live && (
              <button
                type='button'
                onClick={(e) => {
                  e.stopPropagation();
                  seek(Math.min(duration || 1, currentTime + 10));
                }}
                className='relative p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors'
                title='快进10秒'
              >
                <FastForward className='h-5 w-5' />
                <span className='absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 text-[9px] font-bold'>
                  10
                </span>
              </button>
            )}

            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                toggleMute();
              }}
              className='p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors'
            >
              {muted ? (
                <VolumeX className='h-5 w-5' />
              ) : (
                <Volume2 className='h-5 w-5' />
              )}
            </button>

            <div className='text-xs text-white/70 ml-1'>
              {live
                ? '直播中'
                : `${formatTime(currentTime)} / ${formatTime(duration)}`}
            </div>

            {/* Both engines expose the same 0.75x–2x menu. WebCodecs uses
                pitch-preserving overlap-add rather than playbackRate. */}
            {!live && (
              <div className='relative ml-1'>
                <button
                  type='button'
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRateMenu(!showRateMenu);
                  }}
                  className='min-h-11 min-w-14 rounded px-3 py-2 text-sm text-white/90 hover:bg-white/10 transition-colors'
                >
                  {rate}x
                </button>
                {showRateMenu && (
                  <div className='absolute bottom-full left-0 z-20 mb-2 min-w-[112px] rounded-xl border border-white/10 bg-black/95 p-1.5 shadow-xl backdrop-blur'>
                    {PLAYBACK_RATES.map((r) => (
                      <button
                        key={r}
                        type='button'
                        onClick={(e) => {
                          e.stopPropagation();
                          setPlaybackRate(r);
                        }}
                        className={`block min-h-11 w-full rounded-lg px-3 py-2 text-left text-sm ${
                          rate === r
                            ? 'bg-violet-500 text-white'
                            : 'text-gray-200 hover:bg-white/10'
                        }`}
                      >
                        {r}x
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}
            {!live && (
              <div className='ml-1 flex items-center gap-1'>
                <button
                  type='button'
                  onClick={(event) => {
                    event.stopPropagation();
                    toggleDanmaku();
                  }}
                  className={`flex items-center gap-1 rounded-lg text-xs ${
                    isWebFullscreen || isFullscreen
                      ? 'min-h-11 px-3'
                      : 'min-h-9 px-2'
                  } ${
                    danmakuEnabled
                      ? 'bg-violet-500 text-white'
                      : 'bg-white/10 text-white/80'
                  }`}
                  aria-pressed={danmakuEnabled}
                >
                  <MessageSquareText className='h-4 w-4' />
                  {danmakuEnabled ? '弹幕开' : '弹幕关'}
                </button>
                {danmakuEnabled && (
                  <button
                    type='button'
                    onClick={(event) => {
                      event.stopPropagation();
                      setShowDanmakuSettings((current) => !current);
                    }}
                    className={`flex items-center justify-center rounded-lg bg-white/10 text-white ${
                      isWebFullscreen || isFullscreen
                        ? 'min-h-11 min-w-11'
                        : 'min-h-9 min-w-9'
                    }`}
                    aria-label='弹幕设置'
                    aria-expanded={showDanmakuSettings}
                  >
                    <Settings2 className='h-4 w-4' />
                  </button>
                )}
              </div>
            )}
          </div>

          <div className='flex items-center gap-0.5 md:gap-1'>
            {live && qualityOptions.length > 0 && onQualityChange && (
              <div className='relative'>
                <button
                  type='button'
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowRateMenu(false);
                    setShowQualityMenu((visible) => !visible);
                  }}
                  className='min-h-11 min-w-16 rounded-lg px-3 py-2 text-xs font-medium text-white/90 hover:bg-white/10'
                  aria-label='切换直播清晰度'
                >
                  {qualityOptions.find((item) => item.id === quality)?.label ||
                    '自动'}
                </button>
                {showQualityMenu && (
                  <div className='absolute bottom-full right-0 z-30 mb-2 min-w-[132px] rounded-xl border border-white/10 bg-black/95 p-1.5 shadow-xl backdrop-blur'>
                    <div className='px-3 py-1.5 text-[11px] text-white/40'>
                      直播清晰度
                    </div>
                    {qualityOptions.map((item) => (
                      <button
                        key={item.id}
                        type='button'
                        onClick={(e) => {
                          e.stopPropagation();
                          setShowQualityMenu(false);
                          onQualityChange(item.id);
                        }}
                        className={`block min-h-11 w-full rounded-lg px-3 py-2 text-left text-sm ${
                          quality === item.id
                            ? 'bg-emerald-500 text-white'
                            : 'text-gray-200 hover:bg-white/10'
                        }`}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )}

            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                toggleWebFullscreen();
              }}
              className='p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors'
              title={isWebFullscreen ? '退出网页全屏' : '网页全屏'}
            >
              <Maximize2 className='h-5 w-5' />
            </button>

            <button
              type='button'
              onClick={(e) => {
                e.stopPropagation();
                toggleFullscreen();
              }}
              className='p-1.5 md:p-2 text-white/80 hover:text-white hover:bg-white/10 rounded transition-colors'
              title={isFullscreen ? '退出全屏' : '全屏'}
            >
              {isFullscreen ? (
                <Minimize className='h-5 w-5' />
              ) : (
                <Maximize className='h-5 w-5' />
              )}
            </button>
          </div>
        </div>
      </div>

      {!live && danmakuEnabled && showDanmakuSettings && (
        <aside
          className={`pointer-events-auto absolute left-3 z-30 overflow-y-auto rounded-2xl border border-violet-300/20 bg-[#110d20]/95 text-white shadow-2xl backdrop-blur ${
            isWebFullscreen || isFullscreen
              ? 'bottom-20 top-16 w-[min(340px,42vw)] p-5'
              : 'bottom-auto top-12 max-h-[calc(100%-3.5rem)] w-[min(300px,48%)] p-3'
          }`}
          onClick={(event) => event.stopPropagation()}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className={isWebFullscreen || isFullscreen ? 'mb-5' : 'mb-3'}>
            <h2 className='text-sm font-semibold md:text-base'>弹幕设置</h2>
            <p className='mt-1 text-xs text-white/50'>
              {danmakuStatus || '自动匹配影片与当前集数'}
            </p>
          </div>
          {[
            {
              label: '显示行数',
              value: danmakuRows,
              min: 3,
              max: 8,
              suffix: '行',
              set: setDanmakuRows,
            },
            {
              label: '字体大小',
              value: danmakuFontSize,
              min: 18,
              max: 44,
              suffix: 'px',
              set: setDanmakuFontSize,
            },
            {
              label: '滚动速度',
              value: danmakuSpeed,
              min: 1,
              max: 5,
              suffix: '档',
              set: setDanmakuSpeed,
            },
          ].map((item) => (
            <div
              key={item.label}
              className={`block text-sm text-white/80 ${
                isWebFullscreen || isFullscreen ? 'mb-5' : 'mb-2'
              }`}
            >
              <span className='mb-2 flex justify-between'>
                <span>{item.label}</span>
                <strong>
                  {item.value} {item.suffix}
                </strong>
              </span>
              <div className='grid grid-cols-[3rem_1fr_3rem] items-center gap-2'>
                <button
                  type='button'
                  className='min-h-12 rounded-xl bg-white/10 text-xl active:scale-95 disabled:opacity-30'
                  disabled={item.value <= item.min}
                  onClick={() => item.set(Math.max(item.min, item.value - 1))}
                  aria-label={`${item.label}减少`}
                >
                  −
                </button>
                <div className='rounded-xl bg-violet-500/20 py-3 text-center text-base font-semibold text-violet-100'>
                  {item.value} {item.suffix}
                </div>
                <button
                  type='button'
                  className='min-h-12 rounded-xl bg-white/10 text-xl active:scale-95 disabled:opacity-30'
                  disabled={item.value >= item.max}
                  onClick={() => item.set(Math.min(item.max, item.value + 1))}
                  aria-label={`${item.label}增加`}
                >
                  +
                </button>
              </div>
            </div>
          ))}
          <div className='mt-3 border-t border-white/10 pt-3'>
            <div className='mb-2 flex items-center justify-between gap-2'>
              <span className='text-xs font-medium text-white/70'>
                弹幕匹配
              </span>
              {(manualDanmakuAnimeId || manualDanmakuEpisodeId) && (
                <button
                  type='button'
                  onClick={() => {
                    setManualDanmakuAnimeId(null);
                    setManualDanmakuEpisodeId(null);
                  }}
                  className='min-h-9 rounded-lg bg-violet-500 px-3 text-xs font-medium text-white'
                >
                  恢复自动
                </button>
              )}
            </div>
            {danmakuChoices.programmes.length > 0 && (
              <div className='mb-3 max-h-32 space-y-1 overflow-y-auto'>
                {danmakuChoices.programmes.map((programme) => (
                  <button
                    key={programme.animeId}
                    type='button'
                    onClick={() => {
                      setManualDanmakuAnimeId(programme.animeId);
                      setManualDanmakuEpisodeId(null);
                    }}
                    className={`block min-h-10 w-full rounded-lg px-3 py-2 text-left text-xs ${
                      danmakuChoices.selectedAnimeId === programme.animeId
                        ? 'bg-violet-500 text-white'
                        : 'bg-white/10 text-white/75'
                    }`}
                  >
                    {programme.animeTitle}
                  </button>
                ))}
              </div>
            )}
            {danmakuChoices.episodes.length > 0 && (
              <div>
                <p className='mb-2 text-xs text-white/50'>手动选择弹幕集数</p>
                <div className='grid max-h-36 grid-cols-3 gap-1.5 overflow-y-auto'>
                  {danmakuChoices.episodes.map((episode) => (
                    <button
                      key={episode.episodeId}
                      type='button'
                      onClick={() =>
                        setManualDanmakuEpisodeId(episode.episodeId)
                      }
                      className={`min-h-10 rounded-lg px-2 py-1 text-xs ${
                        danmakuChoices.selectedEpisodeId === episode.episodeId
                          ? 'bg-violet-500 text-white'
                          : 'bg-white/10 text-white/75'
                      }`}
                      title={episode.episodeTitle}
                    >
                      {episode.episodeTitle}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        </aside>
      )}
    </div>
  );
}
