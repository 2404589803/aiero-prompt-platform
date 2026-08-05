/**
 * 本地开发时把仓库根目录的 .env 读进 process.env；线上由 Railway 直接注入。
 *
 * 单独成一个模块，是因为读环境变量的地方不止 config：抓取那边的常量也要读，
 * 而它不该为了「先加载 .env」去依赖整个 config（config 在导入时就会校验
 * DATABASE_URL，把这份负担传染给单测里的纯函数模块没有道理）。
 */

import { existsSync } from 'node:fs';

for (const candidate of ['.env', '../../.env']) {
  if (existsSync(candidate)) {
    process.loadEnvFile(candidate);
    break;
  }
}

/** 读一个可选的环境变量，顺手去掉末尾斜杠，用于站点根地址这类值。 */
export function envUrl(name: string): string {
  return (process.env[name] ?? '').replace(/\/+$/, '');
}
