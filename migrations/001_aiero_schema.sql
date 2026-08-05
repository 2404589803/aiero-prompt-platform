-- AI风月提示词平台：把原本散在本地文件里的抓取状态搬进数据库。
--
-- 对应关系：
--   queue.jsonl + seen_ids.txt -> aiero.apps
--   results.jsonl + prompts/*  -> aiero.extractions
--   progress.json              -> aiero.jobs.stats
--   list_state.json            -> aiero.list_state
--   run.log                    -> aiero.job_logs
--
-- 搬进数据库的关键收益是并发领取：原来靠进程内的 claimed 集合去重，只在单进程内有效；
-- 现在用 FOR UPDATE SKIP LOCKED 领取，多 worker 甚至多容器都不会抢到同一张卡，
-- 容器被重调度也不会丢进度。
--
-- 本迁移只在测试库（project ref zoqelpfhurwehlvypryl）执行，独立 schema，
-- 不触碰 miniapp / admin 现有对象。

BEGIN;

CREATE SCHEMA IF NOT EXISTS aiero;

COMMENT ON SCHEMA aiero IS 'AI风月角色卡提示词抓取平台，与 miniapp / admin 隔离。';

-- ── 任务 ────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.jobs (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          TEXT NOT NULL CHECK (kind IN ('list', 'extract', 'full')),
  status        TEXT NOT NULL DEFAULT 'queued'
                CHECK (status IN ('queued', 'running', 'stopping', 'stopped', 'completed', 'failed')),
  params        JSONB NOT NULL DEFAULT '{}'::jsonb,
  stats         JSONB NOT NULL DEFAULT '{}'::jsonb,
  error         TEXT,
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  started_at    TIMESTAMPTZ,
  finished_at   TIMESTAMPTZ,
  heartbeat_at  TIMESTAMPTZ
);

COMMENT ON COLUMN aiero.jobs.stats IS
  '实时进度计数：success / partial / failed / skipped / pages_done / apps_discovered。';
COMMENT ON COLUMN aiero.jobs.heartbeat_at IS
  '运行中的任务每隔几秒续期；长时间不续期说明容器已死，可判定为僵尸任务。';

-- 同一时刻只允许一个任务在跑，避免多开把第三方站点的限流打爆。
CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_single_active
  ON aiero.jobs ((status IN ('queued', 'running', 'stopping')))
  WHERE status IN ('queued', 'running', 'stopping');

CREATE INDEX IF NOT EXISTS idx_jobs_created_at ON aiero.jobs (created_at DESC);

-- ── 发现的角色卡 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.apps (
  app_id             TEXT PRIMARY KEY,
  name               TEXT,
  pre_prompt_length  INTEGER,
  world_book_length  INTEGER,
  overall_rank       INTEGER,
  avg_cost           NUMERIC,
  account_name       TEXT,
  summary            TEXT,
  discovered_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- 抽取状态冗余在这里，列表页排序过滤不必每次去 join extractions。
  extract_status     TEXT NOT NULL DEFAULT 'pending'
                     CHECK (extract_status IN ('pending', 'running', 'success', 'partial', 'failed')),
  attempts           INTEGER NOT NULL DEFAULT 0,
  last_extracted_at  TIMESTAMPTZ,
  last_error         TEXT,

  -- 并发领取用：谁领的、什么时候领的。用于回收僵尸任务留下的 running 行。
  claimed_by         TEXT,
  claimed_at         TIMESTAMPTZ
);

COMMENT ON COLUMN aiero.apps.extract_status IS
  'pending 待抽取 / running 抽取中 / success 成功 / partial 部分成功 / failed 失败。';
COMMENT ON COLUMN aiero.apps.claimed_at IS
  '领取时间。running 且领取时间过久即为僵尸，由 reclaim 逻辑放回 pending。';

-- 领取队列的主索引：按总榜名次优先抽取靠前的卡。
CREATE INDEX IF NOT EXISTS idx_apps_pending_rank
  ON aiero.apps (overall_rank NULLS LAST, discovered_at)
  WHERE extract_status = 'pending';

CREATE INDEX IF NOT EXISTS idx_apps_status ON aiero.apps (extract_status);
CREATE INDEX IF NOT EXISTS idx_apps_claimed ON aiero.apps (claimed_at) WHERE extract_status = 'running';
CREATE INDEX IF NOT EXISTS idx_apps_rank ON aiero.apps (overall_rank NULLS LAST);
CREATE INDEX IF NOT EXISTS idx_apps_name ON aiero.apps (name);

-- ── 抽取结果 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.extractions (
  id               BIGSERIAL PRIMARY KEY,
  app_id           TEXT NOT NULL REFERENCES aiero.apps (app_id) ON DELETE CASCADE,
  job_id           UUID REFERENCES aiero.jobs (id) ON DELETE SET NULL,
  status           TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed')),
  prompt_text      TEXT NOT NULL DEFAULT '',
  prompt_version   TEXT NOT NULL DEFAULT '',
  model_provider   TEXT NOT NULL DEFAULT '',
  model_name       TEXT NOT NULL DEFAULT '',
  attempts         INTEGER NOT NULL DEFAULT 0,
  error            TEXT NOT NULL DEFAULT '',
  conversation_id  TEXT NOT NULL DEFAULT '',
  output_length    INTEGER NOT NULL DEFAULT 0,
  expected_length  INTEGER,
  extracted_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE aiero.extractions IS
  '每次抽取尝试留一行，保留失败记录便于回看；同一 app 允许多行，最新成功的一行为准。';

CREATE INDEX IF NOT EXISTS idx_extractions_app ON aiero.extractions (app_id, extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_extractions_status ON aiero.extractions (status, extracted_at DESC);
CREATE INDEX IF NOT EXISTS idx_extractions_job ON aiero.extractions (job_id);

-- 提示词全文检索用。中文分词 Postgres 原生支持不好，这里用 pg_trgm 做子串匹配，
-- 配合 ILIKE 查询即可走索引，规模到几万条也够用。
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_extractions_prompt_trgm
  ON aiero.extractions USING gin (prompt_text gin_trgm_ops)
  WHERE status IN ('success', 'partial');

-- ── 列表翻页断点 ────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.list_state (
  ranking     TEXT PRIMARY KEY,
  done_pages  INTEGER[] NOT NULL DEFAULT '{}',
  total       INTEGER,
  page_limit  INTEGER,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE aiero.list_state IS
  '按 ranking 维度记录已抓完的页码，重启后跳过，等价于原 list_state.json。';

-- ── 运行日志 ────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.job_logs (
  id          BIGSERIAL PRIMARY KEY,
  job_id      UUID REFERENCES aiero.jobs (id) ON DELETE CASCADE,
  level       TEXT NOT NULL DEFAULT 'info' CHECK (level IN ('debug', 'info', 'warn', 'error')),
  message     TEXT NOT NULL,
  context     JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_job_logs_job ON aiero.job_logs (job_id, id DESC);

-- ── 权限 ────────────────────────────────────────────────────────────────────
-- 后端用直连 Postgres（service_role）读写，不经过 PostgREST，
-- 所以这里不把 aiero 暴露给 anon / authenticated，减少攻击面。

REVOKE ALL ON SCHEMA aiero FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA aiero TO service_role, postgres;
GRANT ALL ON ALL TABLES IN SCHEMA aiero TO service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA aiero TO service_role, postgres;

COMMIT;
