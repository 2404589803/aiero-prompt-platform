import {
  EMPTY_JOB_STATS,
  type Job,
  type JobKind,
  type JobParams,
  type JobStats,
  type ModelRef,
} from '@aiero/shared';
import { config } from '../config.js';
import { Account, ScraperSession, fetchListPage, jitteredDelay, sleep } from '../scraper/client.js';
import { extractOne } from '../scraper/extract.js';
import * as repo from './repository.js';

const HEARTBEAT_INTERVAL_MS = 5_000;
const QUEUE_POLL_MS = 2_000;
/** 队列空转这么多轮且列表已同步完，就认为没活可干了。 */
const IDLE_ROUNDS_BEFORE_EXIT = 5;

interface RunState {
  jobId: string;
  stats: JobStats;
  aborted: boolean;
  listDone: boolean;
  /** 已领取但还没落库的角色卡，任务被叫停时要放回队列。 */
  inflight: Set<string>;
}

export class JobAlreadyRunningError extends Error {
  constructor() {
    super('已有任务在运行，请先停止当前任务');
    this.name = 'JobAlreadyRunningError';
  }
}

/**
 * 抓取任务运行器。
 *
 * 进程内单例：数据库上有唯一索引保证同一时刻只有一个活跃任务，
 * 这里再挡一层，避免同一个进程里重复起协程。
 */
class JobRunner {
  private state: RunState | null = null;

  isRunning(): boolean {
    return this.state !== null;
  }

  currentJobId(): string | null {
    return this.state?.jobId ?? null;
  }

  async start(kind: JobKind, params: JobParams, createdBy: string | null): Promise<Job> {
    if (this.state) throw new JobAlreadyRunningError();
    if (kind !== 'list' && config.accounts.length === 0) {
      throw new Error('没有配置抓取账号，无法执行抽取任务（设置 SCRAPER_ACCOUNTS）');
    }

    let job: Job;
    try {
      job = await repo.createJob(kind, params, createdBy);
    } catch (error) {
      // 唯一索引挡下的并发启动：数据库里已经有活跃任务了。
      if (error instanceof Error && error.message.includes('idx_jobs_single_active')) {
        throw new JobAlreadyRunningError();
      }
      throw error;
    }

    this.state = {
      jobId: job.id,
      stats: { ...EMPTY_JOB_STATS },
      aborted: false,
      listDone: kind === 'extract',
      inflight: new Set(),
    };

    // 不 await：任务可能跑几小时，HTTP 请求要立刻返回。
    void this.run(kind, params).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      void repo.markJobFinished(job.id, 'failed', message);
      this.state = null;
    });

    return job;
  }

  /** 请求停止。运行器会在下一个检查点收尾，不会硬杀正在飞的请求。 */
  async stop(): Promise<void> {
    const state = this.state;
    if (!state) return;
    state.aborted = true;
    await repo.requestJobStop(state.jobId);
  }

  private async run(kind: JobKind, params: JobParams): Promise<void> {
    const state = this.state;
    if (!state) return;

    await repo.markJobRunning(state.jobId);
    await this.log('info', `任务开始：${kind}`);

    const heartbeat = setInterval(() => {
      void this.beat();
    }, HEARTBEAT_INTERVAL_MS);

    try {
      const accounts = config.accounts.map((item) => new Account(item.email, item.password));
      const models = kind === 'list' ? [] : await this.resolveModels(params, accounts);
      if (kind !== 'list') {
        await this.log(
          'info',
          `可用模型 ${models.length} 个，越狱版本 ${params.jailbreakVersions.join('/')}`
        );
      }

      const tasks: Promise<void>[] = [];
      if (kind === 'list' || kind === 'full') {
        tasks.push(this.runListSync(params));
      }
      if (kind === 'extract' || kind === 'full') {
        const workerCount = Math.max(1, Math.min(params.workers, 16));
        for (let index = 0; index < workerCount; index += 1) {
          const account = accounts[index % accounts.length];
          if (!account) break;
          tasks.push(this.runExtractWorker(index, account, models, params));
        }
      }
      await Promise.all(tasks);

      await this.beat();
      await repo.markJobFinished(state.jobId, state.aborted ? 'stopped' : 'completed');
      await this.log('info', state.aborted ? '任务已停止' : '任务完成');
    } finally {
      clearInterval(heartbeat);
      await this.releaseInflight();
      this.state = null;
    }
  }

  private async resolveModels(params: JobParams, accounts: Account[]): Promise<ModelRef[]> {
    if (params.models !== 'auto') return params.models;
    const account = accounts[0];
    if (!account) throw new Error('没有可用账号，无法自动获取模型列表');
    return new ScraperSession(account).fetchAvailableModels();
  }

  /** 写心跳并同步进度；顺便读回状态，别的实例点了停止也能感知到。 */
  private async beat(): Promise<void> {
    const state = this.state;
    if (!state) return;
    try {
      const status = await repo.heartbeatJob(state.jobId, state.stats);
      if (status === 'stopping') state.aborted = true;
    } catch {
      // 心跳失败不该让任务崩掉，下一轮再试。
    }
  }

  private async log(level: 'info' | 'warn' | 'error', message: string): Promise<void> {
    const state = this.state;
    if (!state) return;
    try {
      await repo.appendJobLog(state.jobId, level, message);
    } catch {
      // 日志写不进去不影响抓取本身。
    }
  }

  private async releaseInflight(): Promise<void> {
    const state = this.state;
    if (!state || state.inflight.size === 0) return;
    try {
      await repo.releaseClaims([...state.inflight]);
    } catch {
      // 放不回去也没关系：僵尸回收会在下次启动时兜底。
    }
    state.inflight.clear();
  }

  /**
   * 同步角色卡列表。
   *
   * 已抓过的页码从数据库读，重启后直接跳过。连续三页空结果就认为翻到底了——
   * 站点偶尔会在中间返回一页空数据，只看一页会提前收工。
   */
  private async runListSync(params: JobParams): Promise<void> {
    const state = this.state;
    if (!state) return;
    const ranking = 'overall_rank';

    try {
      const donePages = await repo.getDonePages(ranking);
      let emptyStreak = 0;
      for (let page = 1; page <= params.maxPages; page += 1) {
        if (state.aborted) {
          await this.log('warn', `列表同步在第 ${page} 页被停止`);
          break;
        }
        if (donePages.has(page)) continue;

        const { apps, total } = await fetchListPage(page, params.listLimit, ranking);
        const added = await repo.upsertApps(apps);
        await repo.markPageDone(ranking, page, total, params.listLimit);

        state.stats.pagesDone += 1;
        state.stats.appsDiscovered += added;

        if (apps.length === 0) {
          emptyStreak += 1;
          if (emptyStreak >= 3) break;
        } else {
          emptyStreak = 0;
        }

        await this.log('info', `列表第 ${page} 页：返回 ${apps.length}，新增 ${added}`);
        await sleep(jitteredDelay(params.listDelay, 0.3));
      }
      await this.log('info', '列表同步结束');
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.log('error', `列表同步异常：${message}`);
    } finally {
      state.listDone = true;
    }
  }

  /**
   * 抽取 worker。
   *
   * 每轮从数据库领一张卡，抽完落库再领下一张。领取用 SKIP LOCKED，
   * 所以多个 worker 之间不需要任何进程内协调。
   */
  private async runExtractWorker(
    index: number,
    account: Account,
    models: ModelRef[],
    params: JobParams
  ): Promise<void> {
    const state = this.state;
    if (!state) return;
    const workerId = `${state.jobId}:${index}`;
    let idleRounds = 0;

    while (!state.aborted) {
      const [target] = await repo.claimApps(1, workerId);

      if (!target) {
        if (state.listDone) {
          idleRounds += 1;
          if (idleRounds >= IDLE_ROUNDS_BEFORE_EXIT) return;
        }
        await sleep(QUEUE_POLL_MS);
        continue;
      }
      idleRounds = 0;
      state.inflight.add(target.appId);

      try {
        const outcome = await extractOne(account, target, {
          models,
          jailbreakVersions: params.jailbreakVersions,
          maxRounds: params.maxRounds,
          shouldStop: () => state.aborted,
          onLog: (level, message) => void this.log(level, message),
        });

        // 被叫停时抽到的半成品不算数：记成 failed 会让这张卡再也排不上队。
        if (state.aborted) {
          await repo.releaseClaims([target.appId]);
        } else {
          await repo.saveExtraction(state.jobId, outcome);
          state.stats[outcome.status] += 1;
          await this.log(
            'info',
            `完成 ${target.appId} status=${outcome.status} len=${outcome.outputLength} model=${outcome.modelProvider}/${outcome.modelName}`
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await repo.releaseClaims([target.appId]);
        await this.log('error', `worker ${index} 处理 ${target.appId} 异常：${message}`);
        await sleep(2000);
      } finally {
        state.inflight.delete(target.appId);
      }

      if (!state.aborted) await sleep(jitteredDelay(params.taskDelay, 0.4));
    }
  }
}

export const jobRunner = new JobRunner();
