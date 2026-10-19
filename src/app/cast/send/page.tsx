'use client';

import { Loader2, Search, Send, Tv2 } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import { FormEvent, Suspense, useState } from 'react';

function CastSendClient() {
  const searchParams = useSearchParams();
  const [type, setType] = useState<'live' | 'vod'>('live');
  const [value, setValue] = useState('');
  const [label, setLabel] = useState('');
  const [message, setMessage] = useState('');
  const [sending, setSending] = useState(false);
  const [searching, setSearching] = useState(false);
  const [results, setResults] = useState<
    Array<{
      source: string;
      sourceName: string;
      id: string;
      title: string;
      year?: string;
      typeName?: string;
      episodeCount?: number;
    }>
  >([]);

  const sessionId = searchParams.get('session') || '';
  const token = searchParams.get('token') || '';

  const sendPayload = async (payload: Record<string, unknown>) => {
    if (!sessionId || !token) throw new Error('二维码无效，请在车机重新生成');
    const response = await fetch(
      `/api/cast/sessions/${encodeURIComponent(sessionId)}?token=${encodeURIComponent(token)}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    const data = (await response.json().catch(() => ({}))) as { error?: string };
    if (!response.ok) throw new Error(data.error || '发送失败');
  };

  const searchVod = async () => {
    if (!value.trim()) return;
    setSearching(true);
    setMessage('');
    setResults([]);
    try {
      if (!sessionId || !token) throw new Error('二维码无效，请在车机重新生成');
      const response = await fetch(
        `/api/cast/sessions/${encodeURIComponent(sessionId)}/search?token=${encodeURIComponent(token)}&q=${encodeURIComponent(value.trim())}`,
        { cache: 'no-store' }
      );
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        results?: typeof results;
      };
      if (!response.ok) throw new Error(data.error || '搜索失败');
      setResults(data.results || []);
      setMessage(
        data.results?.length
          ? '请选择正确的片名、年份和资源后再发送。'
          : '没有找到结果，请更换关键词。'
      );
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '搜索失败');
    } finally {
      setSearching(false);
    }
  };

  const sendVodSelection = async (item: (typeof results)[number]) => {
    setSending(true);
    setMessage('');
    try {
      await sendPayload({ type: 'vod', ...item, label });
      setMessage(`已发送“${item.title} · ${item.sourceName}”到车机。`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSending(true);
    setMessage('');
    try {
      if (type === 'vod') {
        await searchVod();
        return;
      }
      await sendPayload({ type, value, label });
      setMessage('已发送到车机，车机将自动打开。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '发送失败');
    } finally {
      setSending(false);
    }
  };

  return (
    <main className='min-h-screen bg-gradient-to-b from-violet-50 to-white px-4 py-8 text-gray-900'>
      <section className='mx-auto max-w-md rounded-3xl bg-white p-6 shadow-xl'>
        <div className='flex items-center gap-3'>
          <div className='rounded-2xl bg-violet-600 p-3 text-white'><Tv2 /></div>
          <div><h1 className='text-xl font-black'>发送到车机</h1><p className='text-sm text-gray-500'>仅本次二维码有效，5 分钟后自动失效。</p></div>
        </div>
        <form className='mt-6 space-y-4' onSubmit={submit}>
          <div className='grid grid-cols-2 gap-2 rounded-xl bg-gray-100 p-1'>
            <button type='button' onClick={() => setType('live')} className={`rounded-lg px-3 py-2 text-sm font-bold ${type === 'live' ? 'bg-white text-violet-700 shadow' : 'text-gray-500'}`}>直播投送</button>
            <button type='button' onClick={() => setType('vod')} className={`rounded-lg px-3 py-2 text-sm font-bold ${type === 'vod' ? 'bg-white text-violet-700 shadow' : 'text-gray-500'}`}>点播找片</button>
          </div>
          <label className='block text-sm font-bold'>{type === 'live' ? '直播直链或公开平台链接' : '先搜索，再选择具体资源'}</label>
          <textarea value={value} onChange={(event) => { setValue(event.target.value); if (type === 'vod') setResults([]); }} required rows={type === 'live' ? 4 : 2} placeholder={type === 'live' ? 'm3u8 直链，或抖音/虎牙/B站公开直播间链接' : '例如：年会不能停！2'} className='w-full rounded-xl border border-gray-200 px-3 py-2 outline-none focus:border-violet-500' />
          {type === 'live' && <p className='-mt-2 text-xs leading-5 text-gray-500'>抖音短链接会在服务端安全解析为公开直播间；付费、登录或非直播页面不会绕过平台限制。</p>}
          <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder='备注（可选）' className='w-full rounded-xl border border-gray-200 px-3 py-2 outline-none focus:border-violet-500' />
          <button disabled={sending || searching || !value.trim()} className='flex w-full items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-3 font-bold text-white disabled:opacity-50'>{searching ? <Loader2 className='h-4 w-4 animate-spin' /> : type === 'vod' ? <Search className='h-4 w-4' /> : <Send className='h-4 w-4' />}{searching ? '搜索中…' : sending ? '发送中…' : type === 'vod' ? '搜索站内资源' : '发送到车机'}</button>
        </form>
        {message && <p className='mt-4 text-center text-sm text-violet-700'>{message}</p>}
        {type === 'vod' && results.length > 0 && (
          <div className='mt-4 max-h-[48vh] space-y-2 overflow-y-auto text-left'>
            {results.map((item) => (
              <button
                key={`${item.source}:${item.id}`}
                type='button'
                disabled={sending}
                onClick={() => void sendVodSelection(item)}
                className='w-full rounded-xl border border-gray-200 px-4 py-3 text-left transition hover:border-violet-400 hover:bg-violet-50 disabled:opacity-50'
              >
                <span className='block font-bold text-gray-900'>{item.title}</span>
                <span className='mt-1 block text-xs text-gray-500'>
                  {[item.year, item.typeName, item.sourceName, item.episodeCount ? `${item.episodeCount} 集` : ''].filter(Boolean).join(' · ')}
                </span>
              </button>
            ))}
          </div>
        )}
      </section>
    </main>
  );
}

export default function CastSendPage() {
  return (
    <Suspense
      fallback={<main className='min-h-screen bg-violet-50 px-4 py-8 text-center text-violet-700'>正在打开手机接力…</main>}
    >
      <CastSendClient />
    </Suspense>
  );
}
