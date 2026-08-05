import type {
  AccountCheckResult,
  AppSummary,
  AvailableModel,
  Extraction,
  ExtractStatus,
  JailbreakPrompt,
  Job,
  JobKind,
  JobLogPage,
  JobParams,
  OverviewStats,
  Paginated,
  PromptListItem,
  ScraperAccount,
} from '@aiero/shared';
import { supabase } from './supabase';

const API_URL = (import.meta.env.VITE_API_URL ?? '').replace(/\/+$/, '');

if (!API_URL) throw new Error('缺少 VITE_API_URL');

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;

  const response = await fetch(`${API_URL}${path}`, {
    ...init,
    headers: {
      // 只在真的有 body 时才声明 json。无条件加这个头的话，「停止任务」「体检」
      // 「重置」这些不带 body 的 POST/DELETE 会被 Fastify 以
      // 「Body cannot be empty when content-type is set to 'application/json'」挡掉。
      ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  });

  if (!response.ok) {
    const payload = (await response.json().catch(() => null)) as { message?: string } | null;
    throw new Error(payload?.message ?? `请求失败：HTTP ${response.status}`);
  }
  return (await response.json()) as T;
}

export interface JobLogOptions {
  /** 取多少条，省略按后端默认 200 条。 */
  limit?: number;
  /** 只看警告和错误。 */
  warnOnly?: boolean;
  /** 取最早的若干条而不是最新的，用来看任务开头那段配置。 */
  fromStart?: boolean;
}

export interface CurrentUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
}

export const api = {
  me: () => request<{ user: CurrentUser }>('/api/me').then((r) => r.user),

  overview: () => request<{ overview: OverviewStats }>('/api/overview').then((r) => r.overview),

  activeJob: () => request<{ job: Job | null }>('/api/jobs/active').then((r) => r.job),

  jobs: () => request<{ items: Job[] }>('/api/jobs').then((r) => r.items),

  jobLogs: (jobId: string, options: JobLogOptions = {}) => {
    const params = new URLSearchParams();
    if (options.limit) params.set('limit', String(options.limit));
    if (options.warnOnly) params.set('warnOnly', 'true');
    if (options.fromStart) params.set('fromStart', 'true');
    const query = params.toString();
    return request<JobLogPage>(`/api/jobs/${jobId}/logs${query ? `?${query}` : ''}`);
  },

  startJob: (kind: JobKind, params: JobParams) =>
    request<{ job: Job }>('/api/jobs', {
      method: 'POST',
      body: JSON.stringify({ kind, params }),
    }).then((r) => r.job),

  stopJob: (jobId: string) =>
    request<{ job: Job | null }>(`/api/jobs/${jobId}/stop`, { method: 'POST' }).then((r) => r.job),

  apps: (input: { page: number; pageSize: number; keyword?: string; status?: ExtractStatus }) =>
    request<Paginated<AppSummary>>(`/api/apps?${toQuery(input)}`),

  prompts: (input: {
    page: number;
    pageSize: number;
    keyword?: string;
    status?: 'success' | 'partial';
  }) => request<Paginated<PromptListItem>>(`/api/prompts?${toQuery(input)}`),

  promptDetail: (appId: string) =>
    request<{ items: Extraction[] }>(`/api/prompts/${appId}`).then((r) => r.items),

  resetApp: (appId: string) =>
    request<{ ok: true }>(`/api/apps/${appId}/reset`, { method: 'POST' }),

  accounts: () =>
    request<{ items: ScraperAccount[]; encryptionEnabled: boolean; hasPlaintext: boolean }>(
      '/api/accounts'
    ),

  createAccount: (input: { email: string; password: string; note: string | null }) =>
    request<{ account: ScraperAccount }>('/api/accounts', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.account),

  // password 不传表示不改密码：接口不回显密码，只改备注时不该被迫重填。
  updateAccount: (
    id: string,
    input: { email?: string; password?: string; note?: string | null; enabled?: boolean }
  ) =>
    request<{ account: ScraperAccount }>(`/api/accounts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.account),

  deleteAccount: (id: string) => request<{ ok: true }>(`/api/accounts/${id}`, { method: 'DELETE' }),

  checkAccount: (id: string) =>
    request<{ result: AccountCheckResult; account: ScraperAccount | null }>(
      `/api/accounts/${id}/check`,
      { method: 'POST' }
    ),

  // 现拉不缓存，要借一个账号登录风月，别放进会自动轮询的查询里。
  models: () => request<{ items: AvailableModel[] }>('/api/models').then((r) => r.items),

  jailbreakPrompts: () =>
    request<{ items: JailbreakPrompt[] }>('/api/jailbreak-prompts').then((r) => r.items),

  createJailbreakPrompt: (input: {
    name: string;
    content: string;
    enabled: boolean;
    sortOrder: number;
  }) =>
    request<{ prompt: JailbreakPrompt }>('/api/jailbreak-prompts', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.prompt),

  updateJailbreakPrompt: (
    id: string,
    input: { content?: string; enabled?: boolean; sortOrder?: number }
  ) =>
    request<{ prompt: JailbreakPrompt }>(`/api/jailbreak-prompts/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(input),
    }).then((r) => r.prompt),

  deleteJailbreakPrompt: (id: string) =>
    request<{ ok: true }>(`/api/jailbreak-prompts/${id}`, { method: 'DELETE' }),
};

function toQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}
