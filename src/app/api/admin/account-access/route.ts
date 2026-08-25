import { NextRequest, NextResponse } from 'next/server';

import { invalidateUserAccessTokens } from '@/lib/access-token-invalidation';
import {
  AccessPlan,
  createAccountPolicy,
  generateRedemptionCode,
  getRedemptionCodeState,
  hashRedemptionCode,
  isRedemptionRegistrationRequired,
  isAccessPlan,
  RedemptionCodeRecord,
} from '@/lib/account-access';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getFreshConfig, setCachedConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { revokeAllRefreshTokens } from '@/lib/refresh-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireAccountManager(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (
    !authInfo?.username ||
    (authInfo.role !== 'owner' && authInfo.role !== 'admin')
  ) {
    return null;
  }
  return authInfo;
}

async function saveConfig(config: Awaited<ReturnType<typeof getFreshConfig>>) {
  await db.saveAdminConfig(config);
  await setCachedConfig(config);
}

function safeCodes(codes: RedemptionCodeRecord[]) {
  return codes
    .map((record) => {
      const state = getRedemptionCodeState(record);
      const { codeHash: _codeHash, ...code } = record;
      return { ...code, state };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
}

export async function GET(request: NextRequest) {
  if (!(await requireAccountManager(request))) {
    return NextResponse.json(
      { error: '仅站长或管理员可管理兑换码' },
      { status: 403 }
    );
  }

  const config = await getFreshConfig();
  return NextResponse.json(
    {
      requireRedemptionCode: isRedemptionRegistrationRequired(
        config.SiteConfig
      ),
      membershipRenewalMessage:
        config.SiteConfig.MembershipRenewalMessage || '如需续费请联系站长',
      singleDeviceLoginEnabled:
        config.SiteConfig.SingleDeviceLoginEnabled !== false,
      codes: safeCodes(config.UserConfig.RedemptionCodes || []),
      policies: config.UserConfig.AccessPolicies || {},
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: NextRequest) {
  const manager = await requireAccountManager(request);
  if (!manager) {
    return NextResponse.json(
      { error: '仅站长或管理员可管理兑换码' },
      { status: 403 }
    );
  }

  try {
    const body = await request.json();
    const ownerOnlyActions = new Set([
      'setRegistrationMode',
      'setMembershipRenewalMessage',
      'setSingleDeviceMode',
      'updateUserAccess',
    ]);
    if (manager.role !== 'owner' && ownerOnlyActions.has(body.action)) {
      return NextResponse.json(
        { error: '该项全局设置仅站长可修改' },
        { status: 403 }
      );
    }
    const config = await getFreshConfig();
    config.UserConfig.AccessPolicies ||= {};
    config.UserConfig.RedemptionCodes ||= [];

    if (body.action === 'setRegistrationMode') {
      config.SiteConfig.RequireRedemptionCode = body.enabled === true;
      config.SiteConfig.RegistrationAccessMode = body.enabled
        ? 'redemption'
        : 'open';
      if (body.enabled === true) {
        config.SiteConfig.EnableRegistration = true;
      }
      await saveConfig(config);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'setMembershipRenewalMessage') {
      const message =
        typeof body.message === 'string'
          ? body.message.trim().slice(0, 120)
          : '';
      config.SiteConfig.MembershipRenewalMessage =
        message || '如需续费请联系站长';
      await saveConfig(config);
      return NextResponse.json({
        ok: true,
        message: config.SiteConfig.MembershipRenewalMessage,
      });
    }

    if (body.action === 'setSingleDeviceMode') {
      config.SiteConfig.SingleDeviceLoginEnabled = body.enabled !== false;
      await saveConfig(config);
      return NextResponse.json({
        ok: true,
        enabled: config.SiteConfig.SingleDeviceLoginEnabled,
      });
    }

    if (body.action === 'generateCodes') {
      const plan = body.plan as AccessPlan;
      const count = Math.max(1, Math.min(50, Number(body.count) || 1));
      if (!isAccessPlan(plan)) {
        return NextResponse.json({ error: '有效期套餐无效' }, { status: 400 });
      }

      const generated: string[] = [];
      const records: RedemptionCodeRecord[] = [];
      for (let index = 0; index < count; index += 1) {
        const code = generateRedemptionCode();
        const normalized = code.replace(/-/g, '');
        generated.push(code);
        records.push({
          id: crypto.randomUUID(),
          codeHash: await hashRedemptionCode(code),
          codeHint: `TSLA-****-${normalized.slice(-4)}`,
          plan,
          status: 'active',
          label:
            typeof body.label === 'string' && body.label.trim()
              ? body.label.trim().slice(0, 60)
              : undefined,
          createdAt: Date.now(),
          codeExpiresAt:
            typeof body.codeExpiresAt === 'number' &&
            body.codeExpiresAt > Date.now()
              ? body.codeExpiresAt
              : null,
        });
      }

      config.UserConfig.RedemptionCodes.unshift(...records);
      await saveConfig(config);
      return NextResponse.json({ ok: true, codes: generated });
    }

    if (body.action === 'revokeCode') {
      const record = config.UserConfig.RedemptionCodes.find(
        (item) => item.id === body.id
      );
      if (!record) {
        return NextResponse.json({ error: '兑换码不存在' }, { status: 404 });
      }
      if (record.status === 'used') {
        return NextResponse.json(
          { error: '已使用的兑换码不能作废' },
          { status: 400 }
        );
      }
      record.status = 'revoked';
      await saveConfig(config);
      return NextResponse.json({ ok: true });
    }

    if (body.action === 'updateUserAccess') {
      const username =
        typeof body.username === 'string' ? body.username.trim() : '';
      const plan = body.plan as AccessPlan;
      const status = body.status === 'disabled' ? 'disabled' : 'active';

      if (!username || username === process.env.USERNAME) {
        return NextResponse.json(
          { error: '不能修改站长有效期' },
          { status: 400 }
        );
      }
      if (!isAccessPlan(plan)) {
        return NextResponse.json({ error: '有效期套餐无效' }, { status: 400 });
      }
      if (!(await db.checkUserExistV2(username))) {
        return NextResponse.json({ error: '用户不存在' }, { status: 404 });
      }

      config.UserConfig.AccessPolicies[username] = {
        ...createAccountPolicy(plan, 'admin', Date.now(), status),
        allowMultiDevice: body.allowMultiDevice === true,
      };
      await saveConfig(config);

      invalidateUserAccessTokens(username);
      await revokeAllRefreshTokens(username);
      return NextResponse.json({
        ok: true,
        policy: config.UserConfig.AccessPolicies[username],
      });
    }

    return NextResponse.json({ error: '未知操作' }, { status: 400 });
  } catch (error) {
    console.error('账户权限管理失败:', error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : '账户权限管理失败' },
      { status: 500 }
    );
  }
}
