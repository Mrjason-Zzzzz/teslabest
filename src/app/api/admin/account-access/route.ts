import { NextRequest, NextResponse } from 'next/server';

import { invalidateUserAccessTokens } from '@/lib/access-token-invalidation';
import {
  AccessPlan,
  createAccountPolicy,
  generateRedemptionCode,
  getRedemptionCodeState,
  hashRedemptionCode,
  isAccessPlan,
  RedemptionCodeRecord,
} from '@/lib/account-access';
import { getAuthInfoFromCookie } from '@/lib/auth';
import { getConfig, setCachedConfig } from '@/lib/config';
import { db } from '@/lib/db';
import { revokeAllRefreshTokens } from '@/lib/refresh-token';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function requireOwner(request: NextRequest) {
  const authInfo = getAuthInfoFromCookie(request);
  if (!authInfo?.username || authInfo.username !== process.env.USERNAME) {
    return null;
  }
  return authInfo;
}

async function saveConfig(config: Awaited<ReturnType<typeof getConfig>>) {
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
  if (!(await requireOwner(request))) {
    return NextResponse.json({ error: '仅站长可管理兑换码和有效期' }, { status: 403 });
  }

  const config = await getConfig();
  return NextResponse.json(
    {
      requireRedemptionCode: config.SiteConfig.RequireRedemptionCode === true,
      codes: safeCodes(config.UserConfig.RedemptionCodes || []),
      policies: config.UserConfig.AccessPolicies || {},
    },
    { headers: { 'Cache-Control': 'no-store' } }
  );
}

export async function POST(request: NextRequest) {
  if (!(await requireOwner(request))) {
    return NextResponse.json({ error: '仅站长可管理兑换码和有效期' }, { status: 403 });
  }

  try {
    const body = await request.json();
    const config = await getConfig();
    config.UserConfig.AccessPolicies ||= {};
    config.UserConfig.RedemptionCodes ||= [];

    if (body.action === 'setRegistrationMode') {
      config.SiteConfig.RequireRedemptionCode = body.enabled === true;
      if (body.enabled === true) {
        config.SiteConfig.EnableRegistration = true;
      }
      await saveConfig(config);
      return NextResponse.json({ ok: true });
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
            typeof body.codeExpiresAt === 'number' && body.codeExpiresAt > Date.now()
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
        return NextResponse.json({ error: '已使用的兑换码不能作废' }, { status: 400 });
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
        return NextResponse.json({ error: '不能修改站长有效期' }, { status: 400 });
      }
      if (!isAccessPlan(plan)) {
        return NextResponse.json({ error: '有效期套餐无效' }, { status: 400 });
      }
      if (!(await db.checkUserExistV2(username))) {
        return NextResponse.json({ error: '用户不存在' }, { status: 404 });
      }

      config.UserConfig.AccessPolicies[username] = createAccountPolicy(
        plan,
        'admin',
        Date.now(),
        status
      );
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
