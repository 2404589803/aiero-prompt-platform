import type { FastifyInstance } from 'fastify';

/**
 * 把空 body 的 application/json 请求当成 `{}`。
 *
 * 「停止任务」「账号体检」「重置角色卡」这类接口本来就不需要参数，但只要客户端顺手
 * 带了 json 的 content-type，Fastify 默认解析器就会以
 * 「Body cannot be empty when content-type is set to 'application/json'」拒掉。
 * 各家客户端（浏览器 fetch、PowerShell、curl）在「要不要自动加这个头」上的默认行为
 * 都不一样，与其要求每个调用方都记得别加，不如在这里认下这种请求。
 *
 * body 非空但不是合法 JSON 时仍然报 400，不静默当成空对象——那属于调用方写错了。
 */
export function registerJsonBodyParser(app: FastifyInstance): void {
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (_request, body: string, done) => {
      if (!body || body.trim().length === 0) return done(null, {});
      try {
        done(null, JSON.parse(body));
      } catch (error) {
        const failure = error as Error & { statusCode?: number };
        failure.statusCode = 400;
        done(failure, undefined);
      }
    }
  );
}
