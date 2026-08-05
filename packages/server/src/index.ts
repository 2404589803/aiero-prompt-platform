import Fastify from 'fastify';
import cors from '@fastify/cors';
import { assertHttpConfig, config, describeConfig } from './config.js';
import { pool } from './db.js';
import { registerJsonBodyParser } from './json-body.js';
import * as repo from './jobs/repository.js';
import dataRoutes from './routes/data.js';
import jobRoutes from './routes/jobs.js';
import settingsRoutes from './routes/settings.js';
import * as accountStore from './settings/accounts.js';
import * as promptStore from './settings/prompts.js';

assertHttpConfig();

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  // 提示词全文可能上万字，默认 1MB 的请求体上限对写入路径够用，这里放宽一点余量。
  bodyLimit: 4 * 1024 * 1024,
});

await app.register(cors, {
  origin: config.corsOrigins.length > 0 ? config.corsOrigins : true,
  credentials: true,
});

registerJsonBodyParser(app);

app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

await app.register(jobRoutes);
await app.register(dataRoutes);
await app.register(settingsRoutes);

/**
 * 启动时回收上一次进程留下的残局。
 *
 * 能执行到这里就说明进程是新的，数据库里任何 running 的任务和角色卡都不可能还有人在跑，
 * 不清理的话它们会永远卡在 running，队列越来越小最后无卡可抽。
 */
const reclaimed = await repo.reclaimAbandonedWork(config.staleClaimMinutes);
if (reclaimed.jobs > 0 || reclaimed.apps > 0) {
  app.log.warn(`回收上次中断的残留：任务 ${reclaimed.jobs} 个，角色卡 ${reclaimed.apps} 张`);
}

// 账号池和提示词的来源是数据库，这里只负责给空库播种，让新环境起来就能用。
const seededAccounts = await accountStore.seedAccountsFromEnv();
if (seededAccounts > 0) {
  app.log.info(`账号池为空，已从 SCRAPER_ACCOUNTS 导入 ${seededAccounts} 个账号`);
}
const seededPrompts = await promptStore.seedPromptsIfEmpty();
if (seededPrompts > 0) {
  app.log.info(`提示词库为空，已写入 ${seededPrompts} 版内置越狱提示词`);
}

if (config.authDisabled) {
  app.log.warn('AUTH_DISABLED=true，接口不校验登录，仅限本地开发使用');
}
if ((await accountStore.countEnabled()) === 0) {
  app.log.warn('账号池里没有启用的账号，只能同步列表，无法执行抽取');
}
if (!config.accountSecretKey) {
  app.log.warn('未配置 ACCOUNT_SECRET_KEY，站点账号密码将以明文存库');
}

await app.listen({ port: config.port, host: config.host });
app.log.info(describeConfig(), '服务已启动');

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void (async () => {
      app.log.info(`收到 ${signal}，正在关闭`);
      await app.close();
      await pool.end();
      process.exit(0);
    })();
  });
}
