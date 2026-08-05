import {
  EMPTY_JOB_STATS,
  type AppSummary,
  type ExtractStatus,
  type Extraction,
  type Job,
  type JobLogEntry,
  type JobParams,
  type JobStats,
  type OverviewStats,
  type Paginated,
  type PromptListItem,
} from '@aiero/shared';
import { query, queryOne } from '../db.js';
import type { RawListApp } from '../scraper/client.js';

interface JobRow {
  id: string;
  kind: Job['kind'];
  status: Job['status'];
  params: JobParams;
  stats: Partial<JobStats>;
  error: string | null;
  created_by: string | null;
  created_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
  heartbeat_at: Date | null;
}

function iso(value: Date | null): string | null {
  return value ? value.toISOString() : null;
}

function mapJob(row: JobRow): Job {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    params: row.params,
    stats: { ...EMPTY_JOB_STATS, ...row.stats },
    error: row.error,
    createdBy: row.created_by,
    createdAt: row.created_at.toISOString(),
    startedAt: iso(row.started_at),
    finishedAt: iso(row.finished_at),
    heartbeatAt: iso(row.heartbeat_at),
  };
}

// ── 任务 ──────────────────────────────────────────────────────────────────────

export async function createJob(
  kind: Job['kind'],
  params: JobParams,
  createdBy: string | null
): Promise<Job> {
  const row = await queryOne<JobRow>(
    `INSERT INTO aiero.jobs (kind, status, params, stats, created_by)
     VALUES ($1, 'queued', $2::jsonb, $3::jsonb, $4)
     RETURNING *`,
    [kind, JSON.stringify(params), JSON.stringify(EMPTY_JOB_STATS), createdBy]
  );
  if (!row) throw new Error('创建任务失败');
  return mapJob(row);
}

export async function getJob(id: string): Promise<Job | null> {
  const row = await queryOne<JobRow>('SELECT * FROM aiero.jobs WHERE id = $1', [id]);
  return row ? mapJob(row) : null;
}

/** 当前在跑（或正在停）的任务。同一时刻最多一个，由唯一索引保证。 */
export async function getActiveJob(): Promise<Job | null> {
  const row = await queryOne<JobRow>(
    `SELECT * FROM aiero.jobs
     WHERE status IN ('queued', 'running', 'stopping')
     ORDER BY created_at DESC
     LIMIT 1`
  );
  return row ? mapJob(row) : null;
}

export async function listJobs(limit = 20): Promise<Job[]> {
  const rows = await query<JobRow>('SELECT * FROM aiero.jobs ORDER BY created_at DESC LIMIT $1', [
    limit,
  ]);
  return rows.map(mapJob);
}

export async function markJobRunning(id: string): Promise<void> {
  await query(
    `UPDATE aiero.jobs
     SET status = 'running', started_at = COALESCE(started_at, now()), heartbeat_at = now()
     WHERE id = $1`,
    [id]
  );
}

export async function markJobFinished(
  id: string,
  status: 'stopped' | 'completed' | 'failed',
  error?: string
): Promise<void> {
  await query(
    `UPDATE aiero.jobs
     SET status = $2, finished_at = now(), error = $3
     WHERE id = $1`,
    [id, status, error ?? null]
  );
}

/** 请求停止：只改状态，实际收尾由运行器在下一个检查点完成。 */
export async function requestJobStop(id: string): Promise<void> {
  await query(
    `UPDATE aiero.jobs SET status = 'stopping'
     WHERE id = $1 AND status IN ('queued', 'running')`,
    [id]
  );
}

export async function heartbeatJob(id: string, stats: JobStats): Promise<Job['status'] | null> {
  const row = await queryOne<{ status: Job['status'] }>(
    `UPDATE aiero.jobs
     SET heartbeat_at = now(), stats = $2::jsonb
     WHERE id = $1
     RETURNING status`,
    [id, JSON.stringify(stats)]
  );
  return row?.status ?? null;
}

/**
 * 把上一次进程死掉时留下的僵尸任务收干净。
 * 服务启动时调用：能跑到这里说明进程是新的，任何 running 都不可能还在跑。
 */
export async function reclaimAbandonedWork(staleMinutes: number): Promise<{
  jobs: number;
  apps: number;
}> {
  const jobs = await query(
    `UPDATE aiero.jobs
     SET status = 'failed',
         finished_at = now(),
         error = COALESCE(error, '进程重启，任务被中断')
     WHERE status IN ('queued', 'running', 'stopping')
     RETURNING id`
  );
  const apps = await query(
    `UPDATE aiero.apps
     SET extract_status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE extract_status = 'running'
       AND (claimed_at IS NULL OR claimed_at < now() - make_interval(mins => $1))
     RETURNING app_id`,
    [staleMinutes]
  );
  return { jobs: jobs.length, apps: apps.length };
}

// ── 日志 ──────────────────────────────────────────────────────────────────────

export async function appendJobLog(
  jobId: string,
  level: JobLogEntry['level'],
  message: string
): Promise<void> {
  await query('INSERT INTO aiero.job_logs (job_id, level, message) VALUES ($1, $2, $3)', [
    jobId,
    level,
    message.slice(0, 4000),
  ]);
}

export interface JobLogQuery {
  limit: number;
  /** 只看警告和错误。抽取时每张卡都写一条 info，排查问题时噪声会压倒信号。 */
  warnOnly: boolean;
  /**
   * 取最早的 N 条而不是最新的 N 条。
   *
   * 任务开头那几行写着这次用了哪些账号、模型和提示词，是排查「为什么全都失败」
   * 最有用的信息，但一场全量抽取有十万条流水，它早就被冲到看不见的地方了。
   */
  fromStart: boolean;
}

/**
 * 读某个任务的日志。
 *
 * 不做游标翻页：十万条流水逐页往前翻没人会真的翻到底，「看最近若干条」加上
 * 「只看警告以上」「看开头若干条」三个开关就能覆盖排查需要，而且和运行中任务的
 * 轮询天然兼容——游标翻页碰上不断追加的新日志会出现空档或重复。
 *
 * 返回的条目一律按时间正序，跟终端一致，调用方不用再关心取的是哪一段。
 */
export async function listJobLogs(
  jobId: string,
  options: JobLogQuery
): Promise<{ items: JobLogEntry[]; total: number }> {
  const levelFilter = options.warnOnly ? `AND level IN ('warn', 'error')` : '';
  const direction = options.fromStart ? 'ASC' : 'DESC';

  const [rows, counted] = await Promise.all([
    query<{ id: number; level: JobLogEntry['level']; message: string; created_at: Date }>(
      `SELECT id, level, message, created_at FROM aiero.job_logs
        WHERE job_id = $1 ${levelFilter}
        ORDER BY id ${direction} LIMIT $2`,
      [jobId, options.limit]
    ),
    queryOne<{ total: number }>(
      `SELECT count(*)::int AS total FROM aiero.job_logs WHERE job_id = $1 ${levelFilter}`,
      [jobId]
    ),
  ]);

  const ordered = options.fromStart ? rows : rows.reverse();
  return {
    items: ordered.map((row) => ({
      id: row.id,
      level: row.level,
      message: row.message,
      createdAt: row.created_at.toISOString(),
    })),
    total: counted?.total ?? 0,
  };
}

// ── 角色卡 ────────────────────────────────────────────────────────────────────

/**
 * 批量写入发现的角色卡，返回其中有多少是新的。
 *
 * 用 unnest 一次写一批而不是逐行 insert：存量导入有 11.5 万行，
 * 逐行写要几万次往返，批量写只要几十次。
 * overall_rank 和 world_book_length 必须按 bigint 传，站点给的值远超 int32。
 * 冲突时只更新站点侧的元数据，绝不动 extract_status，否则重跑列表会把抽过的卡打回待抽。
 */
export async function upsertApps(apps: RawListApp[]): Promise<number> {
  // 同一批里出现重复 app_id 会让整条 ON CONFLICT 语句报错（一行不能被同一命令改两次），
  // 一页写入就全废了。站点的分页会在翻页期间漂移，存量 queue.jsonl 里也确实有重复，
  // 所以先按 app_id 去重，同一 id 保留最后出现的那条（更新的数据）。
  const deduped = new Map<string, RawListApp & { id: string }>();
  for (const app of apps) {
    if (app.id) deduped.set(app.id, { ...app, id: app.id });
  }
  const valid = [...deduped.values()];
  if (valid.length === 0) return 0;

  const rows = await query<{ inserted: boolean }>(
    `INSERT INTO aiero.apps
       (app_id, name, pre_prompt_length, world_book_length, overall_rank, avg_cost, account_name, summary)
     SELECT * FROM unnest(
       $1::text[], $2::text[], $3::int[], $4::bigint[], $5::bigint[], $6::numeric[], $7::text[], $8::text[]
     )
     ON CONFLICT (app_id) DO UPDATE SET
       name = EXCLUDED.name,
       pre_prompt_length = EXCLUDED.pre_prompt_length,
       world_book_length = EXCLUDED.world_book_length,
       overall_rank = EXCLUDED.overall_rank,
       avg_cost = EXCLUDED.avg_cost,
       account_name = EXCLUDED.account_name,
       summary = EXCLUDED.summary
     RETURNING (xmax = 0) AS inserted`,
    [
      valid.map((app) => app.id),
      valid.map((app) => app.name ?? null),
      valid.map((app) => app.pre_prompt_length ?? app.pre_length ?? null),
      valid.map((app) => app.world_book_length ?? null),
      valid.map((app) => app.overall_rank ?? null),
      valid.map((app) => app.avg_cost ?? null),
      valid.map((app) => app.account_name ?? null),
      valid.map((app) => app.summary ?? null),
    ]
  );
  return rows.filter((row) => row.inserted).length;
}

export interface ClaimedApp {
  appId: string;
  name: string | null;
  prePromptLength: number | null;
}

/**
 * 领取待抽取的角色卡。
 *
 * SKIP LOCKED 是这里的关键：多个 worker 并发领取时互相跳过对方锁住的行，
 * 既不会重复领取，也不会互相阻塞。原实现靠进程内的 claimed 集合，多容器就失效了。
 *
 * overall_rank 是热度分不是名次，越大越热门，所以按 DESC 领取。
 * 11.5 万张卡短期内抽不完，顺序错了等于优先抓最冷门的。
 */
export async function claimApps(count: number, claimedBy: string): Promise<ClaimedApp[]> {
  if (count <= 0) return [];
  const rows = await query<{
    app_id: string;
    name: string | null;
    pre_prompt_length: number | null;
  }>(
    `WITH candidates AS (
       SELECT app_id FROM aiero.apps
       WHERE extract_status = 'pending'
       ORDER BY overall_rank DESC NULLS LAST, discovered_at
       LIMIT $1
       FOR UPDATE SKIP LOCKED
     )
     UPDATE aiero.apps AS a
     SET extract_status = 'running', claimed_by = $2, claimed_at = now()
     FROM candidates
     WHERE a.app_id = candidates.app_id
     RETURNING a.app_id, a.name, a.pre_prompt_length`,
    [count, claimedBy]
  );
  return rows.map((row) => ({
    appId: row.app_id,
    name: row.name,
    prePromptLength: row.pre_prompt_length,
  }));
}

/** 任务停止时，把还没来得及处理的已领取卡片放回队列。 */
export async function releaseClaims(appIds: string[]): Promise<void> {
  if (appIds.length === 0) return;
  await query(
    `UPDATE aiero.apps
     SET extract_status = 'pending', claimed_by = NULL, claimed_at = NULL
     WHERE app_id = ANY($1::text[]) AND extract_status = 'running'`,
    [appIds]
  );
}

export async function saveExtraction(
  jobId: string | null,
  outcome: {
    appId: string;
    status: 'success' | 'partial' | 'failed';
    promptText: string;
    promptVersion: string;
    modelProvider: string;
    modelName: string;
    attempts: number;
    error: string;
    conversationId: string;
    outputLength: number;
    expectedLength: number | null;
  }
): Promise<void> {
  await query(
    `INSERT INTO aiero.extractions
       (app_id, job_id, status, prompt_text, prompt_version, model_provider, model_name,
        attempts, error, conversation_id, output_length, expected_length)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      outcome.appId,
      jobId,
      outcome.status,
      outcome.promptText,
      outcome.promptVersion,
      outcome.modelProvider,
      outcome.modelName,
      outcome.attempts,
      outcome.error.slice(0, 2000),
      outcome.conversationId,
      outcome.outputLength,
      outcome.expectedLength,
    ]
  );

  await query(
    `UPDATE aiero.apps
     SET extract_status = $2,
         attempts = attempts + $3,
         last_extracted_at = now(),
         last_error = NULLIF($4, ''),
         claimed_by = NULL,
         claimed_at = NULL
     WHERE app_id = $1`,
    [outcome.appId, outcome.status, outcome.attempts, outcome.error.slice(0, 2000)]
  );
}

// ── 列表翻页断点 ──────────────────────────────────────────────────────────────

export async function getDonePages(ranking: string): Promise<Set<number>> {
  const row = await queryOne<{ done_pages: number[] }>(
    'SELECT done_pages FROM aiero.list_state WHERE ranking = $1',
    [ranking]
  );
  return new Set(row?.done_pages ?? []);
}

export async function markPageDone(
  ranking: string,
  page: number,
  total: number | null,
  pageLimit: number
): Promise<void> {
  await query(
    `INSERT INTO aiero.list_state (ranking, done_pages, total, page_limit, updated_at)
     VALUES ($1, ARRAY[$2::int], $3, $4, now())
     ON CONFLICT (ranking) DO UPDATE SET
       done_pages = (
         SELECT ARRAY(SELECT DISTINCT unnest(aiero.list_state.done_pages || $2::int) ORDER BY 1)
       ),
       total = COALESCE(EXCLUDED.total, aiero.list_state.total),
       page_limit = EXCLUDED.page_limit,
       updated_at = now()`,
    [ranking, page, total, pageLimit]
  );
}

// ── 查询：总览、角色卡、提示词 ────────────────────────────────────────────────

export async function getOverview(): Promise<OverviewStats> {
  const row = await queryOne<{
    apps_total: string;
    pending: string;
    running: string;
    success: string;
    partial: string;
    failed: string;
  }>(
    `SELECT
       count(*)                                            AS apps_total,
       count(*) FILTER (WHERE extract_status = 'pending')  AS pending,
       count(*) FILTER (WHERE extract_status = 'running')  AS running,
       count(*) FILTER (WHERE extract_status = 'success')  AS success,
       count(*) FILTER (WHERE extract_status = 'partial')  AS partial,
       count(*) FILTER (WHERE extract_status = 'failed')   AS failed
     FROM aiero.apps`
  );
  return {
    appsTotal: Number(row?.apps_total ?? 0),
    pending: Number(row?.pending ?? 0),
    running: Number(row?.running ?? 0),
    success: Number(row?.success ?? 0),
    partial: Number(row?.partial ?? 0),
    failed: Number(row?.failed ?? 0),
  };
}

export interface AppQuery {
  status?: ExtractStatus;
  keyword?: string;
  page: number;
  pageSize: number;
}

export async function listApps(input: AppQuery): Promise<Paginated<AppSummary>> {
  const conditions: string[] = [];
  const params: unknown[] = [];

  if (input.status) {
    params.push(input.status);
    conditions.push(`extract_status = $${params.length}`);
  }
  if (input.keyword) {
    params.push(`%${input.keyword}%`);
    conditions.push(`(name ILIKE $${params.length} OR app_id ILIKE $${params.length})`);
  }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalRow = await queryOne<{ count: string }>(
    `SELECT count(*) AS count FROM aiero.apps ${where}`,
    params
  );

  params.push(input.pageSize, (input.page - 1) * input.pageSize);
  const rows = await query<{
    app_id: string;
    name: string | null;
    pre_prompt_length: number | null;
    world_book_length: number | null;
    overall_rank: number | null;
    avg_cost: string | null;
    account_name: string | null;
    summary: string | null;
    discovered_at: Date;
    extract_status: ExtractStatus;
    attempts: number;
    last_extracted_at: Date | null;
    last_error: string | null;
  }>(
    `SELECT * FROM aiero.apps ${where}
     ORDER BY overall_rank DESC NULLS LAST, discovered_at
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: rows.map((row) => ({
      appId: row.app_id,
      name: row.name,
      prePromptLength: row.pre_prompt_length,
      worldBookLength: row.world_book_length,
      overallRank: row.overall_rank,
      avgCost: row.avg_cost === null ? null : Number(row.avg_cost),
      accountName: row.account_name,
      summary: row.summary,
      discoveredAt: row.discovered_at.toISOString(),
      extractStatus: row.extract_status,
      attempts: row.attempts,
      lastExtractedAt: iso(row.last_extracted_at),
      lastError: row.last_error,
    })),
    total: Number(totalRow?.count ?? 0),
    page: input.page,
    pageSize: input.pageSize,
  };
}

export interface PromptQuery {
  /** 同时匹配角色卡名称和提示词正文。 */
  keyword?: string;
  status?: 'success' | 'partial';
  page: number;
  pageSize: number;
}

/**
 * 提示词库列表。
 *
 * 每张卡可能抽过多次，这里用 DISTINCT ON 只取最新一条，避免同一角色卡刷屏。
 * 正文只截前 200 字返回：全文动辄上万字，列表页拉全文会把响应撑到几十 MB。
 */
export async function listPrompts(input: PromptQuery): Promise<Paginated<PromptListItem>> {
  const conditions = [`e.status = ANY($1::text[])`];
  const params: unknown[] = [input.status ? [input.status] : ['success', 'partial']];

  if (input.keyword) {
    params.push(`%${input.keyword}%`);
    conditions.push(`(a.name ILIKE $${params.length} OR e.prompt_text ILIKE $${params.length})`);
  }
  const where = conditions.join(' AND ');

  const latest = `
    SELECT DISTINCT ON (e.app_id)
      e.app_id, e.status, e.prompt_version, e.model_provider, e.model_name,
      e.output_length, e.expected_length, e.extracted_at,
      left(e.prompt_text, 200) AS excerpt,
      a.name, a.overall_rank, a.account_name, a.extract_status
    FROM aiero.extractions e
    JOIN aiero.apps a ON a.app_id = e.app_id
    WHERE ${where}
    ORDER BY e.app_id, e.extracted_at DESC
  `;

  const totalRow = await queryOne<{ count: string }>(
    `SELECT count(*) AS count FROM (${latest}) AS latest`,
    params
  );

  params.push(input.pageSize, (input.page - 1) * input.pageSize);
  const rows = await query<{
    app_id: string;
    name: string | null;
    overall_rank: number | null;
    account_name: string | null;
    extract_status: ExtractStatus;
    prompt_version: string;
    model_provider: string;
    model_name: string;
    output_length: number;
    expected_length: number | null;
    extracted_at: Date;
    excerpt: string;
  }>(
    `SELECT * FROM (${latest}) AS latest
     ORDER BY extracted_at DESC
     LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params
  );

  return {
    items: rows.map((row) => ({
      appId: row.app_id,
      name: row.name,
      overallRank: row.overall_rank,
      accountName: row.account_name,
      extractStatus: row.extract_status,
      promptVersion: row.prompt_version,
      modelProvider: row.model_provider,
      modelName: row.model_name,
      outputLength: row.output_length,
      expectedLength: row.expected_length,
      extractedAt: row.extracted_at.toISOString(),
      excerpt: row.excerpt,
    })),
    total: Number(totalRow?.count ?? 0),
    page: input.page,
    pageSize: input.pageSize,
  };
}

/** 某张角色卡的全部抽取记录，最新在前，含提示词全文。 */
export async function getExtractionsForApp(appId: string): Promise<Extraction[]> {
  const rows = await query<{
    id: string;
    app_id: string;
    job_id: string | null;
    status: Extraction['status'];
    prompt_text: string;
    prompt_version: string;
    model_provider: string;
    model_name: string;
    attempts: number;
    error: string;
    conversation_id: string;
    output_length: number;
    expected_length: number | null;
    extracted_at: Date;
  }>('SELECT * FROM aiero.extractions WHERE app_id = $1 ORDER BY extracted_at DESC', [appId]);

  return rows.map((row) => ({
    id: Number(row.id),
    appId: row.app_id,
    jobId: row.job_id,
    status: row.status,
    promptText: row.prompt_text,
    promptVersion: row.prompt_version,
    modelProvider: row.model_provider,
    modelName: row.model_name,
    attempts: row.attempts,
    error: row.error,
    conversationId: row.conversation_id,
    outputLength: row.output_length,
    expectedLength: row.expected_length,
    extractedAt: row.extracted_at.toISOString(),
  }));
}

/** 手动把某张卡放回待抽队列，用于重抽失败或结果不理想的卡。 */
export async function resetApp(appId: string): Promise<boolean> {
  const rows = await query(
    `UPDATE aiero.apps
     SET extract_status = 'pending', claimed_by = NULL, claimed_at = NULL, last_error = NULL
     WHERE app_id = $1
     RETURNING app_id`,
    [appId]
  );
  return rows.length > 0;
}
