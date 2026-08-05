/**
 * 把本地 CLI 时代的产出导入数据库。
 *
 *   pnpm import:legacy -- "D:\path\to\aiero_prompt_output"
 *
 * 对应关系：
 *   queue.jsonl     -> aiero.apps
 *   results.jsonl   -> aiero.extractions（含提示词全文）+ 回写角色卡状态
 *   prompts/*.json  -> results.jsonl 里缺失的成功记录的兜底来源
 *   list_state.json -> aiero.list_state，导入后续跑不会重复翻已抓过的页
 *
 * 可重复执行：角色卡按 app_id 幂等 upsert，抽取记录按 app_id 去重，
 * 已经导入过的不会翻倍。
 */

import { createReadStream } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import path from 'node:path';
import { pool, query } from '../src/db.js';
import { upsertApps } from '../src/jobs/repository.js';
import type { RawListApp } from '../src/scraper/client.js';

const APPS_BATCH_SIZE = 2000;

interface LegacyResult {
  app_id: string;
  status?: string;
  prompt_text?: string;
  prompt_version?: string;
  model_provider?: string;
  model_name?: string;
  attempts?: number;
  error?: string;
  conversation_id?: string;
  output_length?: number;
  expected_length?: number | null;
  name?: string;
  extracted_at?: string;
}

async function importApps(file: string): Promise<{ seen: number; inserted: number }> {
  const stream = createInterface({
    input: createReadStream(file, { encoding: 'utf-8' }),
    crlfDelay: Infinity,
  });

  let batch: RawListApp[] = [];
  let seen = 0;
  let inserted = 0;

  const flush = async () => {
    if (batch.length === 0) return;
    inserted += await upsertApps(batch);
    batch = [];
    process.stdout.write(`\r  已处理 ${seen} 行，新增 ${inserted} 张`);
  };

  for await (const line of stream) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record: { app_id?: string } & RawListApp;
    try {
      record = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const appId = record.app_id ?? record.id;
    if (!appId) continue;

    seen += 1;
    batch.push({ ...record, id: appId });
    if (batch.length >= APPS_BATCH_SIZE) await flush();
  }
  await flush();
  process.stdout.write('\n');
  return { seen, inserted };
}

function normalizeStatus(raw: string | undefined): 'success' | 'partial' | 'failed' {
  if (raw === 'success' || raw === 'partial') return raw;
  return 'failed';
}

async function importResults(dir: string): Promise<number> {
  const byApp = new Map<string, LegacyResult>();

  // results.jsonl 里同一张卡可能有多条，后面的更新，用后写的覆盖先写的。
  try {
    const stream = createInterface({
      input: createReadStream(path.join(dir, 'results.jsonl'), { encoding: 'utf-8' }),
      crlfDelay: Infinity,
    });
    for await (const line of stream) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const record = JSON.parse(trimmed) as LegacyResult;
        if (record.app_id) byApp.set(record.app_id, record);
      } catch {
        // 跳过写坏的行
      }
    }
  } catch {
    console.log('  没有 results.jsonl，跳过');
  }

  // prompts/*.json 是成功抽取的权威副本，补上 results.jsonl 里没有的。
  try {
    const promptDir = path.join(dir, 'prompts');
    for (const file of await readdir(promptDir)) {
      if (!file.endsWith('.json')) continue;
      const appId = file.replace(/\.json$/, '');
      if (byApp.has(appId)) continue;
      const parsed = JSON.parse(await readFile(path.join(promptDir, file), 'utf-8')) as {
        app_id?: string;
        meta?: { name?: string };
        result?: LegacyResult;
      };
      if (parsed.result?.app_id) {
        byApp.set(parsed.result.app_id, { ...parsed.result, name: parsed.meta?.name });
      }
    }
  } catch {
    console.log('  没有 prompts 目录，跳过');
  }

  let imported = 0;
  for (const record of byApp.values()) {
    const status = normalizeStatus(record.status);
    const promptText = record.prompt_text ?? '';

    // 角色卡可能不在 queue.jsonl 里（比如当初用 one 子命令单抽的），先补一行占位。
    await query(
      `INSERT INTO aiero.apps (app_id, name, pre_prompt_length)
       VALUES ($1, $2, $3)
       ON CONFLICT (app_id) DO NOTHING`,
      [record.app_id, record.name ?? null, record.expected_length ?? null]
    );

    const existing = await query<{ id: string }>(
      'SELECT id FROM aiero.extractions WHERE app_id = $1 LIMIT 1',
      [record.app_id]
    );
    if (existing.length > 0) continue;

    await query(
      `INSERT INTO aiero.extractions
         (app_id, status, prompt_text, prompt_version, model_provider, model_name,
          attempts, error, conversation_id, output_length, expected_length, extracted_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, COALESCE($12::timestamptz, now()))`,
      [
        record.app_id,
        status,
        promptText,
        record.prompt_version ?? '',
        record.model_provider ?? '',
        record.model_name ?? '',
        record.attempts ?? 0,
        (record.error ?? '').slice(0, 2000),
        record.conversation_id ?? '',
        record.output_length ?? promptText.length,
        record.expected_length ?? null,
        record.extracted_at ?? null,
      ]
    );

    await query(
      `UPDATE aiero.apps
       SET extract_status = $2, attempts = GREATEST(attempts, $3), last_extracted_at = COALESCE($4::timestamptz, now())
       WHERE app_id = $1`,
      [record.app_id, status, record.attempts ?? 0, record.extracted_at ?? null]
    );
    imported += 1;
  }
  return imported;
}

async function importListState(dir: string): Promise<number> {
  let parsed: { done_pages?: number[]; total?: number; ranking?: string; limit?: number };
  try {
    parsed = JSON.parse(await readFile(path.join(dir, 'list_state.json'), 'utf-8'));
  } catch {
    console.log('  没有 list_state.json，跳过');
    return 0;
  }

  const pages = parsed.done_pages ?? [];
  if (pages.length === 0) return 0;

  await query(
    `INSERT INTO aiero.list_state (ranking, done_pages, total, page_limit, updated_at)
     VALUES ($1, $2::int[], $3, $4, now())
     ON CONFLICT (ranking) DO UPDATE SET
       done_pages = (
         SELECT ARRAY(SELECT DISTINCT unnest(aiero.list_state.done_pages || EXCLUDED.done_pages) ORDER BY 1)
       ),
       total = COALESCE(EXCLUDED.total, aiero.list_state.total),
       page_limit = EXCLUDED.page_limit,
       updated_at = now()`,
    [parsed.ranking ?? 'overall_rank', pages, parsed.total ?? null, parsed.limit ?? 200]
  );
  return pages.length;
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) {
    console.error('用法：pnpm import:legacy -- <aiero_prompt_output 目录>');
    process.exit(1);
  }

  console.log(`从 ${dir} 导入`);

  console.log('导入角色卡（queue.jsonl）…');
  const apps = await importApps(path.join(dir, 'queue.jsonl'));
  console.log(`  角色卡：读取 ${apps.seen} 行，新增 ${apps.inserted} 张`);

  console.log('导入抽取结果…');
  const results = await importResults(dir);
  console.log(`  抽取记录：新增 ${results} 条`);

  console.log('导入列表翻页断点…');
  const pages = await importListState(dir);
  console.log(`  已抓页码：${pages} 页`);

  await pool.end();
  console.log('导入完成');
}

await main();
