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
  patch: Partial<TeslaAudioSessionSnapshot>,
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

  const Ctor = (window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext);
  if (!Ctor) return null;
  sharedAudioContext = new Ctor({ latencyHint: 'playback' });
  return sharedAudioContext;
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
  }
  return unlocked;
}
