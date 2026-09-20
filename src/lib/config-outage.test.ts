/** @jest-environment node */
jest.mock('./db', () => ({ db: { getAdminConfig: jest.fn(), saveAdminConfig: jest.fn() } }));
import { db } from './db';
import { clearConfigCache, getConfig, getFreshConfig } from './config';

describe('configuration outage protection', () => {
  const storageType = process.env.NEXT_PUBLIC_STORAGE_TYPE;
  beforeEach(async () => {
    process.env.NEXT_PUBLIC_STORAGE_TYPE = 'upstash';
    jest.clearAllMocks();
    await clearConfigCache();
  });
  afterAll(() => {
    if (storageType === undefined) delete process.env.NEXT_PUBLIC_STORAGE_TYPE;
    else process.env.NEXT_PUBLIC_STORAGE_TYPE = storageType;
  });
  it('never initializes defaults on a database error and retries next request', async () => {
    (db.getAdminConfig as jest.Mock).mockRejectedValue(new Error('offline'));
    await expect(getConfig()).rejects.toThrow('offline');
    await expect(getConfig()).rejects.toThrow('offline');
    expect(db.getAdminConfig).toHaveBeenCalledTimes(2);
    expect(db.saveAdminConfig).not.toHaveBeenCalled();
  });
  it('fresh write reads fail closed when the primary configuration is missing', async () => {
    (db.getAdminConfig as jest.Mock).mockResolvedValue(null);
    await expect(getFreshConfig()).rejects.toThrow('管理员配置缺失');
    expect(db.saveAdminConfig).not.toHaveBeenCalled();
  });
});
