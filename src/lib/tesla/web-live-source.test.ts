import {
  detectWebLivePlatform,
  getDefaultWebLiveName,
  normalizeWebLiveSource,
  resolvePublicWebLiveSource,
} from './web-live-source';

describe('Tesla web live source input', () => {
  test('detects platform and room from a pasted link', () => {
    expect(
      normalizeWebLiveSource('douyin', 'https://www.huya.com/660000')
    ).toEqual({ platform: 'huya', roomId: '660000' });
    expect(
      normalizeWebLiveSource('huya', 'https://live.bilibili.com/12345?foo=1')
    ).toEqual({ platform: 'bilibili', roomId: '12345' });
  });

  test('keeps selected platform for a bare room id', () => {
    expect(normalizeWebLiveSource('douyin', '998877')).toEqual({
      platform: 'douyin',
      roomId: '998877',
    });
  });

  test('provides a compact fallback name', () => {
    expect(detectWebLivePlatform('https://www.douyin.com/live/88')).toBe(
      'douyin'
    );
    expect(getDefaultWebLiveName('douyin', '88')).toBe('抖音 88');
  });

  test('resolves a Douyin share link without following an off-platform redirect', async () => {
    const originalFetch = global.fetch;
    const originalTimeout = AbortSignal.timeout;
    Object.defineProperty(AbortSignal, 'timeout', {
      configurable: true,
      value: jest.fn(() => undefined),
    });
    try {
      global.fetch = jest
        .fn()
        .mockResolvedValueOnce({
          status: 302,
          headers: { get: () => 'https://live.douyin.com/998877' },
        } as unknown as Response)
        .mockResolvedValueOnce({
          status: 200,
          headers: { get: () => null },
        } as unknown as Response);
      await expect(
        resolvePublicWebLiveSource('https://v.douyin.com/example/')
      ).resolves.toEqual({ platform: 'douyin', roomId: '998877' });
      expect(global.fetch).toHaveBeenCalledTimes(2);
    } finally {
      global.fetch = originalFetch;
      Object.defineProperty(AbortSignal, 'timeout', {
        configurable: true,
        value: originalTimeout,
      });
    }
  });

  test('rejects unsupported share domains before making an outbound request', async () => {
    await expect(
      resolvePublicWebLiveSource('https://example.com/live/123')
    ).rejects.toThrow('公开直播间链接');
  });
});
