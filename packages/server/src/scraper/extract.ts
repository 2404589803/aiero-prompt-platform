import type { ModelRef } from '@aiero/shared';
import { CONTINUE_PROMPT, DONE_MARK } from './constants.js';
import { Account, ScraperSession, TokenExpiredError, sleep } from './client.js';
import { isRateLimitError, looksLikeRefusal, looksLikeSystemPrompt } from './heuristics.js';
import type { PromptRef } from '../settings/prompts.js';

export interface ExtractTarget {
  appId: string;
  name: string | null;
  prePromptLength: number | null;
}

export interface ExtractOutcome {
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

export interface ExtractOptions {
  models: ModelRef[];
  /** 越狱提示词，已按尝试顺序排好，由调用方从库里取。 */
  jailbreakPrompts: PromptRef[];
  maxRounds: number;
  /** 返回 true 表示任务被要求停止，应尽快收尾退出。 */
  shouldStop?: () => boolean;
  onLog?: (level: 'info' | 'warn', message: string) => void;
}

/**
 * 对一张角色卡做一次完整抽取。
 *
 * 策略是「模型 × 越狱提示词」的矩阵：外层换模型，内层换提示词，任一组合成功就收工。
 * 单个组合内部最多续写 maxRounds 轮，因为长提示词一次吐不完，要靠续写补齐。
 *
 * 三种收尾：套出完整提示词是 success；模型说完了但内容不像提示词是 partial；
 * 全部组合都没拿到结束标记是 failed。partial 保留下来是有意的，
 * 有些卡本身提示词就短，人工看一眼就能判断值不值得重抽。
 */
export async function extractOne(
  account: Account,
  target: ExtractTarget,
  options: ExtractOptions
): Promise<ExtractOutcome> {
  const { models, jailbreakPrompts, maxRounds, shouldStop, onLog } = options;
  const session = new ScraperSession(account);
  const expectedLength = target.prePromptLength;

  const outcome: ExtractOutcome = {
    appId: target.appId,
    status: 'failed',
    promptText: '',
    promptVersion: '',
    modelProvider: '',
    modelName: '',
    attempts: 0,
    error: '',
    conversationId: '',
    outputLength: 0,
    expectedLength,
  };

  for (const model of models) {
    if (shouldStop?.()) break;

    for (const prompt of jailbreakPrompts) {
      if (shouldStop?.()) break;
      outcome.attempts += 1;

      try {
        await session.setModel(target.appId, model.provider, model.name);

        const parts: string[] = [];
        let conversationId = '';

        for (let round = 0; round < maxRounds; round += 1) {
          if (shouldStop?.()) break;

          const query = round === 0 ? prompt.content : CONTINUE_PROMPT;
          const chat = await session.sendChat(target.appId, query, conversationId);
          conversationId = chat.conversationId;
          if (chat.answer) parts.push(chat.answer);

          const combined = parts.join('\n\n').trim();
          outcome.conversationId = conversationId;
          outcome.modelProvider = chat.modelProvider || model.provider;
          outcome.modelName = chat.modelName || model.name;
          outcome.outputLength = combined.length;
          outcome.promptText = combined;
          outcome.promptVersion = prompt.name;

          if (looksLikeSystemPrompt(combined, expectedLength)) {
            outcome.status = 'success';
            return outcome;
          }
          if (combined.includes(DONE_MARK) && !looksLikeRefusal(combined)) {
            outcome.status = 'partial';
            return outcome;
          }
          // 第一轮就被拒，多续几轮也不会松口，直接换下一个越狱版本。
          if (looksLikeRefusal(combined) && round === 0) break;
        }
      } catch (error) {
        if (error instanceof TokenExpiredError) {
          await account.refresh();
          continue;
        }

        const message = error instanceof Error ? error.message : String(error);
        outcome.error = `${model.provider}/${model.name}/${prompt.name}: ${message}`;
        onLog?.(
          'warn',
          `提取失败 ${target.appId} ${model.provider}/${model.name} ${prompt.name}: ${message}`
        );

        if (message.includes('401')) await account.refresh();
        if (isRateLimitError(error)) {
          // 这个账号在这个模型上已经被限流，换越狱版本无济于事，直接换模型。
          await sleep(3000);
          break;
        }
        await sleep(2000);
      }
    }
  }

  outcome.status = outcome.promptText.includes(DONE_MARK) ? 'partial' : 'failed';
  return outcome;
}
