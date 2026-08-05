/**
 * 执行 migrations/ 下的 SQL 文件。
 *
 * 没有引入迁移框架：这个库的表全在独立的 aiero schema 里，迁移按编号手动执行，
 * 跟运营平台既有的做法一致。脚本存在的意义只是把「读文件 + 连库 + 整体执行」
 * 这三步固定下来，避免每次现场拼一段 node -e，那样很容易漏掉编码或事务。
 *
 * 用法：pnpm migrate 002_scraper_config.sql
 *
 * 文件自己带 BEGIN/COMMIT，所以这里不再包一层事务——包了会变成嵌套事务，
 * 而 CREATE EXTENSION 之类的语句在某些情况下不接受嵌套。
 */

import { readFileSync } from 'node:fs';
import { basename, isAbsolute, resolve } from 'node:path';
import { Client } from 'pg';
import { config } from '../src/config.js';

const target = process.argv[2];
if (!target) {
  console.error('用法：pnpm migrate <迁移文件名或路径>');
  process.exit(1);
}

const file = isAbsolute(target)
  ? target
  : resolve(import.meta.dirname, '../../../migrations', basename(target));

const sql = readFileSync(file, 'utf8');
console.log(`执行 ${basename(file)}（${sql.length} 字符）`);

const client = new Client({
  connectionString: config.databaseUrl,
  ssl: config.databaseUrl.includes('localhost') ? undefined : { rejectUnauthorized: false },
});

await client.connect();
try {
  await client.query(sql);
  console.log('执行成功');
} catch (error) {
  console.error('执行失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await client.end();
}
