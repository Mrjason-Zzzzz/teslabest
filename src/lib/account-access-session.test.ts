import { requiresSingleDeviceLogin } from './account-access';

describe('single device login policy', () => {
  test('is enabled by default for existing installations', () => {
    expect(requiresSingleDeviceLogin({ UserConfig: {} }, 'alice')).toBe(true);
  });

  test('allows an owner-configured per-user exception', () => {
    expect(
      requiresSingleDeviceLogin(
        {
          SiteConfig: { SingleDeviceLoginEnabled: true },
          UserConfig: {
            AccessPolicies: {
              alice: {
                plan: 'permanent',
                status: 'active',
                expiresAt: null,
                source: 'admin',
                createdAt: 1,
                updatedAt: 1,
                allowMultiDevice: true,
              },
            },
          },
        },
        'alice'
      )
    ).toBe(false);
  });

  test('can be disabled globally', () => {
    expect(
      requiresSingleDeviceLogin(
        {
          SiteConfig: { SingleDeviceLoginEnabled: false },
          UserConfig: {},
        },
        'alice'
      )
    ).toBe(false);
  });
});
