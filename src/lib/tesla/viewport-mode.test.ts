import { shouldUseCompactVehicleLayout } from './viewport-mode';

describe('compact vehicle viewport selection', () => {
  it('keeps a normal desktop viewport in the regular layout', () => {
    expect(
      shouldUseCompactVehicleLayout({
        width: 1440,
        height: 900,
        physicalWidth: 2560,
        frameWidth: 1440,
      })
    ).toBe(false);
  });

  it('recognizes a Tesla-like compressed effective viewport', () => {
    expect(
      shouldUseCompactVehicleLayout({
        width: 1280,
        height: 800,
        physicalWidth: 1920,
        frameWidth: 1920,
      })
    ).toBe(true);
  });

  it('recognizes a desktop browser zoomed to a smaller effective viewport', () => {
    expect(
      shouldUseCompactVehicleLayout({
        width: 960,
        height: 600,
        physicalWidth: 1440,
        frameWidth: 1440,
      })
    ).toBe(true);
  });

  it('uses an explicit visual viewport scale when browser frame metrics are unavailable', () => {
    expect(
      shouldUseCompactVehicleLayout({
        width: 1280,
        height: 800,
        physicalWidth: 1280,
        frameWidth: 1280,
        scale: 1.25,
      })
    ).toBe(true);
  });

  it('uses short-wide geometry as a fallback when screen metrics are unchanged', () => {
    expect(
      shouldUseCompactVehicleLayout({
        width: 1280,
        height: 650,
        physicalWidth: 1280,
      })
    ).toBe(true);
  });

  it('does not force a phone viewport into the vehicle desktop layout', () => {
    expect(
      shouldUseCompactVehicleLayout({
        width: 390,
        height: 844,
        physicalWidth: 390,
      })
    ).toBe(false);
  });
});
