import { DONE_MARK, PROMPT_HINTS, REFUSAL_HINTS } from './constants.js';

/**
 * 模型是不是在拒答。
 *
 * 只有短回复才判为拒绝：长文里出现「无法」「不能」这类词多半是被抽出来的提示词本身
 * 在描述行为边界，不是模型在拒绝我们。
 */
export function looksLikeRefusal(text: string): boolean {
  const low = text.toLowerCase();
  return REFUSAL_HINTS.some((hint) => low.includes(hint)) && text.length < 800;
}

/**
 * 抽到的内容是不是一份完整的系统提示词。
 *
 * 判定链路：必须带结束标记 -> 不能是拒答 -> 特征词够多或者篇幅够长 ->
 * 站点标称的 pre_prompt_length 很长时，产出不能短得离谱。
 * 最后一条挡的是模型只吐了个开头就喊「已经生成完了」的情况。
 */
export function looksLikeSystemPrompt(text: string, expectedLength?: number | null): boolean {
  if (!text.includes(DONE_MARK)) return false;
  if (looksLikeRefusal(text)) return false;

  const low = text.toLowerCase();
  const hits = PROMPT_HINTS.filter((hint) => low.includes(hint.toLowerCase())).length;
  if (hits < 2 && text.length < 400) return false;

  if (expectedLength && expectedLength > 2000) {
    const floor = Math.min(1200, expectedLength * 0.15);
    if (text.length < floor) return false;
  }
  return true;
}

/** 站点限流的各种说法，命中后要退避而不是立刻换模型硬重试。 */
export function isRateLimitError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const low = raw.toLowerCase();
  return (
    raw.includes('429') ||
    low.includes('rate limit') ||
    low.includes('quota') ||
    low.includes('exhausted')
  );
}
