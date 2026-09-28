import {
  selectTeslaPlaybackMode,
  selectTeslaVodDefaultMode,
} from './playback-mode';

describe('Tesla playback mode selection', () => {
  it('keeps Canvas/WebCodecs for every capable Tesla playback route', () => {
    expect(
      selectTeslaPlaybackMode('webcodecs', true)
    ).toBe('webcodecs');
    expect(
      selectTeslaPlaybackMode('webcodecs', true)
    ).toBe('webcodecs');
  });

  it('does not infer the playback route from an unstable browser user-agent', () => {
    expect(
      selectTeslaPlaybackMode('webcodecs', true)
    ).toBe('webcodecs');
  });

  it('never selects WebCodecs when the decoder API is unavailable', () => {
    expect(
      selectTeslaPlaybackMode('webcodecs', false)
    ).toBe('video');
    expect(selectTeslaPlaybackMode('video', true)).toBe('video');
  });

  it('uses the native media clock for an ordinary desktop VOD session', () => {
    expect(
      selectTeslaVodDefaultMode({
        maxTouchPoints: 0,
        hasCoarsePointer: false,
        hasNoHover: false,
        viewportWidth: 1440,
        viewportHeight: 900,
      })
    ).toBe('video');
  });

  it('keeps Canvas for a wide touch-only VOD surface without relying on UA', () => {
    expect(
      selectTeslaVodDefaultMode({
        maxTouchPoints: 1,
        hasCoarsePointer: true,
        hasNoHover: true,
        viewportWidth: 1280,
        viewportHeight: 720,
      })
    ).toBe('webcodecs');
  });
});
