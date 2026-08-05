import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { registerJsonBodyParser } from './json-body.js';

async function buildApp() {
  const app = Fastify();
  registerJsonBodyParser(app);
  app.post('/echo', async (request) => ({ body: request.body }));
  await app.ready();
  return app;
}

describe('json body 解析', () => {
  it('不带 body 但声明了 json 的请求当成空对象', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: {} });
    await app.close();
  });

  it('body 是空白字符也当成空对象', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '   ',
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: {} });
    await app.close();
  });

  it('正常的 json 照常解析', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify({ amount: 500 }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ body: { amount: 500 } });
    await app.close();
  });

  it('非空但不合法的 json 仍然 400，不当成空对象放行', async () => {
    const app = await buildApp();
    const response = await app.inject({
      method: 'POST',
      url: '/echo',
      headers: { 'content-type': 'application/json' },
      payload: '{ 坏掉的',
    });
    expect(response.statusCode).toBe(400);
    await app.close();
  });
});
