import { NextRequest, NextResponse } from 'next/server';

import { readCastSessionForToken } from '@/lib/cast-session';
import { getAvailableApiSites, getConfig } from '@/lib/config';
import { searchFromApi } from '@/lib/downstream';
import { yellowWords } from '@/lib/yellow';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(
  request: NextRequest,
  { params }: { params: { sessionId: string } }
) {
  const token = request.nextUrl.searchParams.get('token') || '';
  const query = (request.nextUrl.searchParams.get('q') || '').trim();
  const session = await readCastSessionForToken(params.sessionId, token);
  if (!session) {
    return NextResponse.json(
      { error: '二维码已过期或无效' },
      { status: 404, headers: { 'Cache-Control': 'no-store' } }
    );
  }
  if (!query || query.length > 80) {
    return NextResponse.json(
      { error: '请输入不超过 80 个字符的片名' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const [sites, config] = await Promise.all([
    getAvailableApiSites(session.owner),
    getConfig(),
  ]);
  const batches = await Promise.all(
    sites.map(async (site, siteIndex) => {
      try {
        const results = await Promise.race([
          searchFromApi(site, query),
          new Promise<never>((_, reject) =>
            setTimeout(() => reject(new Error('timeout')), 9000)
          ),
        ]);
        return results.map((item) => ({
          source: site.key,
          sourceName: site.name,
          id: String(item.id),
          title: item.title,
          year: item.year || '',
          typeName: item.type_name || '',
          poster: item.poster || '',
          episodeCount: Array.isArray(item.episodes) ? item.episodes.length : 0,
          sourceOrder: siteIndex,
        }));
      } catch {
        return [];
      }
    })
  );
  const results = batches
    .flat()
    .filter(
      (item) =>
        config.SiteConfig.DisableYellowFilter ||
        !yellowWords.some((word) => item.typeName.includes(word))
    )
    .sort((left, right) => left.sourceOrder - right.sourceOrder)
    .slice(0, 60);

  return NextResponse.json(
    { results },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } }
  );
}
