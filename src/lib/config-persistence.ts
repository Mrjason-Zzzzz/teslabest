import { randomUUID } from 'crypto';

import type { AdminConfig } from './admin.types';
import type { RedisAdapter } from './redis-adapter';

type VersionedConfig = AdminConfig & { _storageRevision?: string };

// One atomic operation: reject stale writers, retain the previous document,
// then persist the new document. Explicit deletions remain deleted.
export const CONFIG_SAVE_SCRIPT = `
local current = redis.call('GET', KEYS[1])
if current then
  local revision = cjson.decode(current)._storageRevision or ''
  if revision == ARGV[3] then return 1 end
  if revision ~= ARGV[1] then return 0 end
elseif ARGV[1] ~= '' then
  return 0
end
if current then
  redis.call('LPUSH', KEYS[2], current)
  redis.call('LTRIM', KEYS[2], 0, 29)
end
redis.call('SET', KEYS[1], ARGV[2])
redis.call('SET', KEYS[3], ARGV[2])
return 1
`;

export async function persistRedisConfig(
  adapter: RedisAdapter,
  config: VersionedConfig
): Promise<void> {
  const revision = randomUUID();
  const payload = JSON.stringify({ ...config, _storageRevision: revision });
  const result = await adapter.eval(CONFIG_SAVE_SCRIPT,
    ['admin:config', 'admin:config:history', 'admin:config:latest'],
    [config._storageRevision || '', payload, revision]);
  if (Number(result) !== 1) {
    throw new Error('配置已被其他请求更新或丢失，请刷新后台后重试；已阻止旧配置覆盖');
  }
  config._storageRevision = revision;
}
