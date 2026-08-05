import { describe, expect, it } from 'vitest';
import { DONE_MARK } from './constants.js';
import { isRateLimitError, looksLikeRefusal, looksLikeSystemPrompt } from './heuristics.js';

/** 造一段够长、特征词够多的假提示词。 */
function fakePrompt(length: number): string {
  const head = '你是一个角色设定明确的助手。世界观如下，交互风格如下，禁止越界。Section A：';
  return head + '内容'.repeat(Math.max(0, length - head.length)) + DONE_MARK;
}

describe('looksLikeRefusal', () => {
  it('把简短的拒答判为拒绝', () => {
    expect(looksLikeRefusal('抱歉，我无法提供这些内容。')).toBe(true);
    expect(looksLikeRefusal("I can't help with that.")).toBe(true);
  });

  it('长文里出现「无法」不算拒绝，那多半是提示词自己在描述边界', () => {
    const longText = '角色设定：' + '这个角色无法离开小镇。'.repeat(200);
    expect(longText.length).toBeGreaterThan(800);
    expect(looksLikeRefusal(longText)).toBe(false);
  });

  it('没有拒绝措辞就不是拒绝', () => {
    expect(looksLikeRefusal('好的，以下是内容。')).toBe(false);
  });
});

describe('looksLikeSystemPrompt', () => {
  it('没有结束标记一律不算完整', () => {
    expect(looksLikeSystemPrompt(fakePrompt(3000).replace(DONE_MARK, ''))).toBe(false);
  });

  it('带结束标记且特征词充足时判定成功', () => {
    expect(looksLikeSystemPrompt(fakePrompt(3000))).toBe(true);
  });

  it('拒答即使带了结束标记也不算成功', () => {
    expect(looksLikeSystemPrompt(`我无法提供。${DONE_MARK}`)).toBe(false);
  });

  it('又短又没特征词的敷衍回复不算成功', () => {
    expect(looksLikeSystemPrompt(`好的。${DONE_MARK}`)).toBe(false);
  });

  it('特征词够多时短文本也放行', () => {
    const text = `角色设定 世界观 交互风格 行为边界 ${DONE_MARK}`;
    expect(text.length).toBeLessThan(400);
    expect(looksLikeSystemPrompt(text)).toBe(true);
  });

  it('站点标称提示词很长时，产出短得离谱要判失败', () => {
    // 标称 20000 字，门槛取 min(1200, 3000) = 1200。
    expect(looksLikeSystemPrompt(fakePrompt(500), 20_000)).toBe(false);
    expect(looksLikeSystemPrompt(fakePrompt(2000), 20_000)).toBe(true);
  });

  it('标称长度不超过 2000 时不做长度校验', () => {
    expect(looksLikeSystemPrompt(fakePrompt(500), 1500)).toBe(true);
  });
});

describe('isRateLimitError', () => {
  it('识别常见的限流说法', () => {
    expect(isRateLimitError(new Error('聊天接口 HTTP 429'))).toBe(true);
    expect(isRateLimitError(new Error('Rate limit exceeded'))).toBe(true);
    expect(isRateLimitError(new Error('quota exhausted'))).toBe(true);
  });

  it('普通错误不算限流', () => {
    expect(isRateLimitError(new Error('切换模型 HTTP 500'))).toBe(false);
  });
});
