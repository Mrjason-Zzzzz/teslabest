/** @jest-environment node */
import { persistRedisConfig } from './config-persistence';
import type { AdminConfig } from './admin.types';
import type { RedisAdapter } from './redis-adapter';

describe('persistent configuration writes', () => {
  it('keeps intentional deletion and assigns a new revision after commit', async () => {
    const config = { LiveConfig: [], _storageRevision: 'old' } as unknown as AdminConfig;
    const evalFn = jest.fn().mockResolvedValue(1);
    await persistRedisConfig({ eval: evalFn } as unknown as RedisAdapter, config);
    const [, keys, args] = evalFn.mock.calls[0];
    expect(keys).toEqual(['admin:config', 'admin:config:history', 'admin:config:latest']);
    expect(args[0]).toBe('old');
    expect(JSON.parse(args[1]).LiveConfig).toEqual([]);
    expect((config as any)._storageRevision).toBe(args[2]);
    expect(args[2]).not.toBe('old');
  });

  it('rejects a stale writer without advancing its revision', async () => {
    const config = { _storageRevision: 'old' } as unknown as AdminConfig;
    await expect(persistRedisConfig({ eval: jest.fn().mockResolvedValue(0) } as unknown as RedisAdapter, config)).rejects.toThrow('阻止旧配置覆盖');
    expect((config as any)._storageRevision).toBe('old');
  });

  it('propagates storage failures instead of reporting a successful save', async () => {
    const config = { _storageRevision: 'old' } as unknown as AdminConfig;
    await expect(persistRedisConfig({ eval: jest.fn().mockRejectedValue(new Error('offline')) } as unknown as RedisAdapter, config)).rejects.toThrow('offline');
    expect((config as any)._storageRevision).toBe('old');
  });
});
