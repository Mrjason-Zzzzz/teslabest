import crypto from 'crypto';

import { db } from '@/lib/db';
import type { WebLivePlatform } from '@/lib/tesla/web-live-source';

const SESSION_PREFIX = 'tesla:cast:session:';
const SESSION_TTL_MS = 5 * 60 * 1000;

export type CastPayload =
  | { type: 'direct'; url: string; label?: string }
  | { type: 'live'; platform: WebLivePlatform; roomId: string; label?: string }
  | { type: 'vod'; query: string; label?: string };

interface StoredCastSession {
  owner: string;
  token: string;
  expiresAt: number;
  payload?: CastPayload;
}

function sessionKey(sessionId: string): string {
  return `${SESSION_PREFIX}${sessionId}`;
}

function toPublicSession(
  sessionId: string,
  session: StoredCastSession
): Omit<StoredCastSession, 'token'> & { sessionId: string } {
  const { token: _token, ...safe } = session;
  return { sessionId, ...safe };
}

async function readSession(sessionId: string): Promise<StoredCastSession | null> {
  const raw = await db.getGlobalValue(sessionKey(sessionId));
  if (!raw) return null;
  try {
    const session = JSON.parse(raw) as StoredCastSession;
    if (!session.owner || !session.token || session.expiresAt <= Date.now()) {
      await db.deleteGlobalValue(sessionKey(sessionId));
      return null;
    }
    return session;
  } catch {
    await db.deleteGlobalValue(sessionKey(sessionId));
    return null;
  }
}

export async function createCastSession(owner: string) {
  const sessionId = crypto.randomBytes(12).toString('base64url');
  const token = crypto.randomBytes(24).toString('base64url');
  const session: StoredCastSession = {
    owner,
    token,
    expiresAt: Date.now() + SESSION_TTL_MS,
  };
  await db.setGlobalValue(sessionKey(sessionId), JSON.stringify(session));
  return { ...toPublicSession(sessionId, session), token };
}

export async function readCastSessionForOwner(
  sessionId: string,
  owner: string
) {
  const session = await readSession(sessionId);
  if (!session || session.owner !== owner) return null;
  return toPublicSession(sessionId, session);
}

export async function submitCastPayload(
  sessionId: string,
  token: string,
  payload: CastPayload
) {
  const session = await readSession(sessionId);
  if (!session || session.token !== token) return null;
  const next = { ...session, payload };
  await db.setGlobalValue(sessionKey(sessionId), JSON.stringify(next));
  return toPublicSession(sessionId, next);
}

export function isDirectPlayableUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    return /\.(?:m3u8|mp4|webm|m4v|flv)(?:$|[?#])/i.test(parsed.pathname + parsed.search);
  } catch {
    return false;
  }
}
