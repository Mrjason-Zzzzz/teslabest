export type AccessPlan =
  | '1_day'
  | '1_month'
  | '3_months'
  | '6_months'
  | '12_months'
  | 'permanent';
export type AccountAccessStatus = 'active' | 'disabled';
export type AccountAccessSource = 'legacy' | 'admin' | 'redemption';

export interface AccountAccessPolicy {
  plan: AccessPlan;
  status: AccountAccessStatus;
  expiresAt: number | null;
  source: AccountAccessSource;
  createdAt: number;
  updatedAt: number;
}

export interface RedemptionCodeRecord {
  id: string;
  codeHash: string;
  codeHint: string;
  plan: AccessPlan;
  status: 'active' | 'used' | 'revoked';
  label?: string;
  createdAt: number;
  codeExpiresAt?: number | null;
  usedAt?: number;
  usedBy?: string;
}

type AccessConfig = {
  UserConfig?: {
    AccessPolicies?: Record<string, AccountAccessPolicy>;
    RedemptionCodes?: RedemptionCodeRecord[];
  };
};

type RegistrationSiteConfig = {
  RegistrationAccessMode?: 'redemption' | 'open';
  RequireRedemptionCode?: boolean;
};

export const DEFAULT_MEMBERSHIP_RENEWAL_MESSAGE = '如需续费请联系站长';

export function isRedemptionRegistrationRequired(
  siteConfig: RegistrationSiteConfig
): boolean {
  if (siteConfig.RegistrationAccessMode) {
    return siteConfig.RegistrationAccessMode === 'redemption';
  }
  // Existing installations did not have an explicit mode and could silently
  // inherit `false`. P002 migrates that ambiguous state to redemption mode;
  // the owner can explicitly switch it to `open` from the admin panel.
  return true;
}

export const ACCESS_PLAN_LABELS: Record<AccessPlan, string> = {
  '1_day': '天卡',
  '1_month': '1个月',
  '3_months': '3个月',
  '6_months': '半年',
  '12_months': '1年',
  permanent: '永久',
};

export function isAccessPlan(value: unknown): value is AccessPlan {
  return (
    value === '1_day' ||
    value === '1_month' ||
    value === '3_months' ||
    value === '6_months' ||
    value === '12_months' ||
    value === 'permanent'
  );
}

function addUtcMonths(timestamp: number, months: number): number {
  const date = new Date(timestamp);
  const originalDay = date.getUTCDate();
  date.setUTCDate(1);
  date.setUTCMonth(date.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 0)
  ).getUTCDate();
  date.setUTCDate(Math.min(originalDay, lastDay));
  return date.getTime();
}

export function createAccountPolicy(
  plan: AccessPlan,
  source: AccountAccessSource = 'admin',
  now = Date.now(),
  status: AccountAccessStatus = 'active'
): AccountAccessPolicy {
  if (!isAccessPlan(plan)) {
    throw new Error('账户有效期套餐无效');
  }

  const months =
    plan === '1_month'
      ? 1
      : plan === '3_months'
      ? 3
      : plan === '6_months'
      ? 6
      : plan === '12_months'
      ? 12
      : 0;

  return {
    plan,
    status,
    expiresAt:
      plan === '1_day'
        ? now + 24 * 60 * 60 * 1000
        : months > 0
        ? addUtcMonths(now, months)
        : null,
    source,
    createdAt: now,
    updatedAt: now,
  };
}

export function resolveAccountAccess(
  config: AccessConfig,
  username: string,
  now = Date.now()
): AccountAccessPolicy & { isExpired: boolean } {
  const policy = config.UserConfig?.AccessPolicies?.[username];
  const normalized: AccountAccessPolicy =
    policy && isAccessPlan(policy.plan)
      ? {
          plan: policy.plan,
          status: policy.status === 'disabled' ? 'disabled' : 'active',
          expiresAt:
            typeof policy.expiresAt === 'number' &&
            Number.isFinite(policy.expiresAt)
              ? policy.expiresAt
              : null,
          source: policy.source || 'admin',
          createdAt: policy.createdAt || now,
          updatedAt: policy.updatedAt || now,
        }
      : createAccountPolicy('permanent', 'legacy', now);

  return {
    ...normalized,
    isExpired: normalized.expiresAt !== null && normalized.expiresAt <= now,
  };
}

export function normalizeRedemptionCode(code: string): string {
  return code.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

export async function hashRedemptionCode(code: string): Promise<string> {
  const normalized = normalizeRedemptionCode(code);
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(normalized)
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

export function generateRedemptionCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  const body = Array.from(
    bytes,
    (byte) => alphabet[byte % alphabet.length]
  ).join('');
  return `TSLA-${body.slice(0, 4)}-${body.slice(4, 8)}-${body.slice(
    8,
    12
  )}-${body.slice(12, 16)}`;
}

export function getRedemptionCodeState(
  code: RedemptionCodeRecord,
  now = Date.now()
): 'active' | 'used' | 'revoked' | 'expired' {
  if (code.status === 'used') return 'used';
  if (code.status === 'revoked') return 'revoked';
  if (code.codeExpiresAt && code.codeExpiresAt <= now) return 'expired';
  return 'active';
}
