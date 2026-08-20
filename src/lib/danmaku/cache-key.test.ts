import { generateCacheKey } from './cache';

describe('danmaku cache identity', () => {
  test('keeps the legacy key for callers without a matched anime id', () => {
    expect(generateCacheKey('甄嬛传', 0)).toBe('甄嬛传|0');
  });

  test('separates same-title candidates by matched anime id', () => {
    expect(generateCacheKey('甄嬛传', 0, 34411)).not.toBe(
      generateCacheKey('甄嬛传', 0, 294824)
    );
  });
});
