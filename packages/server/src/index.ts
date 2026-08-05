import Fastify from 'fastify';
import cors from '@fastify/cors';
import { assertHttpConfig, config, describeConfig } from './config.js';
import { pool } from './db.js';
import * as repo from './jobs/repository.js';
import dataRoutes from './routes/data.js';
import jobRoutes from './routes/jobs.js';

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

app.get('/health', async () => ({ ok: true, at: new Date().toISOString() }));

await app.register(jobRoutes);
await app.register(dataRoutes);

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

if (config.authDisabled) {
  app.log.warn('AUTH_DISABLED=true，接口不校验登录，仅限本地开发使用');
}
if (config.accounts.length === 0) {
  app.log.warn('未配置 SCRAPER_ACCOUNTS，只能同步列表，无法执行抽取');
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
