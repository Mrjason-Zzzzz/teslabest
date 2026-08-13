'use client';

export interface TeslaAudioSessionSnapshot {
  unlocked: boolean;
  muted: boolean;
  volume: number;
}

const STORAGE_KEY = 'tesla_audio_session_v1';
const DEFAULT_SESSION: TeslaAudioSessionSnapshot = {
  unlocked: false,
  muted: false,
  volume: 1,
};

let session: TeslaAudioSessionSnapshot = { ...DEFAULT_SESSION };
let hydrated = false;
let sharedAudioContext: AudioContext | null = null;
let focusDestination: MediaStreamAudioDestinationNode | null = null;
let focusSource: ConstantSourceNode | OscillatorNode | null = null;
let focusGain: GainNode | null = null;
let focusAudioElement: HTMLAudioElement | null = null;
let focusReleaseTimer: number | null = null;

function hydrate(): void {
  if (hydrated || typeof window === 'undefined') return;
  hydrated = true;
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw);
    session = {
      unlocked: saved?.unlocked === true,
      muted: saved?.muted === true,
      volume: Number.isFinite(saved?.volume)
        ? Math.max(0, Math.min(1, saved.volume))
        : 1,
    };
  } catch {
    session = { ...DEFAULT_SESSION };
  }
}

function persist(): void {
  if (typeof window === 'undefined') return;
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Session persistence is an enhancement; playback must still work without it.
  }
}

export function getTeslaAudioSession(): TeslaAudioSessionSnapshot {
  hydrate();
  return { ...session };
}

export function updateTeslaAudioSession(
  patch: Partial<TeslaAudioSessionSnapshot>
): TeslaAudioSessionSnapshot {
  hydrate();
  session = {
    unlocked: patch.unlocked ?? session.unlocked,
    muted: patch.muted ?? session.muted,
    volume: Number.isFinite(patch.volume)
      ? Math.max(0, Math.min(1, patch.volume as number))
      : session.volume,
  };
  persist();
  return { ...session };
}

export function getTeslaAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (sharedAudioContext && sharedAudioContext.state !== 'closed') {
    return sharedAudioContext;
  }

  const Ctor =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext;
  if (!Ctor) return null;
  sharedAudioContext = new Ctor({ latencyHint: 'playback' });
  return sharedAudioContext;
}

function setMediaSessionState(state: MediaSessionPlaybackState): void {
  if (typeof navigator === 'undefined' || !('mediaSession' in navigator))
    return;
  try {
    navigator.mediaSession.playbackState = state;
  } catch {
    // Media Session is best-effort on embedded Chromium builds.
  }
}

function ensureFocusKeeper(context: AudioContext): HTMLAudioElement | null {
  if (
    focusAudioElement &&
    focusDestination &&
    focusSource &&
    focusGain &&
    focusAudioElement.srcObject === focusDestination.stream
  ) {
    return focusAudioElement;
  }

  try {
    focusDestination = context.createMediaStreamDestination();
    focusGain = context.createGain();
    // Keep an active but silent media track. It is deliberately separate from
    // the audible graph, so claiming the vehicle media session cannot add
    // latency or alter the A/V master clock.
    focusGain.gain.value = 0;
    focusGain.connect(focusDestination);

    if (typeof context.createConstantSource === 'function') {
      const source = context.createConstantSource();
      source.offset.value = 0;
      source.connect(focusGain);
      source.start();
      focusSource = source;
    } else {
      const source = context.createOscillator();
      source.frequency.value = 20;
      source.connect(focusGain);
      source.start();
      focusSource = source;
    }

    const audio = document.createElement('audio');
    audio.style.display = 'none';
    audio.autoplay = true;
    audio.setAttribute('playsinline', '');
    audio.setAttribute('aria-hidden', 'true');
    audio.srcObject = focusDestination.stream;
    document.body.appendChild(audio);
    focusAudioElement = audio;
    return audio;
  } catch {
    return null;
  }
}

/**
 * Best-effort Tesla/embedded-Chromium media-session claim.
 *
 * Web pages cannot call Android's native AudioManager directly. Keeping one
 * silent HTMLMediaElement active and marking Media Session as playing gives the
 * vehicle browser a stable media owner while the audible WebAudio graph is
 * rebuilt. The keeper never carries program audio, so it cannot create echo or
 * change synchronization.
 */
export async function claimTeslaAudioFocus(
  title = 'Tesla 视频播放'
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (focusReleaseTimer !== null) {
    window.clearTimeout(focusReleaseTimer);
    focusReleaseTimer = null;
  }

  const context = getTeslaAudioContext();
  if (!context) return false;
  try {
    await context.resume();
  } catch {
    return false;
  }

  const keeper = ensureFocusKeeper(context);
  try {
    if ('mediaSession' in navigator) {
      navigator.mediaSession.metadata = new MediaMetadata({
        title,
        artist: 'Tesla 播放器',
      });
    }
  } catch {
    // Metadata support differs between Tesla browser releases.
  }
  setMediaSessionState('playing');

  if (!keeper) return context.state === 'running';
  try {
    await keeper.play();
  } catch {
    // A previous explicit user gesture may still keep WebAudio available even
    // when the silent media keeper is blocked.
  }
  return context.state === 'running';
}

export function deferTeslaAudioFocusRelease(delayMs = 2500): void {
  if (typeof window === 'undefined') return;
  if (focusReleaseTimer !== null) window.clearTimeout(focusReleaseTimer);
  focusReleaseTimer = window.setTimeout(() => {
    focusReleaseTimer = null;
    try {
      focusAudioElement?.pause();
    } catch {
      // The page may already be tearing down; focus release is best-effort.
    }
    setMediaSessionState('none');
  }, Math.max(0, delayMs));
}

export async function unlockTeslaAudioSession(): Promise<boolean> {
  const context = getTeslaAudioContext();
  if (!context) {
    updateTeslaAudioSession({ unlocked: true, muted: false });
    return true;
  }

  try {
    await context.resume();
  } catch {
    return false;
  }

  const unlocked = context.state === 'running';
  if (unlocked) {
    updateTeslaAudioSession({ unlocked: true, muted: false });
    await claimTeslaAudioFocus();
  }
  return unlocked;
}
