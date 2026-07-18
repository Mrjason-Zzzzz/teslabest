'use client';

/* eslint-disable @typescript-eslint/no-explicit-any */

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

import TeslaPlayer from '@/components/TeslaPlayer';

/**
 * /play/tesla-test
 *
 * 独立测试页，绕开 /api/source-detail，直接用一个公开的 H.264 + TS 测试 m3u8。
 * 用来排查「Tesla 播放器本身能不能用」vs「/api/source-detail 数据有没有问题」。
 *
 * 默认测试源（都是公开 H.264 TS 切片）：
 *   - Mux TS 测试流（推荐）
 *   - Apple bipbop TS（备用）
 *
 * 也可以通过 ?url= 自定义传入测试源。
 */

const DEFAULT_TEST_STREAMS = [
  {
    name: 'Mux TS 2s',
    url: 'https://test-streams.mux.dev/ts_2s/playlist.m3u8',
  },
  {
    name: 'Apple bipbop TS',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/img_bipbop_adv_example_ts/master.m3u8',
  },
];

function TeslaTestPageInner() {
  const searchParams = useSearchParams();
  const customUrl = searchParams.get('url') || '';
  const [currentUrl, setCurrentUrl] = useState(customUrl || DEFAULT_TEST_STREAMS[0].url);
  const [logs, setLogs] = useState<string[]>([]);

  useEffect(() => {
    document.title = 'Tesla 播放器测试';
  }, []);

  // 监听全局错误和 console，方便用户复制给我排查
  useEffect(() => {
    const pushLog = (msg: string) => {
      setLogs((prev) => [...prev.slice(-50), `${new Date().toISOString().slice(11, 19)} ${msg}`]);
    };
    const onError = (e: ErrorEvent) => {
      pushLog(`[error] ${e.message} @ ${e.filename}:${e.lineno}`);
    };
    const onUnhandled = (e: PromiseRejectionEvent) => {
      const reason = e.reason;
      const msg = reason?.message || String(reason);
      pushLog(`[unhandledrejection] ${msg}`);
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onUnhandled);

    // 拦截 console.error / console.warn
    const origError = console.error.bind(console);
    const origWarn = console.warn.bind(console);
    console.error = (...args: any[]) => {
      pushLog(`[console.error] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`);
      origError(...args);
    };
    console.warn = (...args: any[]) => {
      pushLog(`[console.warn] ${args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')}`);
      origWarn(...args);
    };

    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onUnhandled);
      console.error = origError;
      console.warn = origWarn;
    };
  }, []);

  return (
    <div className="fixed inset-0 flex flex-col bg-black text-white">
      <div className="border-b border-white/10 bg-zinc-950 px-4 py-3">
        <h1 className="text-base font-semibold">Tesla 播放器测试页</h1>
        <p className="mt-1 text-xs text-white/60">
          绕开 /api/source-detail，直接用公开 m3u8 测试 Broadway.js 播放器本身能否工作。
        </p>
      </div>

      <div className="border-b border-white/10 bg-zinc-900 px-4 py-2 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-white/60">测试源：</span>
          {DEFAULT_TEST_STREAMS.map((s) => (
            <button
              key={s.url}
              type="button"
              onClick={() => {
                setCurrentUrl(s.url);
              }}
              className={`rounded px-2 py-1 ${
                currentUrl === s.url ? 'bg-rose-600 text-white' : 'bg-white/10 text-white/70 hover:bg-white/20'
              }`}
            >
              {s.name}
            </button>
          ))}
          {customUrl && (
            <span className="rounded bg-amber-600/30 px-2 py-1 text-amber-200">自定义 URL</span>
          )}
        </div>
        <div className="mt-2 break-all text-white/50">当前 URL：{currentUrl}</div>
      </div>

      <div className="relative flex-1">
        <TeslaPlayer
          key={currentUrl}
          url={currentUrl}
          title="Tesla 播放器测试"
          live={false}
          onBackToOriginal={() => {
            window.history.back();
          }}
        />
      </div>

      {/* 日志面板：方便用户截图给我排查 */}
      <div className="h-40 shrink-0 overflow-y-auto border-t border-white/10 bg-zinc-950 p-3 font-mono text-[11px] leading-relaxed text-white/70">
        <div className="mb-1 text-white/40">
          日志面板（出现错误时请截图发我）：共 {logs.length} 条
        </div>
        {logs.length === 0 ? (
          <div className="text-white/30">暂无日志，正常情况下应该会看到 Broadway.js 的初始化日志</div>
        ) : (
          logs.map((line, i) => (
            <div key={i} className={line.includes('error') ? 'text-red-400' : ''}>
              {line}
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default function TeslaTestPage() {
  return (
    <Suspense
      fallback={
        <div className="fixed inset-0 flex items-center justify-center bg-black text-white">
          加载中…
        </div>
      }
    >
      <TeslaTestPageInner />
    </Suspense>
  );
}
