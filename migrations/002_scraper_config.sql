-- 把抓取配置从代码和环境变量搬进库：站点账号池、越狱提示词。
--
-- 原来这两样一个写死在 SCRAPER_ACCOUNTS 环境变量里、一个硬编码在 scraper/jailbreak.ts，
-- 想换账号或改一版提示词都得重新部署。搬进库之后运营自己就能改，
-- 而且账号的体检结果、提示词的历史战绩都能落下来。
--
-- 只在测试库（project ref zoqelpfhurwehlvypryl）执行。

BEGIN;

-- ── 站点账号池 ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.accounts (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email            TEXT NOT NULL UNIQUE,
  -- 带格式前缀的密码：gcm: 表示 AES-256-GCM 密文，plain: 表示明文。
  -- 前缀自描述，以后补上加密密钥可以就地把明文行升级掉，不用改表结构。
  password_cipher  TEXT NOT NULL,
  enabled          BOOLEAN NOT NULL DEFAULT true,
  note             TEXT,
  last_login_at    TIMESTAMPTZ,
  last_login_ok    BOOLEAN,
  last_error       TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE aiero.accounts IS
  '抓取用的站点账号池。禁用的账号不参与抽取，但保留体检记录便于排查。';
COMMENT ON COLUMN aiero.accounts.password_cipher IS
  '格式为 gcm:iv:tag:密文 或 plain:明文。接口一律不回传密码，只能整体覆盖。';
COMMENT ON COLUMN aiero.accounts.last_login_ok IS
  '最近一次登录体检结果。为空表示还没体检过；false 时 last_error 里有原因。';

CREATE INDEX IF NOT EXISTS idx_accounts_enabled
  ON aiero.accounts (created_at)
  WHERE enabled;

-- ── 越狱提示词 ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS aiero.jailbreak_prompts (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- 名字会原样写进 aiero.extractions.prompt_version，是统计战绩的连接键，
  -- 所以建好之后不允许改名，否则历史记录就认不出来了。
  name        TEXT NOT NULL UNIQUE,
  content     TEXT NOT NULL,
  enabled     BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 100,
  updated_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

COMMENT ON TABLE aiero.jailbreak_prompts IS
  '越狱提示词库。抽取时按 sort_order 逐个试，任一版套出提示词就收工。';
COMMENT ON COLUMN aiero.jailbreak_prompts.name IS
  '同时是 extractions.prompt_version 的取值，用于统计每一版的成功率。不可改名。';
COMMENT ON COLUMN aiero.jailbreak_prompts.sort_order IS
  '尝试顺序，小的先试。把命中率高的排前面能省掉大量无效请求。';

CREATE INDEX IF NOT EXISTS idx_jailbreak_prompts_order
  ON aiero.jailbreak_prompts (sort_order, name)
  WHERE enabled;

-- 战绩统计要按 prompt_version 分组，数据量到十万级时全表扫会有点肉。
CREATE INDEX IF NOT EXISTS idx_extractions_version_status
  ON aiero.extractions (prompt_version, status);

-- ── 权限 ────────────────────────────────────────────────────────────────────
-- 001 里的 GRANT 只作用于当时已存在的表，新表要再授一次。

GRANT ALL ON ALL TABLES IN SCHEMA aiero TO service_role, postgres;
GRANT ALL ON ALL SEQUENCES IN SCHEMA aiero TO service_role, postgres;

COMMIT;
