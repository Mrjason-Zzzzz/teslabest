import { selectTeslaPlaybackMode } from './playback-mode';

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
});
