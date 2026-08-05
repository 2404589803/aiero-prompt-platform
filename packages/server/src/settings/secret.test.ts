import { afterEach, describe, expect, it, vi } from 'vitest';

const PASSWORD = '317665zz';

/**
 * secret.ts 在模块顶层读 config，config 又在模块顶层读环境变量，
 * 所以每个用例要重置模块缓存后再动态导入，不能靠改 process.env 就生效。
 */
async function loadWithKey(key: string | undefined) {
  vi.resetModules();
  if (key === undefined) delete process.env.ACCOUNT_SECRET_KEY;
  else process.env.ACCOUNT_SECRET_KEY = key;
  process.env.DATABASE_URL ??= 'postgresql://user:pass@localhost:5432/db';
  return import('./secret.js');
}

afterEach(() => {
  delete process.env.ACCOUNT_SECRET_KEY;
});

describe('站点密码的存储编码', () => {
  it('配了密钥就加密，解回来还是原文', async () => {
    const secret = await loadWithKey('a-long-enough-random-key');
    const stored = secret.encryptSecret(PASSWORD);

    expect(stored.startsWith('gcm:')).toBe(true);
    expect(stored).not.toContain(PASSWORD);
    expect(secret.decryptSecret(stored)).toBe(PASSWORD);
    expect(secret.isEncrypted(stored)).toBe(true);
  });

  it('同一个密码两次加密的密文不同，避免从密文相同推出密码相同', async () => {
    const secret = await loadWithKey('a-long-enough-random-key');
    expect(secret.encryptSecret(PASSWORD)).not.toBe(secret.encryptSecret(PASSWORD));
  });

  it('没配密钥就退化成带前缀的明文，功能不因缺变量卡死', async () => {
    const secret = await loadWithKey(undefined);
    const stored = secret.encryptSecret(PASSWORD);

    expect(stored).toBe(`plain:${PASSWORD}`);
    expect(secret.decryptSecret(stored)).toBe(PASSWORD);
    expect(secret.isEncrypted(stored)).toBe(false);
    expect(secret.encryptionEnabled()).toBe(false);
  });

  it('没有前缀的历史数据按明文读，升级过程中不会把已有账号弄坏', async () => {
    const secret = await loadWithKey('a-long-enough-random-key');
    expect(secret.decryptSecret(PASSWORD)).toBe(PASSWORD);
  });

  it('换过密钥的密文解不开时给出可操作的提示，而不是抛底层错误', async () => {
    const first = await loadWithKey('key-number-one');
    const stored = first.encryptSecret(PASSWORD);

    const second = await loadWithKey('key-number-two');
    expect(() => second.decryptSecret(stored)).toThrow(/重新录入/);
  });

  it('密文行遇到没配密钥的环境时明确报缺密钥，不会静默当明文用', async () => {
    const withKey = await loadWithKey('a-long-enough-random-key');
    const stored = withKey.encryptSecret(PASSWORD);

    const without = await loadWithKey(undefined);
    expect(() => without.decryptSecret(stored)).toThrow(/ACCOUNT_SECRET_KEY/);
  });
});
