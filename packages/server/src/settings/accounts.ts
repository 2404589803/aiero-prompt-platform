/** 站点账号池的读写。运行期账号只从这里取，环境变量只用来给空表播种。 */

import type { ScraperAccount } from '@aiero/shared';
import { config } from '../config.js';
import { query, queryOne } from '../db.js';
import { decryptSecret, encryptSecret, isEncrypted } from './secret.js';

interface AccountRow {
  id: string;
  email: string;
  password_cipher: string;
  enabled: boolean;
  note: string | null;
  last_login_at: string | null;
  last_login_ok: boolean | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

/** 抽取时真正要用的东西：账号名和解开的密码。 */
export interface AccountCredential {
  id: string;
  email: string;
  password: string;
}

// 不含 password_cipher：对外的每一处都不该看到密码，靠列清单从源头掐掉，
// 比在映射函数里记得删字段可靠。
const PUBLIC_COLUMNS = `
  id, email, enabled, note, last_login_at, last_login_ok, last_error, created_at, updated_at
`;

function mapAccount(row: Omit<AccountRow, 'password_cipher'> & { encrypted?: boolean }) {
  const account: ScraperAccount = {
    id: row.id,
    email: row.email,
    enabled: row.enabled,
    note: row.note,
    passwordEncrypted: row.encrypted ?? false,
    lastLoginAt: row.last_login_at,
    lastLoginOk: row.last_login_ok,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  return account;
}

export async function listAccounts(): Promise<ScraperAccount[]> {
  const rows = await query<Omit<AccountRow, 'password_cipher'> & { encrypted: boolean }>(
    `SELECT ${PUBLIC_COLUMNS}, password_cipher LIKE 'gcm:%' AS encrypted
       FROM aiero.accounts
      ORDER BY enabled DESC, created_at`
  );
  return rows.map(mapAccount);
}

export async function getAccount(id: string): Promise<ScraperAccount | null> {
  const row = await queryOne<Omit<AccountRow, 'password_cipher'> & { encrypted: boolean }>(
    `SELECT ${PUBLIC_COLUMNS}, password_cipher LIKE 'gcm:%' AS encrypted
       FROM aiero.accounts WHERE id = $1`,
    [id]
  );
  return row ? mapAccount(row) : null;
}

/**
 * 启用中的账号，解密后交给抓取用。
 *
 * 单个账号解不开不该拖垮整个任务：跳过它并把原因写进 last_error，
 * 运营在页面上能看到「这个账号要重新录密码」。
 */
export async function listEnabledCredentials(): Promise<AccountCredential[]> {
  const rows = await query<Pick<AccountRow, 'id' | 'email' | 'password_cipher'>>(
    `SELECT id, email, password_cipher FROM aiero.accounts WHERE enabled ORDER BY created_at`
  );

  const credentials: AccountCredential[] = [];
  for (const row of rows) {
    try {
      credentials.push({
        id: row.id,
        email: row.email,
        password: decryptSecret(row.password_cipher),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await recordLoginResult(row.id, false, message);
    }
  }
  return credentials;
}

export async function countEnabled(): Promise<number> {
  const row = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM aiero.accounts WHERE enabled'
  );
  return row?.count ?? 0;
}

export async function createAccount(input: {
  email: string;
  password: string;
  note: string | null;
  enabled: boolean;
}): Promise<ScraperAccount> {
  const row = await queryOne<Omit<AccountRow, 'password_cipher'> & { encrypted: boolean }>(
    `INSERT INTO aiero.accounts (email, password_cipher, note, enabled)
     VALUES ($1, $2, $3, $4)
     RETURNING ${PUBLIC_COLUMNS}, password_cipher LIKE 'gcm:%' AS encrypted`,
    [input.email, encryptSecret(input.password), input.note, input.enabled]
  );
  if (!row) throw new Error('账号创建失败');
  return mapAccount(row);
}

/**
 * 更新账号。password 传空表示不动密码——页面上不回显密码，
 * 所以「只改备注」的场景必须能不带密码提交。
 */
export async function updateAccount(
  id: string,
  input: { email?: string; password?: string; note?: string | null; enabled?: boolean }
): Promise<ScraperAccount | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.email !== undefined) {
    sets.push(`email = $${values.push(input.email)}`);
  }
  if (input.password) {
    sets.push(`password_cipher = $${values.push(encryptSecret(input.password))}`);
    // 换了密码，旧的体检结论就作废了，免得页面上顶着一条过期的失败原因。
    sets.push('last_login_ok = NULL', 'last_error = NULL', 'last_login_at = NULL');
  }
  if (input.note !== undefined) {
    sets.push(`note = $${values.push(input.note)}`);
  }
  if (input.enabled !== undefined) {
    sets.push(`enabled = $${values.push(input.enabled)}`);
  }
  if (sets.length === 0) return getAccount(id);

  sets.push('updated_at = now()');
  const row = await queryOne<Omit<AccountRow, 'password_cipher'> & { encrypted: boolean }>(
    `UPDATE aiero.accounts SET ${sets.join(', ')}
      WHERE id = $${values.push(id)}
     RETURNING ${PUBLIC_COLUMNS}, password_cipher LIKE 'gcm:%' AS encrypted`,
    values
  );
  return row ? mapAccount(row) : null;
}

export async function deleteAccount(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM aiero.accounts WHERE id = $1 RETURNING id',
    [id]
  );
  return rows.length > 0;
}

export async function recordLoginResult(
  id: string,
  ok: boolean,
  error: string | null
): Promise<void> {
  await query(
    `UPDATE aiero.accounts
        SET last_login_at = now(), last_login_ok = $2, last_error = $3, updated_at = now()
      WHERE id = $1`,
    [id, ok, error]
  );
}

/** 随便借一个可用账号，用于向风月拉模型清单这类只读的探查。 */
export async function firstEnabledCredential(): Promise<AccountCredential | null> {
  const credentials = await listEnabledCredentials();
  return credentials[0] ?? null;
}

/** 取单个账号的凭据，登录体检用。 */
export async function getCredential(id: string): Promise<AccountCredential | null> {
  const row = await queryOne<Pick<AccountRow, 'id' | 'email' | 'password_cipher'>>(
    'SELECT id, email, password_cipher FROM aiero.accounts WHERE id = $1',
    [id]
  );
  if (!row) return null;
  return { id: row.id, email: row.email, password: decryptSecret(row.password_cipher) };
}

/**
 * 表为空时用 SCRAPER_ACCOUNTS 播种一次。
 *
 * 只在空表时做：运营在页面上把账号删干净是有意的动作，重启不该把它们复活。
 * 返回导入条数，供启动日志说明这次到底做了什么。
 */
export async function seedAccountsFromEnv(): Promise<number> {
  if (config.seedAccounts.length === 0) return 0;

  const existing = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM aiero.accounts'
  );
  if ((existing?.count ?? 0) > 0) return 0;

  let inserted = 0;
  for (const item of config.seedAccounts) {
    const rows = await query<{ id: string }>(
      `INSERT INTO aiero.accounts (email, password_cipher, note)
       VALUES ($1, $2, '由 SCRAPER_ACCOUNTS 环境变量导入')
       ON CONFLICT (email) DO NOTHING
       RETURNING id`,
      [item.email, encryptSecret(item.password)]
    );
    inserted += rows.length;
  }
  return inserted;
}

/** 库里是否还有明文密码，用来决定页面上要不要挂加密提示。 */
export async function hasPlaintextPassword(): Promise<boolean> {
  const row = await queryOne<{ count: number }>(
    `SELECT count(*)::int AS count FROM aiero.accounts WHERE password_cipher NOT LIKE 'gcm:%'`
  );
  return (row?.count ?? 0) > 0;
}

export { isEncrypted };
