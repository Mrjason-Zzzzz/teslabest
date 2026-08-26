export type LiveChannelIdentity = {
  id?: string;
  legacyId?: string;
  tvgId?: string;
  name?: string;
  group?: string;
  url?: string;
};

export function normalizeLiveChannelText(value: string | null | undefined) {
  return String(value || '')
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\s\-_–—·•，,.。：:()【】]+/g, '')
    .replace(/\[/g, '')
    .replace(/]/g, '');
}

export function getLiveUrlFingerprint(value: string | null | undefined) {
  try {
    const parsed = new URL(String(value || ''));
    return `${parsed.hostname.toLowerCase()}${parsed.pathname.replace(
      /\/+$/,
      ''
    )}`;
  } catch {
    return String(value || '').split('?')[0].trim().toLowerCase();
  }
}

function stableHash(value: string) {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index++) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export function createStableLiveChannelId(
  sourceKey: string,
  channel: Omit<LiveChannelIdentity, 'id' | 'legacyId'>
) {
  const identity = [
    normalizeLiveChannelText(channel.tvgId),
    normalizeLiveChannelText(channel.name),
    normalizeLiveChannelText(channel.group),
    getLiveUrlFingerprint(channel.url),
  ].join('|');
  return `${sourceKey}-${stableHash(identity)}`;
}

/**
 * Match one and only one channel identity. A failure is safer than silently
 * substituting the first/next channel while a signed IPTV URL is refreshed.
 */
export function findSameLiveChannel<T extends LiveChannelIdentity>(
  channels: T[],
  target: LiveChannelIdentity
): T | null {
  const exactId = channels.find(
    (channel) =>
      Boolean(target.id) &&
      (channel.id === target.id || channel.legacyId === target.id)
  );
  if (exactId) return exactId;

  const wantedTvg = normalizeLiveChannelText(target.tvgId);
  const wantedName = normalizeLiveChannelText(target.name);
  const wantedGroup = normalizeLiveChannelText(target.group);
  const wantedUrl = getLiveUrlFingerprint(target.url);

  const narrowUnique = (items: T[]) => (items.length === 1 ? items[0] : null);
  if (wantedTvg) {
    const tvgMatches = channels.filter(
      (channel) => normalizeLiveChannelText(channel.tvgId) === wantedTvg
    );
    const exactMetadata = tvgMatches.filter(
      (channel) =>
        (!wantedName || normalizeLiveChannelText(channel.name) === wantedName) &&
        (!wantedGroup ||
          normalizeLiveChannelText(channel.group) === wantedGroup)
    );
    const uniqueMetadata = narrowUnique(exactMetadata);
    if (uniqueMetadata) return uniqueMetadata;
    const exactUrl = tvgMatches.filter(
      (channel) => wantedUrl && getLiveUrlFingerprint(channel.url) === wantedUrl
    );
    const uniqueUrl = narrowUnique(exactUrl);
    if (uniqueUrl) return uniqueUrl;
    const uniqueTvg = narrowUnique(tvgMatches);
    if (uniqueTvg) return uniqueTvg;
  }

  if (wantedName) {
    const nameMatches = channels.filter(
      (channel) => normalizeLiveChannelText(channel.name) === wantedName
    );
    const groupMatches = nameMatches.filter(
      (channel) =>
        wantedGroup && normalizeLiveChannelText(channel.group) === wantedGroup
    );
    const uniqueGroup = narrowUnique(groupMatches);
    if (uniqueGroup) return uniqueGroup;
    const urlMatches = nameMatches.filter(
      (channel) => wantedUrl && getLiveUrlFingerprint(channel.url) === wantedUrl
    );
    const uniqueUrl = narrowUnique(urlMatches);
    if (uniqueUrl) return uniqueUrl;
    return narrowUnique(nameMatches);
  }

  return null;
}
