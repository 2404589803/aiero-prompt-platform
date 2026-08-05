import type { FastifyInstance } from 'fastify';
import { DEFAULT_JOB_PARAMS, JAILBREAK_VERSIONS, JOB_KINDS } from '@aiero/shared';
import type { JailbreakVersion, JobKind, JobParams, ModelRef } from '@aiero/shared';
import { requireAdmin, requireOperator } from '../auth.js';
import { JobAlreadyRunningError, jobRunner } from '../jobs/runner.js';
import * as repo from '../jobs/repository.js';

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * 把前端传来的参数收进安全范围。
 *
 * 上限不是防恶意，是防手滑：workers 填成 100 会瞬间把目标站点的限流打爆，
 * 连带把账号封掉，比任务慢一点严重得多。
 */
function normalizeParams(input: unknown): JobParams {
  const raw = (input ?? {}) as Partial<JobParams>;

  const versions = Array.isArray(raw.jailbreakVersions)
    ? raw.jailbreakVersions.filter((v): v is JailbreakVersion =>
        (JAILBREAK_VERSIONS as readonly string[]).includes(v)
      )
    : [];

  let models: JobParams['models'] = 'auto';
  if (Array.isArray(raw.models)) {
    const parsed = raw.models.filter(
      (m): m is ModelRef =>
        Boolean(m) && typeof m.provider === 'string' && typeof m.name === 'string'
    );
    if (parsed.length > 0) models = parsed;
  }

  return {
    workers: clamp(Number(raw.workers ?? DEFAULT_JOB_PARAMS.workers) || 1, 1, 16),
    listLimit: clamp(Number(raw.listLimit ?? DEFAULT_JOB_PARAMS.listLimit) || 200, 10, 500),
    listDelay: clamp(Number(raw.listDelay ?? DEFAULT_JOB_PARAMS.listDelay) || 1.5, 0.2, 60),
    maxPages: clamp(Number(raw.maxPages ?? DEFAULT_JOB_PARAMS.maxPages) || 1000, 1, 100_000),
    maxRounds: clamp(Number(raw.maxRounds ?? DEFAULT_JOB_PARAMS.maxRounds) || 8, 1, 30),
    taskDelay: clamp(Number(raw.taskDelay ?? DEFAULT_JOB_PARAMS.taskDelay) || 1, 0, 60),
    jailbreakVersions: versions.length > 0 ? versions : DEFAULT_JOB_PARAMS.jailbreakVersions,
    models,
  };
}

export default async function jobRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/jobs', { preHandler: requireAdmin }, async () => ({
    items: await repo.listJobs(20),
  }));

  app.get('/api/jobs/active', { preHandler: requireAdmin }, async () => ({
    job: await repo.getActiveJob(),
  }));

  app.post('/api/jobs', { preHandler: requireOperator }, async (request, reply) => {
    const body = (request.body ?? {}) as { kind?: string; params?: unknown };
    const kind = body.kind as JobKind;
    if (!JOB_KINDS.includes(kind)) {
      return reply
        .status(400)
        .send({ error: 'BAD_REQUEST', message: `未知任务类型：${body.kind}` });
    }

    try {
      const job = await jobRunner.start(
        kind,
        normalizeParams(body.params),
        request.authUser?.email ?? null
      );
      return reply.send({ job });
    } catch (error) {
      if (error instanceof JobAlreadyRunningError) {
        return reply.status(409).send({ error: 'CONFLICT', message: error.message });
      }
      const message = error instanceof Error ? error.message : String(error);
      return reply.status(500).send({ error: 'JOB_START_FAILED', message });
    }
  });

  app.post<{ Params: { id: string } }>(
    '/api/jobs/:id/stop',
    { preHandler: requireOperator },
    async (request, reply) => {
      const job = await repo.getJob(request.params.id);
      if (!job) return reply.status(404).send({ error: 'NOT_FOUND', message: '任务不存在' });

      if (jobRunner.currentJobId() === job.id) {
        await jobRunner.stop();
      } else {
        // 任务不在本进程里跑（比如实例被换过），改状态让持有者自己收尾。
        await repo.requestJobStop(job.id);
      }
      return reply.send({ job: await repo.getJob(job.id) });
    }
  );

  app.get<{ Params: { id: string } }>(
    '/api/jobs/:id/logs',
    { preHandler: requireAdmin },
    async (request) => ({ items: await repo.listJobLogs(request.params.id, 200) })
  );
}
