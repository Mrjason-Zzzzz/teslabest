import {
  isTeslaVehicleBrowser,
  selectTeslaPlaybackMode,
} from './playback-mode';

describe('Tesla playback mode selection', () => {
  it('keeps Canvas/WebCodecs exclusively for recognised vehicle browsers', () => {
    expect(
      selectTeslaPlaybackMode('webcodecs', true, 'Mozilla/5.0 Tesla/2026')
    ).toBe('webcodecs');
    expect(
      selectTeslaPlaybackMode('webcodecs', true, 'Mozilla/5.0 QtCarBrowser')
    ).toBe('webcodecs');
  });

  it('uses the native browser A/V clock for desktop compatibility', () => {
    expect(
      selectTeslaPlaybackMode(
        'webcodecs',
        true,
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) Chrome/140'
      )
    ).toBe('video');
    expect(isTeslaVehicleBrowser('Mozilla/5.0 Chrome/140')).toBe(false);
  });

  it('never selects WebCodecs when the decoder API is unavailable', () => {
    expect(
      selectTeslaPlaybackMode('webcodecs', false, 'Mozilla/5.0 Tesla/2026')
    ).toBe('video');
    expect(selectTeslaPlaybackMode('video', true, 'Mozilla/5.0 Tesla/2026')).toBe(
      'video'
    );
  });
});
