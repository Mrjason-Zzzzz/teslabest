'use client';

import { useCallback, useEffect, useState } from 'react';

type AccessPlan =
  | '1_day'
  | '1_month'
  | '3_months'
  | '6_months'
  | '12_months'
  | 'permanent';
type Policy = {
  plan: AccessPlan;
  status: 'active' | 'disabled';
  expiresAt: number | null;
  source: 'legacy' | 'admin' | 'redemption';
  createdAt: number;
  updatedAt: number;
};
type SafeCode = {
  id: string;
  codeHint: string;
  plan: AccessPlan;
  status: 'active' | 'used' | 'revoked';
  state: 'active' | 'used' | 'revoked' | 'expired';
  label?: string;
  createdAt: number;
  codeExpiresAt?: number | null;
  usedAt?: number;
  usedBy?: string;
};

const PLAN_LABELS: Record<AccessPlan, string> = {
  '1_day': '天卡（1天）',
  '1_month': '1个月',
  '3_months': '3个月',
  '6_months': '半年卡（6个月）',
  '12_months': '1年',
  permanent: '永久',
};

const STATE_LABELS: Record<SafeCode['state'], string> = {
  active: '未使用',
  used: '已使用',
  revoked: '已作废',
  expired: '已过期',
};

interface AccountAccessManagerProps {
  role: 'owner' | 'admin' | null;
  onChanged: () => Promise<void>;
}

export default function AccountAccessManager({
  role,
  onChanged,
}: AccountAccessManagerProps) {
  const [loading, setLoading] = useState(false);
  const [requireCode, setRequireCode] = useState(false);
  const [renewalMessage, setRenewalMessage] = useState('如需续费请联系站长');
  const [codes, setCodes] = useState<SafeCode[]>([]);
  const [policies, setPolicies] = useState<Record<string, Policy>>({});
  const [generatedCodes, setGeneratedCodes] = useState<string[]>([]);
  const [plan, setPlan] = useState<AccessPlan>('1_month');
  const [count, setCount] = useState(1);
  const [label, setLabel] = useState('');
  const [username, setUsername] = useState('');
  const [userPlan, setUserPlan] = useState<AccessPlan>('1_month');
  const [userStatus, setUserStatus] = useState<'active' | 'disabled'>('active');
  const [message, setMessage] = useState('');

  const load = useCallback(async () => {
    if (role !== 'owner' && role !== 'admin') return;
    const response = await fetch('/api/admin/account-access', {
      cache: 'no-store',
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '读取账户权限失败');
    setRequireCode(Boolean(data.requireRedemptionCode));
    setRenewalMessage(data.membershipRenewalMessage || '如需续费请联系站长');
    setCodes(data.codes || []);
    setPolicies(data.policies || {});
  }, [role]);

  useEffect(() => {
    load().catch((error) =>
      setMessage(error instanceof Error ? error.message : '读取账户权限失败')
    );
  }, [load]);

  async function post(body: Record<string, unknown>) {
    setLoading(true);
    setMessage('');
    try {
      const response = await fetch('/api/admin/account-access', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || '操作失败');
      return data;
    } finally {
      setLoading(false);
    }
  }

  async function toggleRegistration() {
    try {
      await post({
        action: 'setRegistrationMode',
        enabled: !requireCode,
      });
      setRequireCode(!requireCode);
      setMessage(!requireCode ? '已启用兑换码注册' : '已恢复原注册方式');
      await onChanged();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '操作失败');
    }
  }

  async function generateCodes() {
    try {
      const data = await post({
        action: 'generateCodes',
        plan,
        count,
        label,
      });
      setGeneratedCodes(data.codes || []);
      setMessage('兑换码已生成；明文只显示这一次，请立即复制保存。');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '生成失败');
    }
  }

  async function saveRenewalMessage() {
    try {
      const data = await post({
        action: 'setMembershipRenewalMessage',
        message: renewalMessage,
      });
      setRenewalMessage(data.message || '如需续费请联系站长');
      setMessage('会员续费提示语已保存并实时生效');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '保存失败');
    }
  }

  async function revokeCode(id: string) {
    try {
      await post({ action: 'revokeCode', id });
      setMessage('兑换码已作废');
      await load();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '作废失败');
    }
  }

  async function updateUserAccess() {
    if (!username.trim()) {
      setMessage('请输入用户名');
      return;
    }
    try {
      await post({
        action: 'updateUserAccess',
        username: username.trim(),
        plan: userPlan,
        status: userStatus,
      });
      setMessage(
        userStatus === 'disabled'
          ? `${username.trim()} 已停用并撤销现有会话`
          : `${username.trim()} 已更新为${PLAN_LABELS[userPlan]}`
      );
      await Promise.all([load(), onChanged()]);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '更新失败');
    }
  }

  if (role !== 'owner' && role !== 'admin') {
    return (
      <div className='rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200'>
        当前账号无兑换码管理权限。
      </div>
    );
  }

  return (
    <section className='space-y-4 rounded-2xl border border-blue-200 bg-blue-50/60 p-4 dark:border-blue-800 dark:bg-blue-950/20'>
      <div className='flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between'>
        <div>
          <h4 className='font-semibold text-gray-900 dark:text-gray-100'>
            账户有效期与兑换码
          </h4>
          <p className='mt-1 text-xs text-gray-600 dark:text-gray-400'>
            旧账号默认永久有效；新兑换码一码一用，天卡与月卡均从注册成功时开始计算。
          </p>
        </div>
        {role === 'owner' && <button
          type='button'
          disabled={loading}
          onClick={toggleRegistration}
          className={`rounded-lg px-4 py-2 text-sm font-medium text-white transition-colors ${
            requireCode
              ? 'bg-green-600 hover:bg-green-700'
              : 'bg-gray-600 hover:bg-gray-700'
          } disabled:opacity-50`}
        >
          {requireCode ? '兑换码注册：已开启' : '启用兑换码注册'}
        </button>}
      </div>

      {message && (
        <div className='rounded-lg bg-white/80 px-3 py-2 text-sm text-blue-800 dark:bg-gray-900/70 dark:text-blue-200'>
          {message}
        </div>
      )}

      {role === 'owner' && <div className='rounded-xl bg-white p-4 shadow-sm dark:bg-gray-900'>
        <label className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
          会员续费提示语
        </label>
        <div className='mt-2 flex flex-col gap-2 sm:flex-row'>
          <input
            value={renewalMessage}
            maxLength={120}
            onChange={(event) => setRenewalMessage(event.target.value)}
            className='min-w-0 flex-1 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800'
            placeholder='如需续费请联系站长'
          />
          <button
            type='button'
            disabled={loading}
            onClick={saveRenewalMessage}
            className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
          >
            保存提示语
          </button>
        </div>
        <p className='mt-1 text-xs text-gray-500 dark:text-gray-400'>
          保存后用户个人中心立即读取新文案；永久会员不会显示该提示。
        </p>
      </div>}

      <div className='grid gap-4 lg:grid-cols-2'>
        <div className='space-y-3 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-900'>
          <h5 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            生成兑换码
          </h5>
          <div className='mb-3 grid grid-cols-2 gap-2 sm:grid-cols-3'>
            {Object.entries(PLAN_LABELS).map(([value, text]) => (
              <button
                key={value}
                type='button'
                onClick={() => setPlan(value as AccessPlan)}
                className={`min-h-12 rounded-xl border px-3 py-2 text-sm font-medium transition active:scale-95 ${
                  plan === value
                    ? 'border-violet-500 bg-violet-600 text-white'
                    : 'border-gray-300 bg-white text-gray-700 dark:border-gray-700 dark:bg-gray-800 dark:text-gray-200'
                }`}
              >
                {text}
              </button>
            ))}
          </div>
          <div className='grid grid-cols-1 gap-3 sm:grid-cols-2'>
            <input
              type='number'
              min={1}
              max={50}
              value={count}
              onChange={(event) =>
                setCount(
                  Math.max(1, Math.min(50, Number(event.target.value) || 1))
                )
              }
              className='rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800'
              placeholder='数量'
            />
            <input
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              className='rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800'
              placeholder='备注（可选）'
            />
          </div>
          <button
            type='button'
            disabled={loading}
            onClick={generateCodes}
            className='rounded-lg bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50'
          >
            {loading ? '处理中...' : '生成兑换码'}
          </button>

          {generatedCodes.length > 0 && (
            <div className='rounded-lg border border-green-300 bg-green-50 p-3 dark:border-green-800 dark:bg-green-900/20'>
              <div className='mb-2 flex items-center justify-between'>
                <span className='text-xs font-semibold text-green-800 dark:text-green-200'>
                  新兑换码（仅本次显示）
                </span>
                <button
                  type='button'
                  onClick={() =>
                    navigator.clipboard.writeText(generatedCodes.join('\n'))
                  }
                  className='text-xs font-medium text-green-700 underline dark:text-green-300'
                >
                  全部复制
                </button>
              </div>
              <pre className='overflow-x-auto whitespace-pre-wrap break-all font-mono text-sm text-green-900 dark:text-green-100'>
                {generatedCodes.join('\n')}
              </pre>
            </div>
          )}
        </div>

        {role === 'owner' && <div className='space-y-3 rounded-xl bg-white p-4 shadow-sm dark:bg-gray-900'>
          <h5 className='text-sm font-semibold text-gray-900 dark:text-gray-100'>
            修改账户有效期
          </h5>
          <input
            value={username}
            onChange={(event) => setUsername(event.target.value)}
            className='w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800'
            placeholder='输入用户名'
          />
          <div className='grid grid-cols-2 gap-3'>
            <select
              value={userPlan}
              onChange={(event) =>
                setUserPlan(event.target.value as AccessPlan)
              }
              className='rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800'
            >
              {Object.entries(PLAN_LABELS).map(([value, text]) => (
                <option key={value} value={value}>
                  {text}
                </option>
              ))}
            </select>
            <select
              value={userStatus}
              onChange={(event) =>
                setUserStatus(event.target.value as 'active' | 'disabled')
              }
              className='rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm dark:border-gray-700 dark:bg-gray-800'
            >
              <option value='active'>正常</option>
              <option value='disabled'>停用</option>
            </select>
          </div>
          <button
            type='button'
            disabled={loading}
            onClick={updateUserAccess}
            className='rounded-lg bg-indigo-600 px-4 py-2 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50'
          >
            保存并让旧会话失效
          </button>
          <p className='text-xs text-gray-500 dark:text-gray-400'>
            重新选择天卡或 1/3/6/12 个月会从现在重新计时；选择永久则不设到期日。
          </p>
        </div>}
      </div>

      <div className='overflow-x-auto rounded-xl border border-gray-200 bg-white dark:border-gray-800 dark:bg-gray-900'>
        <table className='min-w-full text-sm'>
          <thead className='bg-gray-50 text-left text-xs text-gray-500 dark:bg-gray-800'>
            <tr>
              <th className='px-3 py-2'>兑换码</th>
              <th className='px-3 py-2'>套餐</th>
              <th className='px-3 py-2'>状态</th>
              <th className='px-3 py-2'>使用账户</th>
              <th className='px-3 py-2'>备注</th>
              <th className='px-3 py-2 text-right'>操作</th>
            </tr>
          </thead>
          <tbody>
            {codes.slice(0, 100).map((code) => (
              <tr
                key={code.id}
                className='border-t border-gray-100 dark:border-gray-800'
              >
                <td className='px-3 py-2 font-mono'>{code.codeHint}</td>
                <td className='px-3 py-2'>{PLAN_LABELS[code.plan]}</td>
                <td className='px-3 py-2'>{STATE_LABELS[code.state]}</td>
                <td className='px-3 py-2'>{code.usedBy || '-'}</td>
                <td className='px-3 py-2'>{code.label || '-'}</td>
                <td className='px-3 py-2 text-right'>
                  {code.state === 'active' && (
                    <button
                      type='button'
                      disabled={loading}
                      onClick={() => revokeCode(code.id)}
                      className='text-xs font-medium text-red-600 hover:text-red-700'
                    >
                      作废
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {codes.length === 0 && (
              <tr>
                <td colSpan={6} className='px-3 py-6 text-center text-gray-500'>
                  暂无兑换码
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {Object.keys(policies).length > 0 && (
        <p className='text-xs text-gray-500 dark:text-gray-400'>
          已设置有效期账户：{Object.keys(policies).length}{' '}
          个。具体到期时间会显示在下方用户列表。
        </p>
      )}
    </section>
  );
}
