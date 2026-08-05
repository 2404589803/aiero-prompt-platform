# 提示词抓取平台

把原本单文件运行的 Python 抓取脚本改造成前后端分离的内部平台：网页上启停任务、看实时进度、检索抽取到的角色卡提示词。

抓取目标是 aigirlfriend.baby 的角色卡系统提示词，通过站点自己的聊天接口取得。

## 架构

| 层     | 技术                                      | 部署    |
| ------ | ----------------------------------------- | ------- |
| 前端   | React 18 + Vite + Ant Design              | Vercel  |
| 后端   | Fastify + TypeScript（含抓取任务运行器）  | Railway |
| 数据库 | Supabase Postgres 测试库的 `aiero` schema | —       |

后端直连 Postgres 而不走 PostgREST，因为任务领取要用 `FOR UPDATE SKIP LOCKED`。
`aiero` schema 不对 `anon` / `authenticated` 开放，浏览器拿不到数据库直连权限。

登录复用运营平台的 Supabase Auth 账号：前端登录拿到 JWT，后端校验后再查
`admin.admin_users` 确认这个人在管理员白名单里。`viewer` 角色只能看，不能启停任务。

## 与原脚本的对应关系

| 原来                           | 现在                                    |
| ------------------------------ | --------------------------------------- |
| `queue.jsonl` + `seen_ids.txt` | `aiero.apps`                            |
| `results.jsonl` + `prompts/*`  | `aiero.extractions`                     |
| `progress.json`                | `aiero.jobs.stats`                      |
| `list_state.json`              | `aiero.list_state`                      |
| `run.log`                      | `aiero.job_logs`                        |
| 进程内 `claimed` 集合去重      | `FOR UPDATE SKIP LOCKED` 领取           |
| 硬编码账号密码                 | `aiero.accounts`（页面上管理）          |
| 硬编码三版越狱提示词           | `aiero.jailbreak_prompts`（页面上管理） |

越狱提示词、SSE 解析、账号轮换、限流退避、模型 × 越狱提示词矩阵、启发式判定这些
核心逻辑逐条对齐移植，判定阈值没有改动。

## 抓取配置

账号池和越狱提示词都在页面上管理，改完不用重新部署。两者的运行期来源都是数据库，
环境变量和源码里的常量只在对应的表为空时播种一次：

- **账号池**：`SCRAPER_ACCOUNTS` 只在 `aiero.accounts` 为空时导入一次。密码只写不读，
  任何接口都不回传，改密码只能整体覆盖。配了 `ACCOUNT_SECRET_KEY` 就用 AES-256-GCM
  加密存，没配则明文存并在页面上挂警告。账号失效不会让任务报错，只会让它领到的每张卡
  都抽失败，所以加完账号请点一次「体检」。
- **越狱提示词**：`packages/server/src/scraper/jailbreak.ts` 里的三版只在
  `aiero.jailbreak_prompts` 为空时播种。抽取按顺序号从小到大逐个试，任一版套出提示词
  就收工；提示词的名字会写进抽取记录的 `prompt_version`，页面上据此统计每一版的成功率。
  名字建好之后不能改，否则历史战绩对不上。

任务启动那一刻会把账号和提示词取好并固定住，跑到一半改配置不影响正在运行的任务——
否则同一个任务前半段用 A 版、后半段用 B 版，成功率就没法归因了。

## 本地开发

```powershell
pnpm install
Copy-Item .env.example .env   # 填值

# 建表（只跑一次）
psql $env:DATABASE_URL -f migrations/001_aiero_schema.sql

pnpm dev:server   # http://localhost:8080
pnpm dev:web      # http://localhost:3010
```

本地想跳过登录可以在 `.env` 里设 `AUTH_DISABLED=true`，线上不要开。

## 导入历史数据

原脚本产出的目录可以整个导进来，可重复执行不会重复计数：

```powershell
pnpm import:legacy -- "D:\path\to\aiero_prompt_output"
```

## 部署

线上地址：

| 端     | 地址                                           |
| ------ | ---------------------------------------------- |
| 前端   | https://aiero-prompt-platform.vercel.app       |
| 后端   | https://aiero-server-production.up.railway.app |
| 数据库 | Supabase 测试项目的 `aiero` schema             |

后端（Railway 项目 `aiero-prompt-platform` / 服务 `aiero-server`）：

```powershell
railway up --service aiero-server --detach
```

构建走 `packages/server/Dockerfile`，路径与健康检查配置在根目录 `railway.json`；
仓库没有接 GitHub 自动部署，改完代码要手动 `railway up`。环境变量见 `.env.example` 的后端部分。

前端（Vercel 项目 `aiero-prompt-platform`）：

```powershell
vercel deploy --prod --yes
```

构建配置在根目录 `vercel.json`。前端的 `VITE_*` 变量是构建时注入的，改完要重新部署。
后端的 `CORS_ORIGINS` 锁在前端正式域名上，加自定义域名时要同步改。

## 过程日志

每个任务的日志都存在 `aiero.job_logs` 里，任务跑完照样能翻回来看：任务控制台的
「历史任务」每行有「查看」，运行中的任务在「当前任务」卡片里直接看。

一场全量抽取会写出十万条流水（每张卡一条），所以日志视图不一次全拉，靠三个开关取样：

- **看多少条**：200 到 2000，后端按 2000 封顶，避免把浏览器塞死。
- **只看警告和错误**：抽取失败、限流、账号异常都在这一档，排查时先切到这里。
- **最新 / 任务开头**：任务开头那几行写着这次用了哪些账号、模型和提示词，是排查
  「为什么全都失败」最有用的信息，但会被后面的流水冲走，所以单独给了个入口。

任务失败的原因除了记在 `jobs.error`，也会写成一条 error 日志，日志流不会断在半路。

## 注意

抓取会用真实账号访问第三方站点并触发其计费与限流。并发数默认 3，是实测下来比较稳的值；
调高容易触发限流甚至封号。同一时刻只允许一个任务运行，由数据库唯一索引保证。
