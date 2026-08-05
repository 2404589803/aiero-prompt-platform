/**
 * 站点账号密码的存储编码。
 *
 * 密码搬进数据库之后暴露面比环境变量大：测试库的连接串和 service_role key 在
 * 好几个地方出现过，一次库导出就等于把站点账号交出去。所以配了
 * ACCOUNT_SECRET_KEY 就用 AES-256-GCM 加密存，没配则退化成明文并在页面上明说，
 * 不因为缺一个环境变量就把功能卡死。
 *
 * 存储格式自带前缀，是为了让两种形态能共存：先上功能，之后补上密钥再就地升级，
 * 不用改表结构也不用停机。
 */

import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

const PLAIN_PREFIX = 'plain:';
const GCM_PREFIX = 'gcm:';
const IV_BYTES = 12;

/** GCM 的 key 必须是 32 字节，环境变量给的是任意长度字符串，这里压成定长。 */
function derivedKey(): Buffer | null {
  const raw = config.accountSecretKey;
  if (!raw) return null;
  return createHash('sha256').update(raw, 'utf8').digest();
}

export function encryptionEnabled(): boolean {
  return derivedKey() !== null;
}

export function encryptSecret(plain: string): string {
  const key = derivedKey();
  if (!key) return `${PLAIN_PREFIX}${plain}`;

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [
    GCM_PREFIX.slice(0, -1),
    iv.toString('base64'),
    tag.toString('base64'),
    encrypted.toString('base64'),
  ].join(':');
}

export function decryptSecret(stored: string): string {
  if (stored.startsWith(PLAIN_PREFIX)) return stored.slice(PLAIN_PREFIX.length);
  if (!stored.startsWith(GCM_PREFIX)) {
    // 没有前缀的历史数据按明文处理，避免升级过程中把已有账号弄成不可用。
    return stored;
  }

  const key = derivedKey();
  if (!key) {
    throw new Error('库里的密码是加密存的，但没有配置 ACCOUNT_SECRET_KEY，无法解密');
  }

  const [, ivPart, tagPart, dataPart] = stored.split(':');
  if (!ivPart || !tagPart || !dataPart) throw new Error('密码密文格式不对，需要重新录入');

  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivPart, 'base64'));
  decipher.setAuthTag(Buffer.from(tagPart, 'base64'));
  try {
    return Buffer.concat([
      decipher.update(Buffer.from(dataPart, 'base64')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // 认证失败基本只有一个原因：密钥换过了。提示要重新录入，别让人去猜。
    throw new Error('密码解密失败，可能 ACCOUNT_SECRET_KEY 变过，需要重新录入密码');
  }
}

export function isEncrypted(stored: string): boolean {
  return stored.startsWith(GCM_PREFIX);
}
