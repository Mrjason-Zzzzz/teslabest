/* eslint-disable @typescript-eslint/ban-ts-comment, @typescript-eslint/no-explicit-any, react-hooks/exhaustive-deps, no-console, @next/next/no-img-element */

'use client';

import { AlertCircle, Cloud, Heart, Keyboard, Loader2, Router, Sparkles, X } from 'lucide-react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useMemo, useRef, useState } from 'react';

import { getAuthInfoFromBrowserCookie } from '@/lib/auth';
import {
  clearDanmakuCacheByTitle,
  convertDanmakuFormat,
  getDanmakuById,
  getDanmakuFromCache,
  getEpisodes,
  initDanmakuModule,
  loadDanmakuDisplayState,
  loadDanmakuSettings,
  saveDanmakuDisplayState,
  saveDanmakuSettings,
  searchAnime,
} from '@/lib/danmaku/api';
import {
  getDanmakuAnimeId,
  getDanmakuSearchKeyword,
  getDanmakuSourceIndex,
  getManualDanmakuSelection,
  saveDanmakuAnimeId,
  saveDanmakuSearchKeyword,
  saveDanmakuSourceIndex,
  saveManualDanmakuSelection,
} from '@/lib/danmaku/selection-memory';
import type { DanmakuAnime, DanmakuComment, DanmakuSelection, DanmakuSettings } from '@/lib/danmaku/types';
import {
  deleteFavorite,
  deleteSkipConfig,
  generateStorageKey,
  getAllPlayRecords,
  getDanmakuFilterConfig,
  getEpisodeFilterConfig,
  getSkipConfig,
  isFavorited,
  migratePlayRecord,
  saveFavorite,
  savePlayRecord,
  saveSkipConfig,
  subscribeToDataUpdates,
} from '@/lib/db.client';
import { getDoubanDetail } from '@/lib/douban.client';
import { isEpisodeHiddenByFilter, normalizeEpisodeFilterConfig } from '@/lib/episode-filter';
import { appendSpecialSourceParam, isSpecialSourcesEnabledOnDevice } from '@/lib/special-source.client';
import {
  buildEpisodeProgressContentKey,
  loadLocalEpisodeProgress,
  pruneLocalEpisodeProgressStorage,
  saveLocalEpisodeProgress,
} from '@/lib/episode-progress';
import { isNetdiskSource, normalizeNetdiskSource } from '@/lib/netdisk/source';
import {
  getRecommendationCache,
  recommendationCacheKeys,
  setRecommendationCache,
} from '@/lib/recommendations/cache';
import { getIndexedDBVideoPlaybackUrl } from '@/lib/indexeddb-video-cache';
import {
  convertSubtitleFileToVttObjectUrl,
  CUSTOM_SUBTITLE_ACCEPT,
} from '@/lib/subtitle-converter';
import { getTMDBImageUrl } from '@/lib/tmdb.search';
import { DanmakuFilterConfig, EpisodeFilterConfig, SearchResult } from '@/lib/types';
import { base58Decode, getVideoResolutionFromM3u8, processImageUrl } from '@/lib/utils';
import { useEnableAIComments } from '@/hooks/useEnableAIComments';
import { useEnableComments } from '@/hooks/useEnableComments';
import { usePlaySync } from '@/hooks/usePlaySync';

import AIChatPanel from '@/components/AIChatPanel';
import AIComments from '@/components/AIComments';
import CorrectDialog from '@/components/CorrectDialog';
import DanmakuFilterSettings from '@/components/DanmakuFilterSettings';
import DetailPanel from '@/components/DetailPanel';
import DoubanComments from '@/components/DoubanComments';
import DownloadEpisodeSelector from '@/components/DownloadEpisodeSelector';
import Drawer from '@/components/Drawer';
import EpisodeSelector from '@/components/EpisodeSelector';
import PageLayout from '@/components/PageLayout';
import PansouSearch from '@/components/PansouSearch';
import ProxyImage from '@/components/ProxyImage';
import { useSite } from '@/components/SiteProvider';
import SmartRecommendations from '@/components/SmartRecommendations';
import Toast, { ToastProps } from '@/components/Toast';
import VideoCard from '@/components/VideoCard';

import { useDownload } from '@/contexts/DownloadContext';

// 扩展 HTMLVideoElement 类型以支持 hls 属性
declare global {
  interface HTMLVideoElement {
    hls?: any;
  }
}

// Wake Lock API 类型声明
interface WakeLockSentinel {
  released: boolean;
  release(): Promise<void>;
  addEventListener(type: 'release', listener: () => void): void;
  removeEventListener(type: 'release', listener: () => void): void;
}

interface PlayFallbackRecommendation {
  key: string;
  item: SearchResult;
  episodes?: number;
  sourceNames: string[];
  doubanId?: number;
}

interface SearchCachePayload {
  status: 'complete' | 'partial';
  results: SearchResult[];
  query: string;
  updatedAt: number;
}

type CustomSubtitleEngine = 'native' | 'jassub';
type PlaybackSourceBadge = 'local' | 'offline' | null;

interface CustomSubtitleState {
  name: string;
  format: string;
  episodeIndex: number;
  engine: CustomSubtitleEngine;
  url?: string;
  content?: string;
}

interface SourceSubtitleItem {
  label: string;
  url: string;
  fallbackUrl?: string;
  fallbackFormat?: string;
  format?: string;
  sourceFormat?: string;
  codec?: string;
  renderMode?: 'native' | 'jassub';
}

interface JassubSubtitleInstance {
  setTrack?: (content: string) => void | Promise<void>;
  setTrackByUrl?: (url: string) => void | Promise<void>;
  freeTrack?: () => void | Promise<void>;
  destroy?: () => void | Promise<void>;
}

const PLAYBACK_RATE_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3, 4];
const JASSUB_ASSET_BASE = '/assets/jassub';
const JASSUB_CJK_FONT_FAMILY = 'noto sans cjk sc';
const JASSUB_CJK_FONT_URL = `${JASSUB_ASSET_BASE}/NotoSansCJK-Regular.ttc`;
const ADVANCED_SUBTITLE_FORMATS = new Set(['ass', 'ssa']);
const PLAY_SHORTCUT_GROUPS = [
  {
    title: '播放控制',
    items: [
      { keys: ['空格'], description: '播放 / 暂停' },
      { keys: ['←', '→'], description: '快退 / 快进 10 秒' },
      { keys: ['↑', '↓'], description: '音量增加 / 减少' },
      { keys: ['F'], description: '切换全屏' },
    ],
  },
  {
    title: '剧集切换',
    items: [
      { keys: ['Alt', '←'], description: '上一集' },
      { keys: ['Alt', '→'], description: '下一集' },
    ],
  },
  {
    title: '倍速控制',
    items: [
      { keys: ['小键盘 +'], description: '提高一档倍速' },
      { keys: ['小键盘 -'], description: '降低一档倍速' },
      { keys: ['小键盘 /'], description: '恢复 1x' },
    ],
  },
];

function PlayPageClient() {
  const LOCAL_TRANSCODER_BASE_URL = 'http://localhost:19080';
  const router = useRouter();
  const searchParams = useSearchParams();
  const enableComments = useEnableComments();
  const enableAIComments = useEnableAIComments();
  const { addDownloadTask } = useDownload();
  const { siteName } = useSite();

  // 获取 Proxy M3U8 Token
  const proxyToken = typeof window !== 'undefined' ? process.env.NEXT_PUBLIC_PROXY_M3U8_TOKEN || '' : '';

  // 获取用户认证信息
  const authInfo = typeof window !== 'undefined' ? getAuthInfoFromBrowserCookie() : null;

  // 离线下载功能配置
  const enableOfflineDownload = typeof window !== 'undefined'
    ? (window as any).RUNTIME_CONFIG?.ENABLE_OFFLINE_DOWNLOAD || false
    : false;
  const hasOfflinePermission = authInfo?.role === 'owner' || authInfo?.role === 'admin';

  // -----------------------------------------------------------------------------
  // 状态变量（State）
  // -----------------------------------------------------------------------------
  const [loading, setLoading] = useState(true);
  const [loadingStage, setLoadingStage] = useState<
    'searching' | 'preferring' | 'fetching' | 'ready'
  >('searching');
  const [loadingMessage, setLoadingMessage] = useState('正在搜索播放源...');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<SearchResult | null>(null);

  // TMDB背景图
  const [tmdbBackdrop, setTmdbBackdrop] = useState<string | null>(null);

  // 收藏状态
  const [favorited, setFavorited] = useState(false);

  // 网盘搜索弹窗状态
  const [showPansouDialog, setShowPansouDialog] = useState(false);
  const [netdiskSearchEnabled, setNetdiskSearchEnabled] = useState(false);

  // AI问片状态
  const [showAIChat, setShowAIChat] = useState(false);
  const [aiEnabled, setAiEnabled] = useState(false);
  const [aiDefaultMessageWithVideo, setAiDefaultMessageWithVideo] = useState('');

  // 纠错弹窗状态
  const [showCorrectDialog, setShowCorrectDialog] = useState(false);

  // 详情面板状态
  const [showDetailPanel, setShowDetailPanel] = useState(false);

  // 快捷键说明弹窗状态
  const [showShortcutDialog, setShowShortcutDialog] = useState(false);

  useEffect(() => {
    if (!showShortcutDialog) {
      return (
  <div className="main-container">
    {/* 核心播放器区域（保留） */}
    <VideoPlayer />

    {/* 换源菜单（保留） */}
    <SourceSelector />

    {/* 测速组件（保留） */}
    <SpeedTestPanel />

    {/* ====================================================
        以下是冗余功能，全部注释掉，防止渲染浪费性能
        ==================================================== */}
    
    {/* {showAIChat && <AIChatPanel />} */}
    {/* {showDanmaku && <DanmakuEngine />} */}
    {/* <DownloadButton /> */}
    {/* <DoubanComments /> */}
    {/* <RightSideBar /> */}
    
  </div>
);
      return;
    }

    const handleShortcutDialogKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setShowShortcutDialog(false);
      }
    };

    document.addEventListener('keydown', handleShortcutDialogKeyDown);
    return () => {
      document.removeEventListener('keydown', handleShortcutDialogKeyDown);
    };
  }, [showShortcutDialog]);

  // 大屏设备检测（判断选集面板是否在右侧）
  const [isLargeScreen, setIsLargeScreen] = useState(false);

  // 检测是否为大屏设备
  useEffect(() => {
    const checkScreenSize = () => {
      setIsLargeScreen(window.innerWidth >= 768); // md断点
    };

    checkScreenSize();
    window.addEventListener('resize', checkScreenSize);
    return () => window.removeEventListener('resize', checkScreenSize);
  }, []);

  // 抽屉管理：打开指定抽屉时关闭其他抽屉
  const openDrawer = (drawerName: 'pansou' | 'aiChat' | 'correct' | 'detail') => {
    if (!isLargeScreen) {
      // 小屏设备不需要互斥
      switch (drawerName) {
        case 'pansou':
          setShowPansouDialog(true);
          break;
        case 'aiChat':
          setShowAIChat(true);
          break;
        case 'correct':
          setShowCorrectDialog(true);
          break;
        case 'detail':
          setShowDetailPanel(true);
          break;
      }
      return;
    }

    // 大屏设备：关闭其他抽屉
    setShowPansouDialog(drawerName === 'pansou');
    setShowAIChat(drawerName === 'aiChat');
    setShowCorrectDialog(drawerName === 'correct');
    setShowDetailPanel(drawerName === 'detail');
  };

  // 检查AI功能是否启用
  useEffect(() => {
    if (typeof window !== 'undefined') {
      const enabled =
        (window as any).RUNTIME_CONFIG?.AI_ENABLED &&
        (window as any).RUNTIME_CONFIG?.AI_ENABLE_PLAYPAGE_ENTRY;
      setAiEnabled(enabled);

      // 加载AI默认消息配置
      const defaultMsg = (window as any).RUNTIME_CONFIG?.AI_DEFAULT_MESSAGE_WITH_VIDEO;
      if (defaultMsg) {
        setAiDefaultMessageWithVideo(defaultMsg);
      }
    }
  }, []);

  useEffect(() => {
    if (typeof window !== 'undefined') {
      setNetdiskSearchEnabled(
        !!(window as any).RUNTIME_CONFIG?.NETDISK_SEARCH_ENABLED
      );
    }
  }, []);

  // 网页全屏状态 - 控制导航栏的显示隐藏
  const [isWebFullscreen, setIsWebFullscreen] = useState(false);
  // 原生全屏状态
  const [isNativeFullscreen, setIsNativeFullscreen] = useState(false);

  // 监听浏览器原生全屏事件
  useEffect(() => {
    const handleFullscreenChange = () => {
      const isFullscreen = !!document.fullscreenElement;
      setIsNativeFullscreen(isFullscreen);
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    document.addEventListener('mozfullscreenchange', handleFullscreenChange);
    document.addEventListener('MSFullscreenChange', handleFullscreenChange);

    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
      document.removeEventListener('mozfullscreenchange', handleFullscreenChange);
      document.removeEventListener('MSFullscreenChange', handleFullscreenChange);
    };
  }, []);

  // 组件卸载时清理定时器
  useEffect(() => {
    return () => {
      clearRefreshTimer();
    };
  }, []);

  // 跳过片头片尾配置
  const [skipConfig, setSkipConfig] = useState<{
    enable: boolean;
    intro_time: number;
    outro_time: number;
  }>({
    enable: false,
    intro_time: 0,
    outro_time: 0,
  });
  const skipConfigRef = useRef(skipConfig);
  useEffect(() => {
    skipConfigRef.current = skipConfig;
  }, [
    skipConfig,
    skipConfig.enable,
    skipConfig.intro_time,
    skipConfig.outro_time,
  ]);

  // 跳过检查的时间间隔控制
  const lastSkipCheckRef = useRef(0);

  // 去广告开关（从 localStorage 继承，默认 true）
  const [blockAdEnabled, setBlockAdEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('enable_blockad');
      if (v !== null) return v === 'true';
    }
    return true;
  });
  const blockAdEnabledRef = useRef(blockAdEnabled);
  useEffect(() => {
    blockAdEnabledRef.current = blockAdEnabled;
  }, [blockAdEnabled]);

  // 外部播放器去广告开关（独立状态，默认 false）
  const [externalPlayerAdBlock, setExternalPlayerAdBlock] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('external_player_adblock');
      if (v !== null) return v === 'true';
    }
    return false;
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      localStorage.setItem('external_player_adblock', String(externalPlayerAdBlock));
    }
  }, [externalPlayerAdBlock]);

  // 自定义去广告代码（从服务器获取并缓存）
  const customAdFilterCodeRef = useRef<string>('');

  // 初始化时获取自定义去广告代码
  useEffect(() => {
    const fetchAdFilterCode = async () => {
      if (typeof window === 'undefined') return;

      try {
        // 先从 localStorage 获取缓存的代码，立即可用
        const cachedCode = localStorage.getItem('custom_ad_filter_code_cache');
        const cachedVersion = localStorage.getItem('custom_ad_filter_version_cache');

        if (cachedCode) {
          customAdFilterCodeRef.current = cachedCode;
          console.log('使用缓存的去广告代码');
        }

        // 从 window.RUNTIME_CONFIG 获取版本号
        const version = (window as any).RUNTIME_CONFIG?.CUSTOM_AD_FILTER_VERSION || 0;

        // 如果版本号为 0，说明去广告未设置，清空缓存并跳过
        if (version === 0) {
          console.log('去广告代码未设置（版本 0），清空缓存');
          localStorage.removeItem('custom_ad_filter_code_cache');
          localStorage.removeItem('custom_ad_filter_version_cache');
          customAdFilterCodeRef.current = '';
          return;
        }

        // 如果版本号不一致或没有缓存，才获取完整代码
        if (!cachedVersion || parseInt(cachedVersion) !== version) {
          console.log('检测到去广告代码更新（版本 ' + version + '），获取最新代码');

          // 获取完整代码
          const fullResponse = await fetch('/api/ad-filter?full=true');
          if (!fullResponse.ok) {
            console.warn('获取完整去广告代码失败，使用缓存');
            return;
          }

          const { code } = await fullResponse.json();

          if (code) {
            localStorage.setItem('custom_ad_filter_code_cache', code);
            localStorage.setItem('custom_ad_filter_version_cache', version.toString());
            customAdFilterCodeRef.current = code;
          } else if (!cachedCode) {
            // 如果服务器没有代码且本地也没有缓存，清空缓存
            localStorage.removeItem('custom_ad_filter_code_cache');
            localStorage.removeItem('custom_ad_filter_version_cache');
          }
        } else {
          console.log('去广告代码已是最新版本（版本 ' + version + '）');
        }
      } catch (error) {
        console.error('获取去广告代码配置失败:', error);
        // 失败时已经使用了缓存，无需额外处理
      }
    };

    fetchAdFilterCode();
  }, []);

  // Anime4K超分相关状态
  const [webGPUSupported, setWebGPUSupported] = useState<boolean>(false);
  const [anime4kEnabled, setAnime4kEnabled] = useState<boolean>(false);
  const [anime4kMode, setAnime4kMode] = useState<string>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('anime4k_mode');
      if (v !== null) return v;
    }
    return 'ModeA';
  });
  const [anime4kScale, setAnime4kScale] = useState<number>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('anime4k_scale');
      if (v !== null) return parseFloat(v);
    }
    return 2.0;
  });
  const anime4kRef = useRef<any>(null);
  const anime4kEnabledRef = useRef(anime4kEnabled);
  const anime4kModeRef = useRef(anime4kMode);
  const anime4kScaleRef = useRef(anime4kScale);
  useEffect(() => {
    anime4kEnabledRef.current = anime4kEnabled;
    anime4kModeRef.current = anime4kMode;
    anime4kScaleRef.current = anime4kScale;
  }, [anime4kEnabled, anime4kMode, anime4kScale]);

  // 检测WebGPU支持
  useEffect(() => {
    const checkWebGPUSupport = async () => {
      if (typeof navigator === 'undefined' || !('gpu' in navigator)) {
        setWebGPUSupported(false);
        console.log('WebGPU不支持：浏览器不支持WebGPU API');
        return;
      }

      try {
        // 修复anime4k-webgpu库的buffer size限制问题
        // 在全局层面patch requestAdapter，确保所有adapter都有正确的limits
        const originalRequestAdapter = (navigator as any).gpu.requestAdapter.bind((navigator as any).gpu);

        (navigator as any).gpu.requestAdapter = async (options?: any) => {
          const adapter = await originalRequestAdapter(options);
          if (!adapter) return adapter;

          // 保存原始的requestDevice方法
          const originalRequestDevice = adapter.requestDevice.bind(adapter);

          // 重写requestDevice方法，添加必要的buffer size限制
          adapter.requestDevice = async (descriptor?: any) => {
            const adapterLimits = adapter.limits;

            // 合并用户提供的descriptor和我们需要的limits
            const enhancedDescriptor = {
              ...descriptor,
              requiredLimits: {
                ...descriptor?.requiredLimits,
                // 使用adapter支持的最大值，但不超过2GB
                maxBufferSize: Math.min(adapterLimits.maxBufferSize || 2147483648, 2147483648),
                maxStorageBufferBindingSize: Math.min(adapterLimits.maxStorageBufferBindingSize || 1073741824, 1073741824),
              }
            };

            console.log('WebGPU设备请求配置:', enhancedDescriptor.requiredLimits);
            return originalRequestDevice(enhancedDescriptor);
          };

          return adapter;
        };

        const adapter = await (navigator as any).gpu.requestAdapter();
        if (!adapter) {
          setWebGPUSupported(false);
          console.log('WebGPU不支持：无法获取GPU适配器');
          return;
        }

        setWebGPUSupported(true);
        console.log('WebGPU支持检测：✅ 支持');
        console.log('Adapter limits:', {
          maxBufferSize: adapter.limits.maxBufferSize,
          maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize
        });
      } catch (err) {
        setWebGPUSupported(false);
        console.log('WebGPU不支持：', err);
      }
    };

    checkWebGPUSupport();
  }, []);

  // 弹幕相关状态
  const [danmakuSettings, setDanmakuSettings] = useState<DanmakuSettings>(
    loadDanmakuSettings()
  );
  const [danmakuFilterConfig, setDanmakuFilterConfig] = useState<DanmakuFilterConfig | null>(null);
  const danmakuFilterConfigRef = useRef<DanmakuFilterConfig | null>(null);
  const [episodeFilterConfig, setEpisodeFilterConfig] = useState<EpisodeFilterConfig | null>(null);
  const episodeFilterConfigRef = useRef<EpisodeFilterConfig | null>(null);
  const [currentDanmakuSelection, setCurrentDanmakuSelection] =
    useState<DanmakuSelection | null>(null);
  const [danmakuEpisodesList, setDanmakuEpisodesList] = useState<
    Array<{ episodeId: number; episodeTitle: string }>
  >([]);
  const [danmakuLoading, setDanmakuLoading] = useState(false);
  const [danmakuCount, setDanmakuCount] = useState(0);
  const [danmakuOriginalCount, setDanmakuOriginalCount] = useState(0);
  const danmakuPluginRef = useRef<any>(null);
  const danmakuSettingsRef = useRef(danmakuSettings);

  // 弹幕显示状态的 ref，初始化时从 localStorage 读取
  const danmakuDisplayStateRef = useRef<boolean>(
    (() => {
      const saved = loadDanmakuDisplayState();
      return saved !== false; // null 或 true 都返回 true
    })()
  );

  // 弹幕热力图完全禁用开关（默认不禁用，即启用热力图功能）
  const [danmakuHeatmapDisabled, setDanmakuHeatmapDisabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('danmaku_heatmap_disabled');
      if (v !== null) return v === 'true';
    }
    return false; // 默认不禁用
  });
  const danmakuHeatmapDisabledRef = useRef(danmakuHeatmapDisabled);
  useEffect(() => {
    danmakuHeatmapDisabledRef.current = danmakuHeatmapDisabled;
  }, [danmakuHeatmapDisabled]);

  // 弹幕热力图开关（默认开启）
  const [danmakuHeatmapEnabled, setDanmakuHeatmapEnabled] = useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      const v = localStorage.getItem('danmaku_heatmap_enabled');
      if (v !== null) return v === 'true';
    }
    return true; // 默认开启
  });
  const danmakuHeatmapEnabledRef = useRef(danmakuHeatmapEnabled);
  useEffect(() => {
    danmakuHeatmapEnabledRef.current = danmakuHeatmapEnabled;
  }, [danmakuHeatmapEnabled]);

  // 多条弹幕匹配结果
  const [danmakuMatches, setDanmakuMatches] = useState<DanmakuAnime[]>([]);
  const [showDanmakuSourceSelector, setShowDanmakuSourceSelector] = useState(false);
  const [showDanmakuFilterSettings, setShowDanmakuFilterSettings] = useState(false);
  const [currentSearchKeyword, setCurrentSearchKeyword] = useState<string>(''); // 当前搜索使用的关键词
  const [toast, setToast] = useState<ToastProps | null>(null);
  const [isTranscoding, setIsTranscoding] = useState(false);

  useEffect(() => {
    danmakuSettingsRef.current = danmakuSettings;
  }, [danmakuSettings]);

  // 初始化弹幕模块（清理过期缓存）
  useEffect(() => {
    initDanmakuModule();
  }, []);

  // 加载弹幕过滤配置
  useEffect(() => {
    const loadFilterConfig = async () => {
      try {
        const config = await getDanmakuFilterConfig();
        if (config) {
          setDanmakuFilterConfig(config);
          danmakuFilterConfigRef.current = config;
        } else {
          // 如果没有配置，设置默认空配置
          const defaultConfig: DanmakuFilterConfig = { rules: [] };
          setDanmakuFilterConfig(defaultConfig);
          danmakuFilterConfigRef.current = defaultConfig;
        }

        // 加载集数过滤配置
        const episodeConfig = await getEpisodeFilterConfig();
        if (episodeConfig) {
          const normalizedEpisodeConfig = normalizeEpisodeFilterConfig(episodeConfig);
          setEpisodeFilterConfig(normalizedEpisodeConfig);
          episodeFilterConfigRef.current = normalizedEpisodeConfig;
        } else {
          const defaultEpisodeConfig: EpisodeFilterConfig = normalizeEpisodeFilterConfig();
          setEpisodeFilterConfig(defaultEpisodeConfig);
          episodeFilterConfigRef.current = defaultEpisodeConfig;
        }
      } catch (error) {
        console.error('加载过滤配置失败:', error);
      }
    };
    loadFilterConfig();
  }, []);

  // 同步弹幕过滤配置到ref
  useEffect(() => {
    danmakuFilterConfigRef.current = danmakuFilterConfig;
  }, [danmakuFilterConfig]);

  // 同步集数过滤配置到ref
  useEffect(() => {
    episodeFilterConfigRef.current = episodeFilterConfig;
  }, [episodeFilterConfig]);

  // 视频基本信息
  const [videoTitle, setVideoTitle] = useState(searchParams.get('title') || '');
  const [videoYear, setVideoYear] = useState(searchParams.get('year') || '');
  const [videoCover, setVideoCover] = useState('');
  const [videoDoubanId, setVideoDoubanId] = useState(0);

  // 更新浏览器标题
  useEffect(() => {
    if (videoTitle) {
      document.title = `${siteName} - ${videoTitle}`;
    } else {
      document.title = siteName;
    }
  }, [videoTitle, siteName]);
  // 豆瓣评分数据
  const [doubanRating, setDoubanRating] = useState<{
    value: number;
    count: number;
    star_count: number;
  } | null>(null);
  // 豆瓣额外信息
  const [doubanCardSubtitle, setDoubanCardSubtitle] = useState<string>('');
  const [doubanAka, setDoubanAka] = useState<string[]>([]);
  const [doubanYear, setDoubanYear] = useState<string>(''); // 从 pubdate 提取的年份

  // 纠错后的描述信息（用于显示，不触发 detail 更新）
  const [correctedDesc, setCorrectedDesc] = useState<string>('');
  const [netdiskTMDBMeta, setNetdiskTMDBMeta] = useState<{
    desc?: string;
    poster?: string;
    year?: string;
    tmdbId?: number;
  } | null>(null);
  const [pendingNetdiskTMDBData, setPendingNetdiskTMDBData] = useState<any | null>(null);

  // 当前源和ID - source 直接存储完整格式（如 'emby_wumei' 或 'emby'）
  const [currentSource, setCurrentSource] = useState(normalizeNetdiskSource(searchParams.get('source')) || '');
  const [currentId, setCurrentId] = useState(searchParams.get('id') || '');
  const [fileName] = useState(searchParams.get('fileName') || ''); // 小雅源：用户点击的文件名
  const isDirectPlay = currentSource === 'directplay';

  useEffect(() => {
    setNetdiskTMDBMeta(null);
    setPendingNetdiskTMDBData(null);
  }, [currentSource, currentId]);

  // 解析 source 参数以获取 embyKey（仅用于 API 调用）
  const parseSourceForApi = (source: string): { source: string; embyKey?: string } => {
    source = normalizeNetdiskSource(source);
    if (source.startsWith('emby_')) {
      const key = source.substring(5);
      return { source: 'emby', embyKey: key };
    }
    return { source };
  };

  const isLazyDetailSource = (source?: string) => {
    if (!source) return false;
    return (
      source === 'openlist' ||
      source === 'emby' ||
      source.startsWith('emby_') ||
      source.startsWith('script:')
    );
  };

  const isM3u8LikeUrl = (url?: string) => {
    if (!url) return false;
    const normalizedUrl = url.toLowerCase();
    return normalizedUrl.includes('.m3u8') || normalizedUrl.includes('/m3u8/');
  };

  const buildAbsoluteUrl = (url: string) => {
    if (url.startsWith('http://') || url.startsWith('https://')) {
      return url;
    }
    return `${window.location.origin}${url.startsWith('/') ? '' : '/'}${url}`;
  };

  // 搜索所需信息
  const [searchTitle] = useState(searchParams.get('stitle') || '');
  const [searchType] = useState(searchParams.get('stype') || '');
  const [initialEpisodeProgressTitle] = useState(
    searchTitle || searchParams.get('title') || ''
  );
  const [initialEpisodeProgressYear] = useState(
    searchParams.get('year') || ''
  );
  const episodeProgressContentKey = useMemo(
    () =>
      buildEpisodeProgressContentKey({
        doubanId: videoDoubanId || detail?.douban_id,
        tmdbId: detail?.tmdb_id,
        title: initialEpisodeProgressTitle,
        year: initialEpisodeProgressYear,
        searchType,
      }),
    [
      detail?.douban_id,
      detail?.tmdb_id,
      initialEpisodeProgressTitle,
      initialEpisodeProgressYear,
      searchType,
      videoDoubanId,
    ]
  );

  // 是否需要优选
  const [needPrefer, setNeedPrefer] = useState(
    searchParams.get('prefer') === 'true'
  );
  const needPreferRef = useRef(needPrefer);
  useEffect(() => {
    needPreferRef.current = needPrefer;
  }, [needPrefer]);
  // 集数相关
  const [currentEpisodeIndex, setCurrentEpisodeIndex] = useState(() => {
    const episodeParam = searchParams.get('episode');
    if (episodeParam) {
      const episode = parseInt(episodeParam, 10);
      return episode > 0 ? episode - 1 : 0; // URL 中是 1-based，内部是 0-based
    }
    return 0;
  });

  // 监听 URL 参数变化，更新集数索引（用于房员跟随换集）
  useEffect(() => {
    const episodeParam = searchParams.get('episode');
    if (episodeParam) {
      const episode = parseInt(episodeParam, 10);
      const newIndex = episode > 0 ? episode - 1 : 0;
      console.log('[PlayPage] Checking episode from URL:', { urlEpisode: episode, currentIndex: currentEpisodeIndex, newIndex });
      if (newIndex !== currentEpisodeIndex) {
        console.log('[PlayPage] URL episode changed, updating index to:', newIndex);
        setCurrentEpisodeIndex(newIndex);
      }
    }
  }, [searchParams, currentEpisodeIndex]);

  // 监听集数变化，移除已显示的跳转按钮
  useEffect(() => {
    // 移除已显示的跳转按钮
    if (playRecordJumpLayerRef.current && artPlayerRef.current) {
      try {
        artPlayerRef.current.layers.remove('play-record-jump');
        playRecordJumpLayerRef.current = null;
      } catch (err) {
        console.warn('[PlayRecordJump] 移除跳转按钮失败:', err);
      }
    }

    // 用户主动切集/自动下一集时不再弹“上次播放到 xx”。
    // 首次进入页面仍保留检查能力，用于展示继续播放提示。
    if (suppressPlayRecordJumpOnNextEpisodeChangeRef.current) {
      playRecordJumpInitialCheckRef.current = false;
      playRecordJumpDismissedRef.current = true;
      suppressPlayRecordJumpOnNextEpisodeChangeRef.current = false;
      return;
    }

    playRecordJumpInitialCheckRef.current = true;
    playRecordJumpDismissedRef.current = false;
  }, [currentEpisodeIndex]);

  // 监听 URL 参数变化，当切换到不同视频时重新加载页面
  useEffect(() => {
    const urlTitle = searchParams.get('title') || '';
    const reloadParam = searchParams.get('_reload');

    // 只在有 _reload 参数且标题变化时才重新加载页面
    // 这样可以避免初始化、API返回、房间同步等场景的误触发
    // 只有用户主动点击推荐时才会添加 _reload 参数
    if (reloadParam && urlTitle && urlTitle !== videoTitle && !isSourceChangingRef.current) {
      console.log('[PlayPage] User clicked recommendation, reloading page');
      window.location.reload();
    }

    // 重置换源标记
    isSourceChangingRef.current = false;
  }, [searchParams, videoTitle]);

  const currentSourceRef = useRef(currentSource);
  const currentIdRef = useRef(currentId);
  const videoTitleRef = useRef(videoTitle);
  const videoYearRef = useRef(videoYear);
  const detailRef = useRef<SearchResult | null>(detail);
  const currentEpisodeIndexRef = useRef(currentEpisodeIndex);
  const isSourceChangingRef = useRef(false); // 标记是否正在换源

  // 同步最新值到 refs
  useEffect(() => {
    currentSourceRef.current = currentSource;
    currentIdRef.current = currentId;
    detailRef.current = detail;
    currentEpisodeIndexRef.current = currentEpisodeIndex;
    videoTitleRef.current = videoTitle;
    videoYearRef.current = videoYear;
  }, [
    currentSource,
    currentId,
    detail,
    currentEpisodeIndex,
    videoTitle,
    videoYear,
  ]);

  // 当集数改变时，重置下集预缓存标记
  useEffect(() => {
    nextEpisodePreCacheTriggeredRef.current = false;
    nextEpisodeDanmakuPreloadTriggeredRef.current = false;
    // 清理之前的预缓存 HLS 实例
    if (nextEpisodePreCacheHlsRef.current) {
      try {
        nextEpisodePreCacheHlsRef.current.destroy();
      } catch (e) {
        console.error('清理预缓存 HLS 实例失败:', e);
      }
      nextEpisodePreCacheHlsRef.current = null;
    }
  }, [currentEpisodeIndex]);

  // 监听剧集切换，自动加载对应的弹幕
  const lastLoadedEpisodeIndexForDanmakuRef = useRef<number | null>(null);
  const loadingDanmakuEpisodeIdRef = useRef<number | null>(null);

  useEffect(() => {
    // 等待初始化完成（播放记录恢复完成）
    if (loading) {
      return;
    }

    if (isDirectPlay) {
      return;
    }

    // 检查是否禁用了自动加载弹幕
    if (isDanmakuAutoLoadDisabled()) {
      console.log('[弹幕] 已禁用自动加载弹幕，跳过自动加载');
      setShowDanmakuSourceSelector(false);
      setDanmakuLoading(false);
      return;
    }

    // 检查集数是否有效且是否已改变
    if (currentEpisodeIndex < 0 || !videoTitle) {
      return;
    }

    // 如果集数已经加载过，跳过
    if (lastLoadedEpisodeIndexForDanmakuRef.current === currentEpisodeIndex) {
      return;
    }

    // 标记当前集数已加载
    lastLoadedEpisodeIndexForDanmakuRef.current = currentEpisodeIndex;

    console.log(`[弹幕] 剧集切换到第 ${currentEpisodeIndex + 1} 集，自动加载弹幕`);

    // 立即清空当前弹幕（使用 reset 方法，不触发显示/隐藏事件）
    if (danmakuPluginRef.current) {
      danmakuPluginRef.current.reset();
      setDanmakuCount(0);
    }

    // 自动加载弹幕的逻辑
    const loadDanmakuForCurrentEpisode = async () => {
      const title = videoTitleRef.current;
      if (!title) {
        console.warn('[弹幕] 视频标题为空，无法加载弹幕');
        return;
      }

      const episodeIndex = currentEpisodeIndexRef.current;
      console.log(`[弹幕] 开始加载第 ${episodeIndex + 1} 集弹幕`);

      // 先尝试从 IndexedDB 缓存加载
      try {
        const cachedData = await getDanmakuFromCache(title, episodeIndex);
        if (cachedData && cachedData.comments.length > 0) {
          console.log(`[弹幕] 使用缓存: title="${title}", episodeIndex=${episodeIndex}, 数量=${cachedData.comments.length}`);

          // 如果弹幕插件还未初始化，等待初始化
          if (!danmakuPluginRef.current) {
            console.log('[弹幕] 弹幕插件未初始化，等待初始化...');
            // 缓存命中但插件未初始化，不执行搜索，等待下次触发
            return;
          }

          setDanmakuLoading(true);

          // 转换弹幕格式
          let danmakuData = convertDanmakuFormat(cachedData.comments);

          // 手动应用过滤规则
          const filterConfig = danmakuFilterConfigRef.current;
          if (filterConfig && filterConfig.rules.length > 0) {
            const originalCount = danmakuData.length;
            danmakuData = danmakuData.filter((danmu) => {
              for (const rule of filterConfig.rules) {
                if (!rule.enabled) continue;
                try {
                  if (rule.type === 'normal') {
                    if (danmu.text.includes(rule.keyword))
