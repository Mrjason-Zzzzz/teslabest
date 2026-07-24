import crypto from 'crypto';
import { NextRequest, NextResponse } from 'next/server';

import { requireFeaturePermission } from '@/lib/permissions';

function getAntiCode(oldAntiCode: string, streamName: string): string {
  const paramsT = 100;
  const sdkVersion = 2403051612;
  const t13 = Date.now();
  const sdkSid = t13;
  const initUuid = (Math.floor(t13 % 10000000000 * 1000) + Math.floor(1000 * Math.random())) % 4294967295;
  const uid = Math.floor(Math.random() * (1400009999999 - 1400000000000 + 1)) + 1400000000000;
  const seqId = uid + sdkSid;
  const targetUnixTime = Math.floor((t13 + 110624) / 1000);
  const wsTime = targetUnixTime.toString(16).toLowerCase();

  const urlQuery = new URLSearchParams(oldAntiCode);
  const fm = urlQuery.get('fm');
  if (!fm) return oldAntiCode;

  const wsSecretPf = Buffer.from(decodeURIComponent(fm), 'base64').toString().split('_')[0];
  const wsSecretHash = crypto.createHash('md5').update(`${seqId}|${urlQuery.get('ctype')}|${paramsT}`).digest('hex');
  const wsSecret = `${wsSecretPf}_${uid}_${streamName}_${wsSecretHash}_${wsTime}`;
  const wsSecretMd5 = crypto.createHash('md5').update(wsSecret).digest('hex');

  return `wsSecret=${wsSecretMd5}&wsTime=${wsTime}&seqid=${seqId}&ctype=${urlQuery.get('ctype')}&ver=1&fs=${urlQuery.get('fs')}&uuid=${initUuid}&u=${uid}&t=${paramsT}&sv=${sdkVersion}&sdk_sid=${sdkSid}&codec=264`;
}

async function getBilibiliStream(roomId: string) {
  const headers = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://live.bilibili.com/'
  };

  // 获取房间初始化信息
  const roomInitRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/room_init?id=${roomId}`, {
    headers
  });
  const roomInitData = await roomInitRes.json();

  if (roomInitData.code !== 0) {
    throw new Error(roomInitData.message || '获取房间信息失败');
  }

  const roomData = roomInitData.data;
  const realRoomId = roomData.room_id;
  const liveStatus = roomData.live_status; // 0=未开播, 1=直播中, 2=轮播
  const uid = roomData.uid;

  if (liveStatus !== 1) {
    throw new Error('直播未开启');
  }

  // 获取主播信息
  let ownerName = '';
  try {
    const userRes = await fetch(`https://api.live.bilibili.com/live_user/v1/Master/info?uid=${uid}`, {
      headers
    });
    const userData = await userRes.json();
    if (userData.code === 0) {
      ownerName = userData.data?.info?.uname || '';
    }
  } catch (err) {
    console.warn('获取主播信息失败:', err);
  }

  // 获取房间详细信息（包含标题）
  let title = '';
  try {
    const roomInfoRes = await fetch(`https://api.live.bilibili.com/room/v1/Room/get_info?room_id=${realRoomId}`, {
      headers
    });
    const roomInfoData = await roomInfoRes.json();
    if (roomInfoData.code === 0) {
      title = roomInfoData.data?.title || '';
    }
  } catch (err) {
    console.warn('获取房间标题失败:', err);
  }

  // 获取播放地址 (原画质量 qn=10000)
  const playInfoRes = await fetch(
    `https://api.live.bilibili.com/xlive/web-room/v2/index/getRoomPlayInfo?room_id=${realRoomId}&protocol=0,1&format=0,1,2&codec=0,1&qn=10000&platform=web&ptype=8`,
    { headers }
  );
  const playInfoData = await playInfoRes.json();

  if (playInfoData.code !== 0) {
    throw new Error(playInfoData.message || '获取播放信息失败');
  }

  const playurl = playInfoData.data?.playurl_info?.playurl;
  if (!playurl) {
    throw new Error('未找到播放地址');
  }

  // 提取m3u8地址
  let m3u8Url = '';
  const streamList = playurl.stream || [];

  for (const stream of streamList) {
    const formatList = stream.format || [];
    for (const fmt of formatList) {
      if (fmt.format_name === 'ts') {
        const codecList = fmt.codec || [];
        for (const codec of codecList) {
          const urlInfoList = codec.url_info || [];
          const baseUrl = codec.base_url || '';

          if (urlInfoList.length > 0 && baseUrl) {
            const host = urlInfoList[0].host || '';
            const extra = urlInfoList[0].extra || '';
            m3u8Url = `${host}${baseUrl}${extra}`;
            break;
          }
        }
        if (m3u8Url) break;
      }
    }
    if (m3u8Url) break;
  }

  if (!m3u8Url) {
    throw new Error('未找到m3u8地址');
  }

  return {
    url: m3u8Url,
    name: ownerName,
    title: title
  };
}

function cleanEscapedUrl(value: string): string {
  return value
    .replace(/\\u002F/gi, '/')
    .replace(/\\u0026/gi, '&')
    .replace(/\\\//g, '/')
    .replace(/&amp;/g, '&');
}

function extractCookie(setCookie: string, name: string): string {
  const match = setCookie.match(new RegExp(`${name}=([^;,\\s]+)`, 'i'));
  return match?.[1] || '';
}

function normalizeRoomId(platform: string, input: string): string {
  const value = input.trim();
  if (!value) return '';

  try {
    const parsed = new URL(value.startsWith('http') ? value : `https://${value}`);
    const host = parsed.hostname.toLowerCase();
    const segments = parsed.pathname.split('/').filter(Boolean);

    if (platform === 'douyin' && (host === 'live.douyin.com' || host.endsWith('.douyin.com'))) {
      return segments[0] || value;
    }
    if (platform === 'bilibili' && host === 'live.bilibili.com') {
      return segments[0] || value;
    }
    if (platform === 'huya' && (host === 'huya.com' || host.endsWith('.huya.com'))) {
      return segments[0] || value;
    }
  } catch {
    // Plain room id.
  }

  return value;
}

async function fetchWithTimeout(
  input: string | URL,
  init: RequestInit = {},
  timeoutMs = 12000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function extractDouyinHlsFromHtml(html: string): string {
  const normalized = cleanEscapedUrl(html);
  const matches = normalized.match(/https?:[^"'\\s]+?\.m3u8[^"'\\s<]*/gi) || [];
  return matches
    .map((item) => item.replace(/[),;]+$/, ''))
    .find((item) => /pull|stream|live/i.test(item)) || matches[0] || '';
}

async function getDouyinStream(rawRoomId: string) {
  const roomId = normalizeRoomId('douyin', rawRoomId);
  const baseHeaders = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    'Referer': `https://live.douyin.com/${roomId}`,
    'Accept-Language': 'zh-CN,zh;q=0.9'
  };

  // Bootstrap a fresh visitor cookie on every server-side resolution. The old
  // implementation used one hard-coded ttwid, so it inevitably expired.
  const roomPage = await fetchWithTimeout(`https://live.douyin.com/${roomId}`, {
    headers: baseHeaders,
    cache: 'no-store',
    redirect: 'follow'
  });
  const roomHtml = await roomPage.text();
  const setCookie = roomPage.headers.get('set-cookie') || '';
  const ttwid = extractCookie(setCookie, 'ttwid');
  const msToken = extractCookie(setCookie, 'msToken');
  const configuredCookie = process.env.DOUYIN_WEB_COOKIE?.trim();
  const cookie = configuredCookie || [
    ttwid ? `ttwid=${ttwid}` : '',
    msToken ? `msToken=${msToken}` : ''
  ].filter(Boolean).join('; ');

  const htmlHls = extractDouyinHlsFromHtml(roomHtml);
  const params = new URLSearchParams({
    aid: '6383',
    app_name: 'douyin_web',
    live_id: '1',
    device_platform: 'web',
    language: 'zh-CN',
    browser_language: 'zh-CN',
    browser_platform: 'Win32',
    browser_name: 'Chrome',
    browser_version: '124.0.0.0',
    web_rid: roomId
  });
  if (msToken) params.set('msToken', msToken);

  let jsonData: any = null;
  try {
    const response = await fetchWithTimeout(`https://live.douyin.com/webcast/room/web/enter/?${params.toString()}`, {
      headers: {
        ...baseHeaders,
        ...(cookie ? { Cookie: cookie } : {})
      },
      cache: 'no-store'
    });
    const responseText = await response.text();
    if (response.ok && responseText.trim().startsWith('{')) {
      jsonData = JSON.parse(responseText);
    }
  } catch (error) {
    console.warn('[web-live] Douyin room API failed, trying page payload:', error);
  }

  const roomData = jsonData?.data?.data?.[0];
  if (roomData && roomData.status !== 2) {
    throw new Error('抖音直播未开启');
  }

  const streamUrl = roomData?.stream_url;
  const hlsMap = streamUrl?.hls_pull_url_map || {};
  // Prefer a lower stable bitrate on a moving cellular connection. Every
  // available quality is returned so the UI can switch without changing rooms.
  const qualityOrder = ['SD2', 'SD1', 'HD1', 'FULL_HD1', 'ORIGIN'];
  const m3u8Url =
    hlsMap.SD2 ||
    hlsMap.SD1 ||
    hlsMap.HD1 ||
    hlsMap.FULL_HD1 ||
    hlsMap.ORIGIN ||
    streamUrl?.hls_pull_url ||
    Object.values(hlsMap)[0] ||
    htmlHls;
  const alternatives = qualityOrder
    .filter((quality) => typeof hlsMap[quality] === 'string' && hlsMap[quality])
    .map((quality) => ({
      id: quality,
      label: quality === 'SD2'
        ? '流畅'
        : quality === 'SD1'
          ? '标清'
          : quality === 'HD1'
            ? '高清'
            : quality === 'FULL_HD1'
              ? '超清'
              : '原画',
      url: cleanEscapedUrl(hlsMap[quality]),
      streamType: 'hls'
    }));
  if (alternatives.length === 0 && m3u8Url) {
    alternatives.push({
      id: 'AUTO',
      label: '自动线路',
      url: cleanEscapedUrl(String(m3u8Url)),
      streamType: 'hls'
    });
  }

  if (!m3u8Url || typeof m3u8Url !== 'string') {
    throw new Error(
      '抖音未返回可播放直播流。已自动刷新访客凭证；若仍失败，请检查房间是否开播，或在 Vercel 配置 DOUYIN_WEB_COOKIE。'
    );
  }

  return {
    url: cleanEscapedUrl(m3u8Url),
    name: jsonData?.data?.user?.nickname || '',
    title: roomData?.title || '',
    alternatives
  };
}

export async function GET(request: NextRequest) {
  try {
    const authResult = await requireFeaturePermission(request, 'web_live', '无权限访问网络直播');
    if (authResult instanceof NextResponse) return authResult;
    const { searchParams } = new URL(request.url);
    const platform = searchParams.get('platform');
    const rawRoomId = searchParams.get('roomId');
    const roomId = platform && rawRoomId ? normalizeRoomId(platform, rawRoomId) : '';

    if (!platform || !roomId) {
      return NextResponse.json({ error: '缺少参数' }, { status: 400 });
    }

    if (platform === 'huya') {
      const res = await fetchWithTimeout(`https://www.huya.com/${roomId}`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        },
        cache: 'no-store'
      }, 10000);
      const html = await res.text();

      const match = html.match(/stream:\s*(\{"data".*?),"iWebDefaultBitRate"/);
      if (!match) {
        return NextResponse.json({ error: '未找到直播数据' }, { status: 404 });
      }

      const jsonData = JSON.parse(match[1] + '}');
      const gameLiveInfo = jsonData.data?.[0]?.gameLiveInfo;
      const streamInfoList = jsonData.data?.[0]?.gameStreamInfoList || [];

      if (streamInfoList.length === 0) {
        return NextResponse.json({ error: '直播未开启' }, { status: 404 });
      }

      // Huya normally exposes several CDN lines. Return all valid lines so a
      // frozen picture can switch CDN without asking the user to edit admin data.
      const alternatives = streamInfoList.flatMap((streamInfo: any, index: number) => {
        try {
          const {
            sFlvUrl,
            sFlvUrlSuffix,
            sFlvAntiCode,
            sHlsUrl,
            sHlsUrlSuffix,
            sHlsAntiCode,
            sStreamName
          } = streamInfo;
          const hasHls = Boolean(sHlsUrl && sHlsUrlSuffix && sHlsAntiCode);
          const antiCode = getAntiCode(
            hasHls ? sHlsAntiCode : sFlvAntiCode,
            sStreamName
          );
          const originalUrl = hasHls
            ? `${sHlsUrl}/${sStreamName}.${sHlsUrlSuffix}?${antiCode}`
            : `${sFlvUrl}/${sStreamName}.${sFlvUrlSuffix}?${antiCode}`;
          const streamType = hasHls ? 'hls' : 'flv';
          return [{
            id: `line-${index + 1}`,
            label: `线路 ${index + 1}${hasHls ? ' · HLS' : ' · FLV'}`,
            url: `/api/web-live/proxy/proxy.${hasHls ? 'm3u8' : 'flv'}?url=${encodeURIComponent(originalUrl)}&platform=huya`,
            originalUrl,
            streamType
          }];
        } catch (error) {
          console.warn('[web-live] skip invalid Huya line:', error);
          return [];
        }
      });

      if (alternatives.length === 0) {
        return NextResponse.json({ error: '虎牙未返回可用播放线路' }, { status: 502 });
      }

      const selected = alternatives.find((item: any) => item.streamType === 'hls') || alternatives[0];
      return NextResponse.json({
        url: selected.url,
        originalUrl: selected.originalUrl,
        name: gameLiveInfo?.nick || '',
        title: gameLiveInfo?.introduction || '',
        streamType: selected.streamType,
        quality: 'stable',
        alternatives,
        live: true
      });
    }

    if (platform === 'bilibili') {
      const streamData = await getBilibiliStream(roomId);
      const proxyUrl = `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(streamData.url)}&platform=bilibili`;

      return NextResponse.json({
        url: proxyUrl,
        originalUrl: streamData.url,
        name: streamData.name,
        title: streamData.title,
        streamType: 'hls',
        alternatives: [{
          id: 'line-1',
          label: '默认线路',
          url: proxyUrl,
          originalUrl: streamData.url,
          streamType: 'hls'
        }],
        live: true
      });
    }

    if (platform === 'douyin') {
      const streamData = await getDouyinStream(roomId);
      const proxyUrl = `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(streamData.url)}&platform=douyin`;
      const alternatives = streamData.alternatives.map((item: any) => ({
        ...item,
        originalUrl: item.url,
        url: `/api/web-live/proxy/proxy.m3u8?url=${encodeURIComponent(item.url)}&platform=douyin`
      }));

      return NextResponse.json({
        url: proxyUrl,
        originalUrl: streamData.url,
        name: streamData.name,
        title: streamData.title,
        streamType: 'hls',
        alternatives,
        live: true
      });
    }

    return NextResponse.json({ error: '不支持的平台' }, { status: 400 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '获取失败' },
      { status: 500 }
    );
  }
}
