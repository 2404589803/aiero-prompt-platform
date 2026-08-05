# 提示词抓取平台

把原本单文件运行的 Python 抓取脚本改造成前后端分离的内部平台：网页上启停任务、看实时进度和过程日志、检索抽取到的角色卡提示词。

抓取目标是**风月**的角色卡系统提示词，通过它自己的聊天接口套取。接口地址、请求头、成功码这些都收在 `packages/server/src/scraper/constants.ts` 一个文件里，换目标站只改这里。

## 架构

| 层     | 技术                                      | 部署       |
| ------ | ----------------------------------------- | ---------- |
| 前端   | React 18 + Vite + Ant Design              | Vercel     |
| 后端   | Fastify + TypeScript（含抓取任务运行器）  | Railway    |
| 数据库 | Supabase Postgres 测试库的 `aiero` schema | 与后端共用 |

后端直连 Postgres 而不走 PostgREST，因为任务领取要用 `FOR UPDATE SKIP LOCKED`。
`aiero` schema 不对 `anon` / `authenticated` 开放，浏览器拿不到数据库直连权限。

登录复用运营平台的 Supabase Auth 账号：前端登录拿到 JWT，后端校验后再查
`admin.admin_users` 确认这个人在管理员白名单里。`viewer` 角色只能看，不能启停任务。

## 数据模型

全部在 `aiero` schema 下，建表脚本见 `migrations/`。

### `aiero.jobs` — 抓取任务

| 字段                                    | 类型        | 说明                                                                            |
| --------------------------------------- | ----------- | ------------------------------------------------------------------------------- |
| `id`                                    | UUID        | 主键                                                                            |
| `kind`                                  | TEXT        | `list` 只同步列表 / `extract` 只抽取 / `full` 两样都做                          |
| `status`                                | TEXT        | `queued` / `running` / `stopping` / `stopped` / `completed` / `failed`          |
| `params`                                | JSONB       | 启动参数原样存档，见下方「任务参数」                                            |
| `stats`                                 | JSONB       | 实时进度：`success` `partial` `failed` `skipped` `pages_done` `apps_discovered` |
| `error`                                 | TEXT        | 失败原因，同时也会写成一条 error 日志                                           |
| `created_by`                            | TEXT        | 发起人                                                                          |
| `created_at` `started_at` `finished_at` | TIMESTAMPTZ | 三个时间点                                                                      |
| `heartbeat_at`                          | TIMESTAMPTZ | 运行中每几秒续期；长时间不续期即为僵尸任务，下次启动时回收                      |

唯一索引 `idx_jobs_single_active` 保证同一时刻只有一个任务处于 `queued`/`running`/`stopping`。

### `aiero.apps` — 发现的角色卡

| 字段                | 类型        | 说明                                                                          |
| ------------------- | ----------- | ----------------------------------------------------------------------------- |
| `app_id`            | TEXT        | 主键，风月侧的角色卡 ID                                                       |
| `name`              | TEXT        | 角色卡名称                                                                    |
| `pre_prompt_length` | INTEGER     | 风月标称的系统提示词长度，用来判断产出是不是短得离谱                          |
| `world_book_length` | BIGINT      | 世界书长度，实测能到 470 万，放不进 INTEGER                                   |
| `overall_rank`      | BIGINT      | **热度分不是名次**：值越大越热门，实测约 5 千万到 2700 亿，排序一律 DESC      |
| `avg_cost`          | NUMERIC     | 风月标的平均消耗                                                              |
| `account_name`      | TEXT        | 角色卡作者                                                                    |
| `summary`           | TEXT        | 简介                                                                          |
| `discovered_at`     | TIMESTAMPTZ | 首次发现时间                                                                  |
| `extract_status`    | TEXT        | `pending` / `running` / `success` / `partial` / `failed`，冗余在这里省掉 join |
| `attempts`          | INTEGER     | 累计抽取次数                                                                  |
| `last_extracted_at` | TIMESTAMPTZ | 最近一次抽取时间                                                              |
| `last_error`        | TEXT        | 最近一次失败原因                                                              |
| `claimed_by`        | TEXT        | 领取者，形如 `任务ID:worker序号`                                              |
| `claimed_at`        | TIMESTAMPTZ | 领取时间，过久未完成即判定僵尸并放回 `pending`                                |

### `aiero.extractions` — 抽取结果

每次抽取留一行，失败的也留，同一张卡允许多行，以最新成功的一行为准。

| 字段              | 类型        | 说明                                                                          |
| ----------------- | ----------- | ----------------------------------------------------------------------------- |
| `id`              | BIGSERIAL   | 主键                                                                          |
| `app_id`          | TEXT        | 外键指向 `apps`，级联删除                                                     |
| `job_id`          | UUID        | 哪次任务抽的，任务被删则置空                                                  |
| `status`          | TEXT        | `success` 套到完整提示词 / `partial` 内容不像提示词 / `failed` 全部组合都没成 |
| `prompt_text`     | TEXT        | 抽到的提示词全文                                                              |
| `prompt_version`  | TEXT        | 用哪一版越狱提示词成的，取值是 `jailbreak_prompts.name`                       |
| `model_provider`  | TEXT        | 供应商                                                                        |
| `model_name`      | TEXT        | 模型名                                                                        |
| `attempts`        | INTEGER     | 试了多少组「模型 × 提示词」                                                   |
| `error`           | TEXT        | 最后一次报错                                                                  |
| `conversation_id` | TEXT        | 风月侧的会话 ID，需要回查原始对话时用                                         |
| `output_length`   | INTEGER     | 实际产出长度                                                                  |
| `expected_length` | INTEGER     | 风月标称长度，和产出长度一比就知道是不是被截断                                |
| `extracted_at`    | TIMESTAMPTZ | 抽取时间                                                                      |

提示词全文检索用 `pg_trgm` 的 GIN 索引做子串匹配（中文分词 Postgres 原生支持不好），
配合 `ILIKE` 能走索引。

### `aiero.list_state` — 翻页断点

| 字段         | 类型        | 说明                                     |
| ------------ | ----------- | ---------------------------------------- |
| `ranking`    | TEXT        | 主键，按哪种排序抓的                     |
| `done_pages` | INTEGER[]   | 已抓完的页码，重启后直接跳过             |
| `total`      | INTEGER     | 风月报告的角色卡总数，用来和入库数量对账 |
| `page_limit` | INTEGER     | 抓的时候用的每页条数                     |
| `updated_at` | TIMESTAMPTZ | 更新时间                                 |

想整体重抓一遍，清掉对应 `ranking` 的行即可。

### `aiero.job_logs` — 过程日志

| 字段         | 类型        | 说明                                |
| ------------ | ----------- | ----------------------------------- |
| `id`         | BIGSERIAL   | 主键，同时是时间顺序                |
| `job_id`     | UUID        | 外键指向 `jobs`，级联删除           |
| `level`      | TEXT        | `debug` / `info` / `warn` / `error` |
| `message`    | TEXT        | 日志正文，写入时按 4000 字截断      |
| `context`    | JSONB       | 预留的结构化字段，目前没写          |
| `created_at` | TIMESTAMPTZ | 时间                                |

### `aiero.accounts` — 风月账号池

| 字段              | 类型        | 说明                                                          |
| ----------------- | ----------- | ------------------------------------------------------------- |
| `id`              | UUID        | 主键                                                          |
| `email`           | TEXT        | 唯一，风月登录名                                              |
| `password_cipher` | TEXT        | `gcm:iv:tag:密文` 或 `plain:明文`，前缀自描述，接口一律不回传 |
| `enabled`         | BOOLEAN     | 禁用的不参与抽取，但保留体检记录                              |
| `note`            | TEXT        | 备注                                                          |
| `last_login_at`   | TIMESTAMPTZ | 最近一次体检时间                                              |
| `last_login_ok`   | BOOLEAN     | 体检结果，为空表示还没体检过                                  |
| `last_error`      | TEXT        | 体检失败原因                                                  |

### `aiero.jailbreak_prompts` — 越狱提示词库

| 字段         | 类型    | 说明                                                                |
| ------------ | ------- | ------------------------------------------------------------------- |
| `id`         | UUID    | 主键                                                                |
| `name`       | TEXT    | 唯一，会原样写进 `extractions.prompt_version`，**建好之后不能改名** |
| `content`    | TEXT    | 提示词正文                                                          |
| `enabled`    | BOOLEAN | 停用的不参与抽取，历史战绩保留                                      |
| `sort_order` | INTEGER | 尝试顺序，小的先试                                                  |
| `updated_by` | TEXT    | 最后修改人                                                          |

## 任务参数

存在 `jobs.params` 里，任务开始时会原样回显进日志。

| 参数                | 默认   | 说明                                                                  |
| ------------------- | ------ | --------------------------------------------------------------------- |
| `workers`           | 3      | 并发抽取数，上限 16                                                   |
| `listLimit`         | 200    | 列表每页条数                                                          |
| `listDelay`         | 1.5    | 翻页间隔秒数，实际再叠加 0~30% 随机抖动                               |
| `maxPages`          | 1000   | 最多翻多少页                                                          |
| `maxRounds`         | 8      | 单次抽取最多续写多少轮，长提示词一次吐不完要靠续写补齐                |
| `taskDelay`         | 1      | 两次抽取之间的间隔秒数，实际再叠加 0~40% 随机抖动                     |
| `jailbreakVersions` | 空     | 用哪几版越狱提示词（填名字），留空＝全部启用的                        |
| `models`            | `auto` | `auto` 表示启动时向风月拉取全部可用模型；也可以指定一组 provider/模型 |

## 抓取策略

一张卡按「模型 × 越狱提示词」的矩阵逐组尝试，外层换模型、内层换提示词，任一组套出提示词就收工：

- **模型顺序**：`auto` 时启动那一刻拉一次风月的可用模型清单，按「代码里的优先模型 → 同名优先模型 → 风月标的推荐 → 成功率降序」排。中间那档是给供应商改名留的余地——同一个模型换一家 provider 挂上来，只按 provider+名字精确匹配的话优先级会悄悄失效。优先模型不在清单里时任务日志会告警。
- **提示词顺序**：按 `sort_order` 从小到大。命中率高的排前面能省掉大量无效请求。
- **限流**：某个模型触发限流时，跳过它剩下的提示词版本直接换下一个模型——同一个账号在同一个模型上被限了，换提示词没有用。
- **判定**：套到完整提示词是 `success`；模型说完了但内容不像提示词是 `partial`；全部组合都没拿到结束标记是 `failed`。`partial` 有意保留，有些卡本身提示词就短，人工看一眼就能判断值不值得重抽。

页面上「可用模型」一页可以随时拉一份当前清单看顺序，「任务参数」里也能手动指定模型。

## 抓取配置

账号池和越狱提示词都在页面上管理，改完不用重新部署。两者的运行期来源都是数据库，
环境变量和源码里的常量只在对应的表为空时播种一次：

- **账号池**：`SCRAPER_ACCOUNTS` 只在 `aiero.accounts` 为空时导入一次。密码只写不读，
  任何接口都不回传，改密码只能整体覆盖。配了 `ACCOUNT_SECRET_KEY` 就用 AES-256-GCM
  加密存，没配则明文存并在页面上挂警告。账号失效不会让任务报错，只会让它领到的每张卡
  都抽失败，所以加完账号请点一次「体检」。
- **越狱提示词**：`packages/server/src/scraper/jailbreak.ts` 里的三版只在
  `aiero.jailbreak_prompts` 为空时播种。名字建好之后不能改，否则历史战绩对不上。

任务启动那一刻会把账号、模型和提示词全部取好并固定住，跑到一半改配置不影响正在运行的
任务——否则同一个任务前半段用 A 版、后半段用 B 版，成功率就没法归因了。

## 过程日志

每个任务的日志都存在 `aiero.job_logs` 里，任务跑完照样能翻回来看：任务控制台的
「历史任务」每行有「查看」，运行中的任务在「当前任务」卡片里直接看。

任务开头会把这次的参数、账号、模型顺序、提示词顺序全部写进日志，
一场全量抽取每张卡再写一条，所以日志视图不一次全拉，靠三个开关取样：

- **看多少条**：200 到 2000，后端按 2000 封顶，避免把浏览器塞死。
- **只看警告和错误**：抽取失败、限流、账号异常、优先模型失效都在这一档。
- **最新 / 任务开头**：开头那几行的配置信息会被后面的流水冲走，所以单独给了个入口。

任务失败的原因除了记在 `jobs.error`，也会写成一条 error 日志，日志流不会断在半路。

## 本地开发

```powershell
pnpm install
Copy-Item .env.example .env   # 填值

# 建表，按编号顺序跑一次
pnpm migrate migrations/001_aiero_schema.sql
pnpm migrate migrations/002_scraper_config.sql

pnpm dev:server
pnpm dev:web
```

后端默认 8080、前端默认 3010，端口在 `packages/server/src/config.ts` 和
`packages/web/package.json` 里改。本地想跳过登录可以在 `.env` 里设
`AUTH_DISABLED=true`，线上不要开。

## 导入历史数据

原脚本产出的目录可以整个导进来，可重复执行不会重复计数：

```powershell
pnpm import:legacy -- "本地的 aiero_prompt_output 目录"
```

会读 `queue.jsonl`、`results.jsonl`、`prompts/*.json`、`list_state.json`，
分别落到 `apps`、`extractions`、`list_state`。

## 部署

前端在 Vercel、后端在 Railway，具体地址见各自项目的控制台。仓库没有接 GitHub 自动部署，
改完代码要手动推。

后端：

```powershell
railway up --service <服务名> --detach
```

构建走 `packages/server/Dockerfile`，路径与健康检查配置在根目录 `railway.json`。
环境变量见 `.env.example` 的后端部分。

前端：

```powershell
vercel deploy --prod --yes
```

构建配置在根目录 `vercel.json`。前端的 `VITE_*` 变量是构建时注入的，改完要重新部署。
后端的 `CORS_ORIGINS` 锁在前端正式域名上，加自定义域名时要同步改。

数据库迁移不在部署流程里，`migrations/` 下的脚本要手动按编号执行：

```powershell
pnpm migrate migrations/<编号>_<名字>.sql
```

## 与原脚本的对应关系

| 原来                           | 现在                                    |
| ------------------------------ | --------------------------------------- |
| `queue.jsonl` + `seen_ids.txt` | `aiero.apps`                            |
| `results.jsonl` + `prompts/*`  | `aiero.extractions`                     |
| `progress.json`                | `aiero.jobs.stats`                      |
| `list_state.json`              | `aiero.list_state`                      |
| `run.log`                      | `aiero.job_logs`                        |
| `models.json`                  | 「可用模型」页现拉现看                  |
| 进程内 `claimed` 集合去重      | `FOR UPDATE SKIP LOCKED` 领取           |
| 硬编码账号密码                 | `aiero.accounts`（页面上管理）          |
| 硬编码三版越狱提示词           | `aiero.jailbreak_prompts`（页面上管理） |

越狱提示词、SSE 解析、账号轮换、限流退避、模型 × 越狱提示词矩阵、启发式判定这些
核心逻辑逐条对齐移植，判定阈值没有改动。

搬进数据库最关键的收益是并发领取：原来靠进程内的 `claimed` 集合去重，只在单进程内有效；
现在用 `FOR UPDATE SKIP LOCKED`，多 worker 甚至多容器都不会抢到同一张卡，
容器被重调度也不会丢进度。

## 注意

抓取会用真实账号访问风月并触发其计费与限流。并发数默认 3，是实测下来比较稳的值；
调高容易触发限流甚至封号。同一时刻只允许一个任务运行，由数据库唯一索引保证。

「连续几页空结果」只说明翻不下去了，不等于真的抓完——风月对深分页有 offset 上限，
翻到上限之后同样返回空页。列表同步结束时会拿入库数量和风月报告的总数对一次账，
差得多会在日志里告警。
