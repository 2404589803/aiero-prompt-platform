/** 前后端共用的类型与常量。 */

export const JAILBREAK_VERSIONS = ['v1', 'v2', 'v3'] as const;
export type JailbreakVersion = (typeof JAILBREAK_VERSIONS)[number];

export const JOB_KINDS = ['list', 'extract', 'full'] as const;
export type JobKind = (typeof JOB_KINDS)[number];

export const JOB_STATUSES = [
  'queued',
  'running',
  'stopping',
  'stopped',
  'completed',
  'failed',
] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** 任务还没走完，前端应继续轮询。 */
export function isJobActive(status: JobStatus): boolean {
  return status === 'queued' || status === 'running' || status === 'stopping';
}

export const EXTRACT_STATUSES = ['pending', 'running', 'success', 'partial', 'failed'] as const;
export type ExtractStatus = (typeof EXTRACT_STATUSES)[number];

/** 抽取参数，对应原 CLI 的命令行开关。默认值与 scraper.py 保持一致。 */
export interface JobParams {
  /** 并发抽取数。 */
  workers: number;
  /** 列表每页条数。 */
  listLimit: number;
  /** 列表翻页间隔秒数，实际会再叠加 0~30% 的随机抖动。 */
  listDelay: number;
  /** 列表最多翻多少页。 */
  maxPages: number;
  /** 单次抽取最多续写多少轮。 */
  maxRounds: number;
  /** 两次抽取之间的间隔秒数，实际会再叠加 0~40% 的随机抖动。 */
  taskDelay: number;
  /** 使用哪些越狱提示词版本，按顺序尝试。 */
  jailbreakVersions: JailbreakVersion[];
  /** 'auto' 表示登录后拉平台全部可用模型；否则是 provider/name 列表。 */
  models: 'auto' | ModelRef[];
}

export interface ModelRef {
  provider: string;
  name: string;
}

export const DEFAULT_JOB_PARAMS: JobParams = {
  workers: 3,
  listLimit: 200,
  listDelay: 1.5,
  maxPages: 1000,
  maxRounds: 8,
  taskDelay: 1,
  jailbreakVersions: ['v1', 'v2', 'v3'],
  models: 'auto',
};

/** 任务进度计数，等价于原 progress.json 再加上列表同步的两项。 */
export interface JobStats {
  success: number;
  partial: number;
  failed: number;
  skipped: number;
  pagesDone: number;
  appsDiscovered: number;
}

export const EMPTY_JOB_STATS: JobStats = {
  success: 0,
  partial: 0,
  failed: 0,
  skipped: 0,
  pagesDone: 0,
  appsDiscovered: 0,
};

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  params: JobParams;
  stats: JobStats;
  error: string | null;
  createdBy: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
}

export interface AppSummary {
  appId: string;
  name: string | null;
  prePromptLength: number | null;
  worldBookLength: number | null;
  /** 站点的总榜热度分，不是名次：值越大越热门，量级到千亿。 */
  overallRank: number | null;
  avgCost: number | null;
  accountName: string | null;
  summary: string | null;
  discoveredAt: string;
  extractStatus: ExtractStatus;
  attempts: number;
  lastExtractedAt: string | null;
  lastError: string | null;
}

export interface Extraction {
  id: number;
  appId: string;
  jobId: string | null;
  status: 'success' | 'partial' | 'failed';
  promptText: string;
  promptVersion: string;
  modelProvider: string;
  modelName: string;
  attempts: number;
  error: string;
  conversationId: string;
  outputLength: number;
  expectedLength: number | null;
  extractedAt: string;
}

/** 提示词库列表的一行：角色卡信息 + 最新一次成功抽取的摘要。 */
export interface PromptListItem {
  appId: string;
  name: string | null;
  overallRank: number | null;
  accountName: string | null;
  extractStatus: ExtractStatus;
  promptVersion: string;
  modelProvider: string;
  modelName: string;
  outputLength: number;
  expectedLength: number | null;
  extractedAt: string;
  /** 提示词前若干字符，列表页预览用，避免把全文拉到浏览器。 */
  excerpt: string;
}

export interface JobLogEntry {
  id: number;
  level: 'debug' | 'info' | 'warn' | 'error';
  message: string;
  createdAt: string;
}

/** 总览数字，仪表盘和任务页共用。 */
export interface OverviewStats {
  appsTotal: number;
  pending: number;
  running: number;
  success: number;
  partial: number;
  failed: number;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiError {
  error: string;
  message: string;
}
