import type {
  AppSummary,
  Extraction,
  ExtractStatus,
  Job,
  JobKind,
  JobLogEntry,
  JobParams,
  OverviewStats,
  Paginated,
  PromptListItem,
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
      'Content-Type': 'application/json',
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

  jobLogs: (jobId: string) =>
    request<{ items: JobLogEntry[] }>(`/api/jobs/${jobId}/logs`).then((r) => r.items),

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
};

function toQuery(input: Record<string, unknown>): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  return params.toString();
}
