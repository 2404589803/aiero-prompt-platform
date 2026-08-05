/**
 * 运行期配置。全部来自环境变量，源码里不保留任何账号密码的默认值——
 * 这个仓库是公开的，凭据一旦写进源码就等于泄露，删掉也会留在 git 历史里。
 */

import { existsSync } from 'node:fs';

// 本地开发时自动读取仓库根目录的 .env；线上由 Railway 直接注入环境变量。
for (const candidate of ['.env', '../../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

export interface ScraperAccountConfig {
  email: string;
  password: string;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`缺少必需的环境变量 ${name}`);
  return value;
}

function optionalNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) throw new Error(`环境变量 ${name} 不是合法数字：${raw}`);
  return parsed;
}

/**
 * 站点账号池的种子，JSON 数组格式：
 *   SCRAPER_ACCOUNTS=[{"email":"a@b.c","password":"..."}]
 * 用 JSON 而不是逗号分隔，是因为密码里可能带分隔符。
 *
 * 账号的实际来源已经是 aiero.accounts 表。这个变量只在表为空时导入一次，
 * 之后改账号请走平台页面，改环境变量不会有任何效果。
 */
function parseAccounts(): ScraperAccountConfig[] {
  const raw = process.env.SCRAPER_ACCOUNTS;
  if (!raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('SCRAPER_ACCOUNTS 不是合法 JSON，应形如 [{"email":"...","password":"..."}]');
  }
  if (!Array.isArray(parsed)) throw new Error('SCRAPER_ACCOUNTS 应该是一个数组');

  return parsed.map((item, index) => {
    const entry = item as Partial<ScraperAccountConfig>;
    if (!entry?.email || !entry?.password) {
      throw new Error(`SCRAPER_ACCOUNTS 第 ${index + 1} 项缺少 email 或 password`);
    }
    return { email: entry.email, password: entry.password };
  });
}

function parseOrigins(): string[] {
  const raw = process.env.CORS_ORIGINS;
  if (!raw) return [];
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export const config = {
  port: optionalNumber('PORT', 8080),
  host: process.env.HOST ?? '0.0.0.0',

  /** 测试库的 Postgres 直连串。抓取任务要用 FOR UPDATE SKIP LOCKED，不走 PostgREST。 */
  databaseUrl: required('DATABASE_URL'),

  /**
   * 校验前端传来的 Supabase JWT 用。
   * 这里不用 required()：导入脚本这类只碰数据库的入口不该被登录配置挡住，
   * 缺失与否由 assertHttpConfig() 在服务启动时把关。
   */
  supabaseUrl: process.env.SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY ?? '',

  /** 只作为 aiero.accounts 空表时的一次性种子，不是运行期账号来源。 */
  seedAccounts: parseAccounts(),
  corsOrigins: parseOrigins(),

  /**
   * 站点账号密码的加密密钥，随便一串足够长的随机字符即可。
   * 不配也能跑，但密码会明文进库，页面上会挂提示。
   */
  accountSecretKey: process.env.ACCOUNT_SECRET_KEY ?? '',

  /**
   * 本地开发时跳过登录校验。生产环境设成 true 等于把平台裸奔在公网上，
   * 所以启动时会显式告警。
   */
  authDisabled: process.env.AUTH_DISABLED === 'true',

  /** running 状态超过这个时长仍无心跳，判定为容器已死，把卡放回 pending。 */
  staleClaimMinutes: optionalNumber('STALE_CLAIM_MINUTES', 30),
} as const;

/** 起 HTTP 服务才需要的配置。缺了就别启动，免得跑起来之后所有人都登不进去。 */
export function assertHttpConfig(): void {
  if (config.authDisabled) return;
  if (!config.supabaseUrl || !config.supabaseAnonKey) {
    throw new Error('缺少 SUPABASE_URL 或 SUPABASE_ANON_KEY，无法校验登录态');
  }
}

export function describeConfig(): Record<string, unknown> {
  return {
    port: config.port,
    corsOrigins: config.corsOrigins,
    authDisabled: config.authDisabled,
    passwordEncryption: config.accountSecretKey ? 'on' : 'off',
  };
}
