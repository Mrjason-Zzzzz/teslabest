import { resolveAdFilterSourceKey } from './ad-filter';

describe('configured ad filter source routing', () => {
  test('uses the actual video source instead of hls.js manifest type', () => {
    expect(resolveAdFilterSourceKey('mapped-source', 'level')).toBe(
      'mapped-source'
    );
  });

  test('retains the playlist context as a fallback', () => {
    expect(resolveAdFilterSourceKey('', 'manifest')).toBe('manifest');
  });
});
