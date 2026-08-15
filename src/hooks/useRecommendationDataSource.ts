'use client';

/**
 * Hook to get the recommendation data source configuration
 * @returns The only deployed recommendation source.
 */
export function useRecommendationDataSource(): string {
  return 'Douban';
}
