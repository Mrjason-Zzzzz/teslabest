// 获取弹幕 API 路由
import { NextRequest, NextResponse } from 'next/server';

import { getConfig } from '@/lib/config';
import { getDanmakuApiBaseUrl } from '@/lib/danmaku/config';

export const runtime = 'nodejs';

// 解析弹幕 XML 为 JSON
function parseXmlDanmaku(
  xmlText: string
): Array<{ p: string; m: string; cid: number }> {
  const comments: Array<{ p: string; m: string; cid: number }> = [];

  // 使用正则表达式提取所有 <d> 标签
  const dTagRegex = /<d\s+p="([^"]+)"[^>]*>([^<]*)<\/d>/g;
  let match;

  while ((match = dTagRegex.exec(xmlText)) !== null) {
    const p = match[1];
    const m = match[2];

    // 从 p 属性中提取 cid（弹幕ID）
    const pParts = p.split(',');
    const cid = pParts[7] ? parseInt(pParts[7]) : 0;

    comments.push({
      p,
      m,
      cid,
    });
  }

  return comments;
}

function sampleComments(
  comments: Array<{ p: string; m: string; cid: number }>,
  limit = 1500
) {
  if (comments.length <= limit) return comments;
  const step = comments.length / limit;
  return Array.from(
    { length: limit },
    (_, index) =>
      comments[Math.min(comments.length - 1, Math.floor(index * step))]
  );
}

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const episodeId = searchParams.get('episodeId');
    const url = searchParams.get('url');

    // 至少需要一个参数
    if (!episodeId && !url) {
      return NextResponse.json(
        {
          count: 0,
          comments: [],
        },
        { status: 400 }
      );
    }

    // 从数据库读取弹幕配置
    const config = await getConfig();
    const baseUrl = getDanmakuApiBaseUrl(config.SiteConfig);

    let apiUrl: string;

    if (episodeId) {
      // 通过剧集 ID 获取弹幕 - 使用 XML 格式
      apiUrl = `${baseUrl}/api/v2/comment/${episodeId}?format=xml`;
    } else {
      // 通过视频 URL 获取弹幕 - 使用 XML 格式
      apiUrl = `${baseUrl}/api/v2/comment?url=${encodeURIComponent(
        url!
      )}&format=xml`;
    }

    // 添加超时控制
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 35000);

    try {
      const response = await fetch(apiUrl, {
        method: 'GET',
        headers: {
          Accept: 'application/xml, text/xml',
        },
        signal: controller.signal,
        keepalive: true,
        next: { revalidate: 24 * 60 * 60 },
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      // 获取 XML 文本
      const xmlText = await response.text();

      // 解析 XML 为 JSON
      // The upstream document can exceed a megabyte. Sampling evenly keeps
      // comments across the full timeline while avoiding a huge JSON payload
      // and DOM pressure on the vehicle browser.
      const allComments = parseXmlDanmaku(xmlText);
      const comments = sampleComments(allComments);

      return NextResponse.json(
        {
          count: allComments.length,
          comments,
          sampled: comments.length < allComments.length,
        },
        {
          headers: {
            'Cache-Control':
              'public, s-maxage=86400, stale-while-revalidate=604800',
          },
        }
      );
    } catch (fetchError) {
      clearTimeout(timeoutId);

      // 如果是超时错误，返回更友好的错误信息
      if (fetchError instanceof Error && fetchError.name === 'AbortError') {
        throw new Error('弹幕服务器请求超时，请稍后重试');
      }

      throw fetchError;
    }
  } catch (error) {
    console.error('获取弹幕代理错误:', error);
    return NextResponse.json(
      {
        count: 0,
        comments: [],
      },
      { status: 500 }
    );
  }
}
