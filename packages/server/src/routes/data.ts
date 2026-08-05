import type { FastifyInstance } from 'fastify';
import { EXTRACT_STATUSES, type ExtractStatus } from '@aiero/shared';
import { requireAdmin, requireOperator } from '../auth.js';
import * as repo from '../jobs/repository.js';

interface PageQuery {
  page?: string;
  pageSize?: string;
  keyword?: string;
  status?: string;
}

function readPaging(queryString: PageQuery): { page: number; pageSize: number } {
  const page = Math.max(1, Number(queryString.page ?? 1) || 1);
  const pageSize = Math.min(100, Math.max(1, Number(queryString.pageSize ?? 20) || 20));
  return { page, pageSize };
}

function readKeyword(queryString: PageQuery): string | undefined {
  const keyword = queryString.keyword?.trim();
  return keyword ? keyword : undefined;
}

export default async function dataRoutes(app: FastifyInstance): Promise<void> {
  app.get('/api/me', { preHandler: requireAdmin }, async (request) => ({
    user: request.authUser,
  }));

  app.get('/api/overview', { preHandler: requireAdmin }, async () => ({
    overview: await repo.getOverview(),
  }));

  app.get<{ Querystring: PageQuery }>(
    '/api/apps',
    { preHandler: requireAdmin },
    async (request) => {
      const status = EXTRACT_STATUSES.includes(request.query.status as ExtractStatus)
        ? (request.query.status as ExtractStatus)
        : undefined;
      return repo.listApps({
        ...readPaging(request.query),
        keyword: readKeyword(request.query),
        status,
      });
    }
  );

  app.get<{ Querystring: PageQuery }>(
    '/api/prompts',
    { preHandler: requireAdmin },
    async (request) => {
      const status =
        request.query.status === 'success' || request.query.status === 'partial'
          ? request.query.status
          : undefined;
      return repo.listPrompts({
        ...readPaging(request.query),
        keyword: readKeyword(request.query),
        status,
      });
    }
  );

  /** 单张角色卡的全部抽取记录，含提示词全文。 */
  app.get<{ Params: { appId: string } }>(
    '/api/prompts/:appId',
    { preHandler: requireAdmin },
    async (request, reply) => {
      const items = await repo.getExtractionsForApp(request.params.appId);
      if (items.length === 0) {
        return reply.status(404).send({ error: 'NOT_FOUND', message: '该角色卡还没有抽取记录' });
      }
      return reply.send({ items });
    }
  );

  app.post<{ Params: { appId: string } }>(
    '/api/apps/:appId/reset',
    { preHandler: requireOperator },
    async (request, reply) => {
      const ok = await repo.resetApp(request.params.appId);
      if (!ok) return reply.status(404).send({ error: 'NOT_FOUND', message: '角色卡不存在' });
      return reply.send({ ok: true });
    }
  );
}
