/** 越狱提示词库的读写。运行期提示词只从这里取，代码里的常量只用来给空表播种。 */

import type { JailbreakPrompt, JailbreakPromptStats } from '@aiero/shared';
import { query, queryOne } from '../db.js';
import { SEED_JAILBREAK_PROMPTS } from '../scraper/jailbreak.js';

interface PromptRow {
  id: string;
  name: string;
  content: string;
  enabled: boolean;
  sort_order: number;
  updated_by: string | null;
  created_at: string;
  updated_at: string;
}

/** 抽取时要用的最小信息：名字进抽取记录，正文发给模型。 */
export interface PromptRef {
  name: string;
  content: string;
}

const EMPTY_STATS: JailbreakPromptStats = { success: 0, partial: 0, failed: 0 };

/**
 * 每一版提示词的历史战绩。
 *
 * 连接键是抽取记录里的 prompt_version 文本，不是外键——抽取记录要能在提示词
 * 被删掉之后继续保留，用外键就得在删除时做级联或阻断，代价大过收益。
 */
async function loadStats(): Promise<Map<string, JailbreakPromptStats>> {
  const rows = await query<{ prompt_version: string; status: string; count: number }>(
    `SELECT prompt_version, status, count(*)::int AS count
       FROM aiero.extractions
      WHERE prompt_version <> ''
      GROUP BY prompt_version, status`
  );

  const stats = new Map<string, JailbreakPromptStats>();
  for (const row of rows) {
    const entry = stats.get(row.prompt_version) ?? { ...EMPTY_STATS };
    if (row.status === 'success' || row.status === 'partial' || row.status === 'failed') {
      entry[row.status] += row.count;
    }
    stats.set(row.prompt_version, entry);
  }
  return stats;
}

function mapPrompt(row: PromptRow, stats: JailbreakPromptStats): JailbreakPrompt {
  return {
    id: row.id,
    name: row.name,
    content: row.content,
    enabled: row.enabled,
    sortOrder: row.sort_order,
    updatedBy: row.updated_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stats,
  };
}

export async function listPrompts(): Promise<JailbreakPrompt[]> {
  const [rows, stats] = await Promise.all([
    query<PromptRow>('SELECT * FROM aiero.jailbreak_prompts ORDER BY sort_order, name'),
    loadStats(),
  ]);
  return rows.map((row) => mapPrompt(row, stats.get(row.name) ?? { ...EMPTY_STATS }));
}

export async function getPrompt(id: string): Promise<JailbreakPrompt | null> {
  const row = await queryOne<PromptRow>('SELECT * FROM aiero.jailbreak_prompts WHERE id = $1', [
    id,
  ]);
  if (!row) return null;
  const stats = await loadStats();
  return mapPrompt(row, stats.get(row.name) ?? { ...EMPTY_STATS });
}

/**
 * 抽取要用的提示词，按 sort_order 排好。
 *
 * names 为空表示「全部启用的」：任务参数里不点具体版本时走这条路，
 * 这样新加一版提示词立刻生效，不用回去改每个任务的参数。
 * 点了具体版本但都被禁用了，就返回空——宁可让任务起不来并报错，
 * 也不要静默换成别的提示词，那会让统计里的成功率对不上人的预期。
 */
export async function listEnabledPrompts(names: string[] = []): Promise<PromptRef[]> {
  if (names.length === 0) {
    return query<PromptRef>(
      `SELECT name, content FROM aiero.jailbreak_prompts
        WHERE enabled ORDER BY sort_order, name`
    );
  }
  return query<PromptRef>(
    `SELECT name, content FROM aiero.jailbreak_prompts
      WHERE enabled AND name = ANY($1::text[]) ORDER BY sort_order, name`,
    [names]
  );
}

export async function createPrompt(input: {
  name: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  updatedBy: string | null;
}): Promise<JailbreakPrompt> {
  const row = await queryOne<PromptRow>(
    `INSERT INTO aiero.jailbreak_prompts (name, content, enabled, sort_order, updated_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [input.name, input.content, input.enabled, input.sortOrder, input.updatedBy]
  );
  if (!row) throw new Error('提示词创建失败');
  return mapPrompt(row, { ...EMPTY_STATS });
}

/** 不含 name：名字是战绩统计的连接键，改名会让历史记录认不出来。 */
export async function updatePrompt(
  id: string,
  input: {
    content?: string;
    enabled?: boolean;
    sortOrder?: number;
    updatedBy: string | null;
  }
): Promise<JailbreakPrompt | null> {
  const sets: string[] = [];
  const values: unknown[] = [];

  if (input.content !== undefined) sets.push(`content = $${values.push(input.content)}`);
  if (input.enabled !== undefined) sets.push(`enabled = $${values.push(input.enabled)}`);
  if (input.sortOrder !== undefined) sets.push(`sort_order = $${values.push(input.sortOrder)}`);
  if (sets.length === 0) return getPrompt(id);

  sets.push(`updated_by = $${values.push(input.updatedBy)}`, 'updated_at = now()');
  const row = await queryOne<PromptRow>(
    `UPDATE aiero.jailbreak_prompts SET ${sets.join(', ')}
      WHERE id = $${values.push(id)} RETURNING *`,
    values
  );
  if (!row) return null;
  const stats = await loadStats();
  return mapPrompt(row, stats.get(row.name) ?? { ...EMPTY_STATS });
}

export async function deletePrompt(id: string): Promise<boolean> {
  const rows = await query<{ id: string }>(
    'DELETE FROM aiero.jailbreak_prompts WHERE id = $1 RETURNING id',
    [id]
  );
  return rows.length > 0;
}

export async function countEnabled(): Promise<number> {
  const row = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM aiero.jailbreak_prompts WHERE enabled'
  );
  return row?.count ?? 0;
}

/**
 * 表为空时把代码里的三版提示词写进库。
 *
 * 只在完全空表时做。运营改坏了某一版可以自己改回去，但如果他有意清空整个库，
 * 重启不该把三版旧文案复活；反过来，真的一条不剩时补上默认值比让抽取直接跑不起来好。
 */
export async function seedPromptsIfEmpty(): Promise<number> {
  const existing = await queryOne<{ count: number }>(
    'SELECT count(*)::int AS count FROM aiero.jailbreak_prompts'
  );
  if ((existing?.count ?? 0) > 0) return 0;

  let inserted = 0;
  for (const seed of SEED_JAILBREAK_PROMPTS) {
    const rows = await query<{ id: string }>(
      `INSERT INTO aiero.jailbreak_prompts (name, content, sort_order, updated_by)
       VALUES ($1, $2, $3, '内置初始版本')
       ON CONFLICT (name) DO NOTHING RETURNING id`,
      [seed.name, seed.content, seed.sortOrder]
    );
    inserted += rows.length;
  }
  return inserted;
}
