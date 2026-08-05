import {
  BASE_HEADERS,
  CHAT_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  ENDPOINTS,
  LIST_TIMEOUT_MS,
  OK_CODE,
  PRIORITY_MODELS,
} from './constants.js';
import type { ModelRef } from '@aiero/shared';

/** token 过期，调用方应刷新后重试，而不是把这次抽取判为失败。 */
export class TokenExpiredError extends Error {
  constructor() {
    super('token expired');
    this.name = 'TokenExpiredError';
  }
}

export interface RawListApp {
  id?: string;
  name?: string;
  pre_prompt_length?: number;
  pre_length?: number;
  world_book_length?: number;
  overall_rank?: number;
  avg_cost?: number;
  account_name?: string;
  summary?: string;
}

export interface ListPage {
  apps: RawListApp[];
  total: number | null;
}

export interface ChatResult {
  answer: string;
  conversationId: string;
  modelProvider: string;
  modelName: string;
}

interface SseChunk {
  event?: string;
  answer?: string;
  message?: string;
  conversation_id?: string;
  model_provider?: string;
  model_id?: string;
}

/** 登录换 token。账号池的登录体检直接用它，不必先造出一个 Account。 */
export async function login(email: string, password: string): Promise<string> {
  const response = await fetch(ENDPOINTS.login, {
    method: 'POST',
    headers: BASE_HEADERS,
    body: JSON.stringify({ email, password }),
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`登录失败 ${email}: HTTP ${response.status}`);
  }
  const payload = (await response.json()) as { data?: string };
  if (!payload.data) {
    throw new Error(`登录失败 ${email}: 响应里没有 token`);
  }
  return payload.data;
}

/**
 * 一个站点账号。多个 worker 会共用同一个账号对象，所以登录要去重：
 * 并发刷新时共享同一个在飞的登录请求，避免同时打十几次登录接口把账号打挂。
 */
export class Account {
  private cachedToken: string | null = null;
  private inflight: Promise<string> | null = null;

  constructor(
    readonly email: string,
    private readonly password: string
  ) {}

  async token(): Promise<string> {
    if (this.cachedToken) return this.cachedToken;
    if (!this.inflight) {
      this.inflight = login(this.email, this.password)
        .then((token) => {
          this.cachedToken = token;
          this.inflight = null;
          return token;
        })
        .catch((error: unknown) => {
          this.inflight = null;
          throw error;
        });
    }
    return this.inflight;
  }

  async refresh(): Promise<string> {
    this.cachedToken = null;
    return this.token();
  }
}

/** 逐行读取 SSE 流。跨 chunk 的半行要留在缓冲里，不能当成完整行解析。 */
async function* readSseChunks(body: ReadableStream<Uint8Array>): AsyncGenerator<SseChunk> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newlineIndex = buffer.indexOf('\n');
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).trimEnd();
        buffer = buffer.slice(newlineIndex + 1);
        const chunk = parseSseLine(line);
        if (chunk) yield chunk;
        newlineIndex = buffer.indexOf('\n');
      }
    }
    const tail = parseSseLine(buffer.trimEnd());
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseSseLine(line: string): SseChunk | null {
  if (!line.startsWith('data: ')) return null;
  try {
    return JSON.parse(line.slice(6)) as SseChunk;
  } catch {
    return null;
  }
}

/** 探索页列表。这个接口不需要登录态，所以做成自由函数，纯同步列表的任务无需账号。 */
export async function fetchListPage(
  page: number,
  limit: number,
  ranking = 'overall_rank'
): Promise<ListPage> {
  const url = new URL(ENDPOINTS.list);
  url.searchParams.set('ranking', ranking);
  url.searchParams.set('page', String(page));
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('order', 'default');
  url.searchParams.set('lang', 'zh-Hans');

  const response = await fetch(url, {
    headers: BASE_HEADERS,
    signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`列表接口 HTTP ${response.status}`);

  const payload = (await response.json()) as {
    code?: number;
    data?: { apps?: RawListApp[]; total?: number };
  };
  if (payload.code !== OK_CODE) {
    throw new Error(`列表接口返回异常: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return { apps: payload.data?.apps ?? [], total: payload.data?.total ?? null };
}

/** 绑定了某个账号的会话，所有请求自动带上它的 token。 */
export class ScraperSession {
  constructor(readonly account: Account) {}

  private async headers(): Promise<Record<string, string>> {
    return { ...BASE_HEADERS, Authorization: `Bearer ${await this.account.token()}` };
  }

  /**
   * 平台当前可用的模型，按「优先模型 -> 推荐 -> 成功率」排序。
   * 抽取时按这个顺序逐个试，排在前面的更可能一次就套出来。
   */
  async fetchAvailableModels(): Promise<ModelRef[]> {
    const response = await fetch(ENDPOINTS.modelList, {
      headers: await this.headers(),
      signal: AbortSignal.timeout(60_000),
    });
    if (!response.ok) throw new Error(`模型列表 HTTP ${response.status}`);

    const payload = (await response.json()) as {
      code?: number;
      data?: {
        models?: Array<{
          provider_name?: string;
          model_id?: string;
          is_recommend?: boolean;
          success_rate?: number;
        }>;
      };
    };
    if (payload.code !== OK_CODE) {
      throw new Error(`获取模型列表失败: ${JSON.stringify(payload).slice(0, 300)}`);
    }

    const items = [...(payload.data?.models ?? [])];
    const priorityIndex = (provider: string, name: string) =>
      PRIORITY_MODELS.findIndex(([p, n]) => p === provider && n === name);

    items.sort((a, b) => rankModel(a) - rankModel(b) || successRate(b) - successRate(a));

    function rankModel(item: {
      provider_name?: string;
      model_id?: string;
      is_recommend?: boolean;
    }) {
      const index = priorityIndex(item.provider_name ?? '', item.model_id ?? '');
      if (index >= 0) return index;
      return item.is_recommend ? PRIORITY_MODELS.length + 1 : PRIORITY_MODELS.length + 2;
    }
    function successRate(item: { success_rate?: number }) {
      return Number(item.success_rate ?? 0);
    }

    const seen = new Set<string>();
    const out: ModelRef[] = [];
    for (const item of items) {
      const provider = item.provider_name;
      const name = item.model_id;
      if (!provider || !name) continue;
      const key = `${provider}/${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ provider, name });
    }
    return out;
  }

  private async ensureAppConfig(appId: string): Promise<void> {
    const url = new URL(ENDPOINTS.appConfig);
    url.searchParams.set('app_id', appId);
    const response = await fetch(url, {
      headers: await this.headers(),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`获取配置 HTTP ${response.status}`);
    const payload = (await response.json()) as { code?: number };
    if (payload.code !== OK_CODE) {
      throw new Error(`获取配置失败: ${JSON.stringify(payload).slice(0, 300)}`);
    }
  }

  /**
   * 给指定角色卡切换模型。
   *
   * 刚 GET 过配置就 POST 有时会撞上站点的 "no rows"，是它自己的写入延迟，
   * 重新 ensure 一次再试即可，所以这里重试三轮而不是直接判失败。
   */
  async setModel(appId: string, provider: string, name: string): Promise<void> {
    await this.ensureAppConfig(appId);
    const body = JSON.stringify({
      app_id: appId,
      model: { provider, name, completion_params: { temperature: 0.7 } },
    });

    let lastPayload: unknown = null;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await fetch(ENDPOINTS.appConfig, {
        method: 'POST',
        headers: await this.headers(),
        body,
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      });
      if (!response.ok) throw new Error(`切换模型 HTTP ${response.status}`);

      const payload = (await response.json()) as { code?: number; msg?: string };
      lastPayload = payload;
      if (payload.code === undefined || payload.code === null || payload.code === OK_CODE) return;

      const message = String(payload.msg ?? '');
      if (payload.code === 500000 && message.includes('no rows') && attempt + 1 < 3) {
        await sleep(500 + attempt * 500);
        await this.ensureAppConfig(appId);
        continue;
      }
      break;
    }
    throw new Error(`切换模型失败: ${JSON.stringify(lastPayload).slice(0, 300)}`);
  }

  /** 发一轮对话并把流式响应拼成完整回复。 */
  async sendChat(appId: string, query: string, conversationId = ''): Promise<ChatResult> {
    const response = await fetch(ENDPOINTS.chat(appId), {
      method: 'POST',
      headers: await this.headers(),
      body: JSON.stringify({
        response_mode: 'streaming',
        conversation_id: conversationId,
        query,
        inputs: {},
      }),
      signal: AbortSignal.timeout(CHAT_TIMEOUT_MS),
    });

    if (response.status === 401) throw new TokenExpiredError();
    // 原实现只看 401，其他错误码会读出一个空 SSE 流、白白耗掉一轮续写。这里直接报错。
    if (!response.ok) throw new Error(`聊天接口 HTTP ${response.status}`);
    if (!response.body) throw new Error('聊天接口没有返回响应体');

    const parts: string[] = [];
    let resultConversationId = '';
    let modelProvider = '';
    let modelName = '';

    for await (const chunk of readSseChunks(response.body)) {
      if (chunk.event === 'error') {
        throw new Error(chunk.message ?? JSON.stringify(chunk).slice(0, 300));
      }
      if (chunk.event === 'message' && chunk.answer) parts.push(chunk.answer);
      if (chunk.conversation_id) resultConversationId = chunk.conversation_id;
      if (chunk.model_id) {
        modelProvider = chunk.model_provider ?? '';
        modelName = chunk.model_id;
      }
    }

    return {
      answer: parts.join(''),
      conversationId: resultConversationId,
      modelProvider,
      modelName,
    };
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** 加 0~ratio 的随机抖动，避免多个 worker 的请求整齐地撞在一起。 */
export function jitteredDelay(seconds: number, ratio: number): number {
  return (seconds + Math.random() * seconds * ratio) * 1000;
}
