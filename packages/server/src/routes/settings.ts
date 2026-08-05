/** 抓取配置的接口：站点账号池与越狱提示词。 */

import type { FastifyInstance } from 'fastify';
import { JAILBREAK_CONTENT_MAX, JAILBREAK_NAME_MAX } from '@aiero/shared';
import type { AccountCheckResult } from '@aiero/shared';
import { requireAdmin, requireOperator } from '../auth.js';
import { config } from '../config.js';
import { jobRunner } from '../jobs/runner.js';
import { login } from '../scraper/client.js';
import * as accountStore from '../settings/accounts.js';
import * as promptStore from '../settings/prompts.js';

const EMAIL_MAX = 200;
const NOTE_MAX = 500;
const PASSWORD_MAX = 200;

function text(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) return null;
  return trimmed;
}

function optionalText(value: unknown, max: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, max);
}

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export default async function settingsRoutes(app: FastifyInstance): Promise<void> {
  // ── 账号池 ────────────────────────────────────────────────────────────────

  app.get('/api/accounts', { preHandler: requireAdmin }, async () => ({
    items: await accountStore.listAccounts(),
    // 页面据此决定要不要挂「密码明文存库」的提示。
    encryptionEnabled: Boolean(config.accountSecretKey),
    hasPlaintext: await accountStore.hasPlaintextPassword(),
  }));

  app.post('/api/accounts', { preHandler: requireOperator }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const email = text(body.email, EMAIL_MAX);
    const password = text(body.password, PASSWORD_MAX);
    if (!email) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: '账号不能为空' });
    }
    if (!password) {
      return reply.status(400).send({ error: 'BAD_REQUEST', message: '密码不能为空' });
    }

    try {
      const account = await accountStore.createAccount({
        email,
        password,
        note: optionalText(body.note, NOTE_MAX) ?? null,
        enabled: bool(body.enabled, true),
      });
      return reply.send({ account });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('accounts_email_key')) {
        return reply.status(409).send({ error: 'CONFLICT', message: '这个账号已经在池子里了' });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/accounts/:id',
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      // password 缺省表示不动密码：页面不回显密码，只改备注时不该被迫重填。
      const password = body.password === undefined ? undefined : text(body.password, PASSWORD_MAX);
      if (body.password !== undefined && !password) {
        return reply.status(400).send({ error: 'BAD_REQUEST', message: '密码不能为空' });
      }

      const account = await accountStore.updateAccount(request.params.id, {
        email: text(body.email, EMAIL_MAX) ?? undefined,
        password: password ?? undefined,
        note: optionalText(body.note, NOTE_MAX),
        enabled: body.enabled === undefined ? undefined : bool(body.enabled, true),
      });
      if (!account) return reply.status(404).send({ error: 'NOT_FOUND', message: '账号不存在' });
      return reply.send({ account });
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/accounts/:id',
    { preHandler: requireOperator },
    async (request, reply) => {
      // 正在跑的任务已经把账号加载进内存了，删掉不会中断它，但会让人误以为已经停了。
      if (jobRunner.isRunning()) {
        return reply
          .status(409)
          .send({ error: 'CONFLICT', message: '有任务在跑，先停止任务再删账号' });
      }
      const removed = await accountStore.deleteAccount(request.params.id);
      if (!removed) return reply.status(404).send({ error: 'NOT_FOUND', message: '账号不存在' });
      return reply.send({ ok: true });
    }
  );

  /**
   * 登录体检。
   *
   * 一个失效的账号不会让任务报错，只会让它领到的每张卡都抽失败，很难察觉。
   * 所以给个明确的按钮，加账号时先按一下，比事后翻日志便宜得多。
   */
  app.post<{ Params: { id: string } }>(
    '/api/accounts/:id/check',
    { preHandler: requireOperator },
    async (request, reply) => {
      const credential = await accountStore
        .getCredential(request.params.id)
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          return { error: message } as const;
        });

      if (credential && 'error' in credential) {
        await accountStore.recordLoginResult(request.params.id, false, credential.error);
        return reply.send({
          result: { ok: false, message: credential.error } satisfies AccountCheckResult,
          account: await accountStore.getAccount(request.params.id),
        });
      }
      if (!credential) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: '账号不存在' });
      }

      let result: AccountCheckResult;
      try {
        await login(credential.email, credential.password);
        result = { ok: true, message: '登录成功' };
      } catch (error) {
        result = { ok: false, message: error instanceof Error ? error.message : String(error) };
      }
      await accountStore.recordLoginResult(
        credential.id,
        result.ok,
        result.ok ? null : result.message
      );

      return reply.send({ result, account: await accountStore.getAccount(credential.id) });
    }
  );

  // ── 越狱提示词 ────────────────────────────────────────────────────────────

  app.get('/api/jailbreak-prompts', { preHandler: requireAdmin }, async () => ({
    items: await promptStore.listPrompts(),
  }));

  app.post('/api/jailbreak-prompts', { preHandler: requireOperator }, async (request, reply) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const name = text(body.name, JAILBREAK_NAME_MAX);
    const content = text(body.content, JAILBREAK_CONTENT_MAX);
    if (!name) {
      return reply
        .status(400)
        .send({ error: 'BAD_REQUEST', message: `名称不能为空，且不超过 ${JAILBREAK_NAME_MAX} 字` });
    }
    if (!content) {
      return reply.status(400).send({
        error: 'BAD_REQUEST',
        message: `正文不能为空，且不超过 ${JAILBREAK_CONTENT_MAX} 字`,
      });
    }

    try {
      const prompt = await promptStore.createPrompt({
        name,
        content,
        enabled: bool(body.enabled, true),
        sortOrder: Number.isFinite(Number(body.sortOrder)) ? Number(body.sortOrder) : 100,
        updatedBy: request.authUser?.email ?? null,
      });
      return reply.send({ prompt });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes('jailbreak_prompts_name_key')) {
        return reply.status(409).send({ error: 'CONFLICT', message: '这个名称已经有了' });
      }
      throw error;
    }
  });

  app.patch<{ Params: { id: string } }>(
    '/api/jailbreak-prompts/:id',
    { preHandler: requireOperator },
    async (request, reply) => {
      const body = (request.body ?? {}) as Record<string, unknown>;
      const content =
        body.content === undefined ? undefined : text(body.content, JAILBREAK_CONTENT_MAX);
      if (body.content !== undefined && !content) {
        return reply.status(400).send({
          error: 'BAD_REQUEST',
          message: `正文不能为空，且不超过 ${JAILBREAK_CONTENT_MAX} 字`,
        });
      }

      const prompt = await promptStore.updatePrompt(request.params.id, {
        content: content ?? undefined,
        enabled: body.enabled === undefined ? undefined : bool(body.enabled, true),
        sortOrder:
          body.sortOrder === undefined || !Number.isFinite(Number(body.sortOrder))
            ? undefined
            : Number(body.sortOrder),
        updatedBy: request.authUser?.email ?? null,
      });
      if (!prompt) return reply.status(404).send({ error: 'NOT_FOUND', message: '提示词不存在' });
      return reply.send({ prompt });
    }
  );

  app.delete<{ Params: { id: string } }>(
    '/api/jailbreak-prompts/:id',
    { preHandler: requireOperator },
    async (request, reply) => {
      if (jobRunner.isRunning()) {
        return reply
          .status(409)
          .send({ error: 'CONFLICT', message: '有任务在跑，先停止任务再删提示词' });
      }
      const removed = await promptStore.deletePrompt(request.params.id);
      if (!removed) return reply.status(404).send({ error: 'NOT_FOUND', message: '提示词不存在' });
      return reply.send({ ok: true });
    }
  );
}
