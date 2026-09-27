'use client';

import { Loader2, Smartphone, Tv2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import PageLayout from '@/components/PageLayout';
import { base58Encode } from '@/lib/utils';

type CastSession = {
  sessionId: string;
  token?: string;
  expiresAt: number;
  payload?:
    | { type: 'direct'; url: string; label?: string }
    | { type: 'search'; query: string; label?: string };
};

export default function CastPage() {
  const [session, setSession] = useState<CastSession | null>(null);
  const [message, setMessage] = useState('正在生成手机接力二维码…');

  useEffect(() => {
    let disposed = false;
    const create = async () => {
      const response = await fetch('/api/cast/sessions', {
        method: 'POST',
        credentials: 'same-origin',
      });
      if (!response.ok) throw new Error('无法创建接力会话，请重新登录后再试');
      const next = (await response.json()) as CastSession;
      if (!disposed) {
        setSession(next);
        setMessage('扫描二维码发送内容，二维码 5 分钟内有效。');
      }
    };
    void create().catch((error) => {
      if (!disposed) setMessage(error instanceof Error ? error.message : '创建失败');
    });
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!session?.sessionId) return;
    const timer = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/cast/sessions/${session.sessionId}`, {
          cache: 'no-store',
          credentials: 'same-origin',
        });
        if (!response.ok) {
          setMessage('二维码已过期，请刷新此页重新生成');
          clearInterval(timer);
          return;
        }
        const next = (await response.json()) as CastSession;
        if (!next.payload) return;
        if (next.payload.type === 'direct') {
          window.location.assign(
            `/play?source=directplay&id=${encodeURIComponent(
              base58Encode(next.payload.url)
            )}`
          );
          return;
        }
        window.location.assign(`/search?q=${encodeURIComponent(next.payload.query)}`);
      } catch {
        // A transient polling failure must not end a valid vehicle session.
      }
    }, 1500);
    return () => clearInterval(timer);
  }, [session?.sessionId]);

  const shareUrl = useMemo(() => {
    if (!session?.sessionId || !session.token || typeof window === 'undefined') {
      return '';
    }
    const url = new URL('/cast/send', window.location.origin);
    url.searchParams.set('session', session.sessionId);
    url.searchParams.set('token', session.token);
    return url.toString();
  }, [session]);

  const qrUrl = shareUrl
    ? `/api/auth/qr/image?data=${encodeURIComponent(shareUrl)}`
    : '';

  return (
    <PageLayout activePath='/cast'>
      <div className='mx-auto flex min-h-[calc(100vh-5rem)] max-w-3xl items-center px-4 py-8'>
        <section className='w-full rounded-3xl border border-violet-200/70 bg-white/90 p-6 text-center shadow-xl dark:border-violet-500/30 dark:bg-gray-950/90 md:p-10'>
          <div className='mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-violet-600 text-white shadow-lg'>
            <Tv2 className='h-7 w-7' />
          </div>
          <h1 className='mt-4 text-2xl font-black text-gray-900 dark:text-white'>
            手机接力播放
          </h1>
          <p className='mt-2 text-sm leading-6 text-gray-600 dark:text-gray-300'>
            用手机扫描二维码，把可播放直链或影片名称发送到当前车机。
          </p>

          {qrUrl ? (
            <div className='mx-auto mt-6 w-fit rounded-2xl bg-white p-3 shadow-inner'>
              {/* The QR only contains an expiring handoff token, never login data. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img className='h-56 w-56' src={qrUrl} alt='手机接力二维码' />
            </div>
          ) : (
            <div className='mx-auto mt-6 flex h-56 w-56 items-center justify-center rounded-2xl bg-gray-100 text-violet-600 dark:bg-gray-900'>
              <Loader2 className='h-9 w-9 animate-spin' />
            </div>
          )}

          <div className='mt-5 flex items-center justify-center gap-2 text-sm font-medium text-violet-700 dark:text-violet-200'>
            <Smartphone className='h-4 w-4' />
            {message}
          </div>
          <div className='mx-auto mt-6 max-w-xl rounded-2xl bg-violet-50 px-4 py-3 text-left text-sm leading-6 text-violet-950 dark:bg-violet-950/35 dark:text-violet-100'>
            <p className='font-bold'>支持范围</p>
            <p>直播：发送可直接播放的 m3u8、MP4、WebM 或 FLV 链接。</p>
            <p>影视网页：发送影片名称后在本站结果中选择正确版本；爱奇艺等受保护网页不会被破解成播放直链。</p>
          </div>
        </section>
      </div>
    </PageLayout>
  );
}
