import type { SearchResult } from '@/lib/types';

interface SourceHealthRecord {
  success: number;
  failure: number;
  stall: number;
  averageStartMs: number;
  updatedAt: number;
}

type SourceHealthMap = Record<string, SourceHealthRecord>;

const STORAGE_KEY = 'tesla_source_health_v1';

export function getTeslaSourceKey(source: Pick<SearchResult, 'source' | 'id'>): string {
  return `${source.source}:${source.id}`;
}

function readHealth(): SourceHealthMap {
  if (typeof window === 'undefined') return {};
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return value ? JSON.parse(value) as SourceHealthMap : {};
  } catch {
    return {};
  }
}

function writeHealth(value: SourceHealthMap) {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage is an optimization; playback must not depend on it.
  }
}

export function getTeslaSourceScore(source: SearchResult): number {
  const record = readHealth()[getTeslaSourceKey(source)];
  const configuredWeight = source.weight ?? 0;
  if (!record) return configuredWeight * 10;

  const ageDays = Math.max(0, (Date.now() - record.updatedAt) / 86_400_000);
  const freshness = Math.max(0.25, 1 - ageDays / 30);
  const startPenalty = Math.min(20, record.averageStartMs / 1000);
  return configuredWeight * 10 + freshness * (
    record.success * 14 - record.failure * 28 - record.stall * 12 - startPenalty
  );
}

export function rankTeslaSources(sources: SearchResult[]): SearchResult[] {
  return [...sources].sort((a, b) => {
    const scoreDiff = getTeslaSourceScore(b) - getTeslaSourceScore(a);
    if (scoreDiff !== 0) return scoreDiff;
    return (b.weight ?? 0) - (a.weight ?? 0);
  });
}

export function markTeslaSourceReady(source: SearchResult, startMs: number) {
  const map = readHealth();
  const key = getTeslaSourceKey(source);
  const previous = map[key] || {
    success: 0,
    failure: 0,
    stall: 0,
    averageStartMs: 0,
    updatedAt: 0,
  };
  const success = previous.success + 1;
  map[key] = {
    ...previous,
    success,
    averageStartMs: previous.averageStartMs > 0
      ? Math.round((previous.averageStartMs * previous.success + startMs) / success)
      : Math.round(startMs),
    updatedAt: Date.now(),
  };
  writeHealth(map);
}

export function markTeslaSourceFailure(source: SearchResult, stalled = false) {
  const map = readHealth();
  const key = getTeslaSourceKey(source);
  const previous = map[key] || {
    success: 0,
    failure: 0,
    stall: 0,
    averageStartMs: 0,
    updatedAt: 0,
  };
  map[key] = {
    ...previous,
    failure: previous.failure + 1,
    stall: previous.stall + (stalled ? 1 : 0),
    updatedAt: Date.now(),
  };
  writeHealth(map);
}
