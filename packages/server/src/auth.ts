import { createClient } from '@supabase/supabase-js';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import { queryOne } from './db.js';

export interface AuthUser {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    authUser?: AuthUser;
  }
}

const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const DEV_USER: AuthUser = {
  userId: '00000000-0000-0000-0000-000000000000',
  email: 'dev@local',
  displayName: '本地开发',
  role: 'owner',
};

/**
 * 校验前端带来的 Supabase JWT，并确认这个人在运营平台的管理员白名单里。
 *
 * 复用 admin.admin_users 而不是另建用户表：这个平台跟运营平台共用同一个测试库，
 * 能进运营平台的人就该能进这里，多一套账号只会多一处要维护的权限。
 */
export async function requireAdmin(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (config.authDisabled) {
    request.authUser = DEV_USER;
    return;
  }

  const header = request.headers.authorization;
  const token = header?.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) {
    await reply.status(401).send({ error: 'UNAUTHORIZED', message: '缺少登录凭证' });
    return;
  }

  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) {
    await reply.status(401).send({ error: 'UNAUTHORIZED', message: '登录已失效，请重新登录' });
    return;
  }

  const admin = await queryOne<{
    user_id: string;
    email: string;
    display_name: string | null;
    role: string;
  }>('SELECT user_id, email, display_name, role FROM admin.admin_users WHERE user_id = $1', [
    data.user.id,
  ]);

  if (!admin) {
    await reply.status(403).send({ error: 'FORBIDDEN', message: '该账号不在运营平台管理员名单中' });
    return;
  }

  request.authUser = {
    userId: admin.user_id,
    email: admin.email,
    displayName: admin.display_name,
    role: admin.role,
  };
}

/** 只读角色不能启停任务。 */
export async function requireOperator(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  await requireAdmin(request, reply);
  if (reply.sent) return;
  if (request.authUser?.role === 'viewer') {
    await reply.status(403).send({ error: 'FORBIDDEN', message: '只读账号不能执行该操作' });
  }
}
