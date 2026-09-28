import { describe, it, expect } from "vitest";
import { StreamMapper } from "../src/mapper.js";

// ─── qodercli stream_event 构造工具 ─────────────────────────────────────────
const messageStart = () => ({
  type: "stream_event",
  event: { type: "message_start", message: { id: "msg_1", model: "auto" } },
});
const blockStart = (index: number, block: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "content_block_start", index, content_block: block },
});
const blockDelta = (index: number, delta: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "content_block_delta", index, delta },
});
const blockStop = (index: number) => ({
  type: "stream_event",
  event: { type: "content_block_stop", index },
});
const messageDelta = (stopReason: string | null, usage?: Record<string, unknown>) => ({
  type: "stream_event",
  event: { type: "message_delta", delta: { stop_reason: stopReason }, usage },
});
const messageStop = { type: "stream_event", event: { type: "message_stop" } };

describe("StreamMapper 工具名映射", () => {
  it("映射函数命中时使用 opencode 原名", () => {
    const m = new StreamMapper((p) => (p === "decl_0_abc" ? "bash" : undefined));
    const parts = m.map(blockStart(0, { type: "tool_use", id: "call_1", name: "decl_0_abc" }));
    expect(parts[0]).toMatchObject({ type: "tool-input-start", toolName: "bash", providerExecuted: false });
  });

  it("映射函数未命中时回退 __qoder_unsupported__ 占位名", () => {
    const m = new StreamMapper(() => undefined);
    const parts = m.map(blockStart(0, { type: "tool_use", id: "call_1", name: "unknown_thing" }));
    expect(parts[0]).toMatchObject({ type: "tool-input-start", toolName: "__qoder_unsupported__unknown_thing" });
  });

  it("无映射函数且名称含非法字符时做安全替换", () => {
    const m = new StreamMapper();
    const parts = m.map(blockStart(0, { type: "tool_use", id: "call_1", name: "weird name!" }));
    expect(parts[0]).toMatchObject({ type: "tool-input-start", toolName: "__qoder_unsupported__weird_name_" });
  });

  it("tool_use 缺名时 tool-call 使用 unknown_tool", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "tool_use", id: "c1" }));
    const stopParts = m.map(blockStop(0));
    expect(stopParts[1]).toMatchObject({ type: "tool-call", toolName: "unknown_tool", input: "{}" });
  });
});

describe("StreamMapper 事件映射", () => {
  it("message_start → stream-start", () => {
    const m = new StreamMapper();
    expect(m.map(messageStart())).toEqual([{ type: "stream-start", warnings: [] }]);
  });

  it("完整 text 块：text-start → text-delta → text-end", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    expect(m.map(blockStart(0, { type: "text" }))).toEqual([{ type: "text-start", id: "t0" }]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: "hello" }))).toEqual([
      { type: "text-delta", id: "t0", delta: "hello" },
    ]);
    expect(m.map(blockStop(0))).toEqual([{ type: "text-end", id: "t0" }]);
  });

  it("thinking 块映射为 reasoning 事件", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "thinking" }));
    expect(m.map(blockDelta(0, { type: "thinking_delta", thinking: "hmm" }))).toEqual([
      { type: "reasoning-delta", id: "r0", delta: "hmm" },
    ]);
    expect(m.map(blockStop(0))).toEqual([{ type: "reasoning-end", id: "r0" }]);
  });

  it("signature_delta 不产生事件", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "thinking" }));
    expect(m.map(blockDelta(0, { type: "signature_delta", signature: "x" }))).toEqual([]);
  });

  it("tool_use 块结束时发出 tool-input-end + tool-call（累积 input JSON）", () => {
    // 模拟 bridge 回映射成功（真实路径由 model.ts 注入）
    const m = new StreamMapper((p) => (p === "bash" ? "bash" : undefined));
    m.map(messageStart());
    m.map(blockStart(0, { type: "tool_use", id: "call_9", name: "bash" }));
    m.map(blockDelta(0, { type: "input_json_delta", partial_json: '{"command":' }));
    m.map(blockDelta(0, { type: "input_json_delta", partial_json: '"ls"}' }));
    const stopParts = m.map(blockStop(0));
    expect(stopParts).toHaveLength(2);
    expect(stopParts[0]).toEqual({ type: "tool-input-end", id: "call_9" });
    expect(stopParts[1]).toEqual({
      type: "tool-call",
      toolCallId: "call_9",
      toolName: "bash",
      input: '{"command":"ls"}',
      providerExecuted: false,
    });
  });

  it("message_delta 暂存 stop_reason 与 usage，finish 延迟到 flushFinish", () => {
    const m = new StreamMapper();
    // 不再立即发 finish（避免用不完整 usage 封顶）
    expect(m.map(messageDelta("tool_use", { input_tokens: 10, output_tokens: 5 }))).toEqual([]);
    expect(m.isToolBoundary()).toBe(true);
    expect(m.flushFinish()).toEqual([{
      type: "finish",
      finishReason: { unified: "tool-calls", raw: "tool_use" },
      usage: {
        inputTokens: { total: 10, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 5, text: 5, reasoning: undefined },
      },
    }]);
  });

  it("max_tokens → length（flush 时映射）", () => {
    const m = new StreamMapper();
    m.map(messageDelta("max_tokens"));
    const fin = m.flushFinish()[0];
    expect(fin.type === "finish" && fin.finishReason.unified).toBe("length");
  });

  it("message_stop 不再直接发 finish（统一由 flushFinish 发出）", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    expect(m.map(messageStop)).toEqual([]);
  });

  it("assistant 完整消息跳过（includePartialMessages 恒 true，防重复事件）", () => {
    const m = new StreamMapper();
    expect(m.map({ type: "assistant", message: { content: [] } })).toEqual([]);
  });

  it("system 与未知消息类型跳过", () => {
    const m = new StreamMapper();
    expect(m.map({ type: "system", subtype: "init" })).toEqual([]);
    expect(m.map({ type: "mystery" })).toEqual([]);
    expect(m.map(null)).toEqual([]);
  });

  it("result error → error part（拼接错误消息）", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "error", errors: [{ message: "boom" }] });
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("error");
    expect((parts[0] as { error: Error }).error.message).toBe("boom");
  });

  it("result error_during_execution + is_error → error part（不能静默 finish）", () => {
    // 实测：CN 账号配了全局 CLI 时，qodercli 返回
    //   {type:"result", subtype:"error_during_execution", is_error:true,
    //    errors:["The provided access token was rejected by the API"],
    //    terminal_reason:"access_token_invalid"}
    // 旧实现只认 subtype==="error"，于是把失败当成成功 → opencode 收到空回复。
    const m = new StreamMapper();
    const parts = m.map({
      type: "result",
      subtype: "error_during_execution",
      is_error: true,
      errors: ["The provided access token was rejected by the API"],
      terminal_reason: "access_token_invalid",
    });
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("error");
    expect((parts[0] as { error: Error }).error.message).toContain("access token was rejected");
  });

  it("result is_error（无 errors 数组）→ 带上 terminal_reason 的 error part", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "error_max_turns", is_error: true, terminal_reason: "max_turns" });
    expect(parts).toHaveLength(1);
    expect(parts[0].type).toBe("error");
    expect((parts[0] as { error: Error }).error.message).toContain("max_turns");
  });

  it("result success 且 is_error=false → 仍走 finish", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "success", is_error: false });
    expect(parts[0].type).toBe("finish");
  });

  it("result success 发出 finish（权威 usage）", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "success", usage: { input_tokens: 3, output_tokens: 7 } });
    expect(parts).toHaveLength(1);
    expect(parts[0]).toEqual({
      type: "finish",
      finishReason: { unified: "stop", raw: undefined },
      usage: {
        inputTokens: { total: 3, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
        outputTokens: { total: 7, text: 7, reasoning: undefined },
      },
    });
  });

  it("finish 只发一次：flushFinish 幂等，result 不重复", () => {
    const m = new StreamMapper();
    m.map(messageDelta("end_turn"));
    expect(m.flushFinish()).toHaveLength(1);
    expect(m.map({ type: "result", subtype: "success", usage: { input_tokens: 3 } })).toEqual([]);
    expect(m.flushFinish()).toEqual([]);
  });

  it("reset() 清空块状态", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.reset();
    expect(m.map(blockStop(0))).toEqual([]);
  });
});

describe("StreamMapper usage 累积", () => {
  it("流式增量取 max 合并，result 权威替换，cache 字段透传", () => {
    const m = new StreamMapper(undefined, 200_000);
    m.map(messageStart());
    m.map(messageDelta(null, { input_tokens: 100, output_tokens: 20 }));
    // 缺字段的后续帧不得覆盖已有值
    m.map(messageDelta("end_turn", { input_tokens: 60, output_tokens: 25, cache_read_input_tokens: 40 }));
    const parts = m.map({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 150, output_tokens: 30, cache_read_input_tokens: 50, cache_creation_input_tokens: 10 },
    });
    expect(parts[0].type).toBe("finish");
    const fin = parts[0] as { type: string; usage: { inputTokens: Record<string, unknown>; outputTokens: Record<string, unknown> } };
    expect(fin.usage.inputTokens).toMatchObject({ total: 150, cacheRead: 50, cacheWrite: 10 });
    expect(fin.usage.outputTokens).toMatchObject({ total: 30, text: 30 });
  });

  it("仅有 context_usage_ratio 时按 contextWindow 估算输入", () => {
    const m = new StreamMapper(undefined, 200_000);
    m.map(messageDelta(null, { context_usage_ratio: 0.25 }));
    const fin = m.flushFinish()[0];
    expect(fin.type === "finish" && fin.usage.inputTokens.total).toBe(50_000);
  });

  it("真实 input_tokens 优先于 ratio 估算", () => {
    const m = new StreamMapper(undefined, 200_000);
    m.map(messageDelta(null, { context_usage_ratio: 0.25, input_tokens: 42 }));
    const fin = m.flushFinish()[0];
    expect(fin.type === "finish" && fin.usage.inputTokens.total).toBe(42);
  });

  it("result.modelUsage 聚合兜底（direct usage 缺失字段）", () => {
    const m = new StreamMapper();
    const parts = m.map({
      type: "result",
      subtype: "success",
      usage: {},
      modelUsage: {
        gmodel: { inputTokens: 30, outputTokens: 5, cacheReadInputTokens: 7, cacheCreationInputTokens: 2 },
        auto: { inputTokens: 12, outputTokens: 3, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      },
    });
    // map(result) 的返回值即含 finish（mapResult 内部已 flush）
    expect(parts).toHaveLength(1);
    const fin = parts[0] as { type: string; usage: { inputTokens: Record<string, unknown>; outputTokens: Record<string, unknown> } };
    expect(fin.type).toBe("finish");
    expect(fin.usage.inputTokens).toMatchObject({ total: 42, cacheRead: 7, cacheWrite: 2 });
    expect(fin.usage.outputTokens).toMatchObject({ total: 8 });
  });

  it("无任何 usage 数据时 finish 携带 undefined（不伪造 0）", () => {
    const m = new StreamMapper();
    const parts = m.map({ type: "result", subtype: "success" });
    expect(parts).toHaveLength(1);
    const fin = parts[0] as { type: string; usage: { inputTokens: { total: number | undefined } } };
    expect(fin.type).toBe("finish");
    expect(fin.usage.inputTokens.total).toBeUndefined();
  });

  it("工具轮次：流式 usage 累积在进程终止前随 flush 发出", () => {
    const m = new StreamMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "tool_use", id: "c1", name: "bash" }));
    m.map(blockStop(0));
    m.map(messageDelta("tool_use", { input_tokens: 500, output_tokens: 80 }));
    // model.ts 在 isToolBoundary() 后 break，result 不会到达
    expect(m.isToolBoundary()).toBe(true);
    const fin = m.flushFinish()[0];
    expect(fin.type === "finish" && fin.finishReason.unified).toBe("tool-calls");
    expect(fin.type === "finish" && fin.usage.inputTokens.total).toBe(500);
  });

  it("qodercli 真实形状：token 全 0 回退 ratio 估算输入 + 字符估算输出", () => {
    const m = new StreamMapper(undefined, 180_000);
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(blockDelta(0, { type: "text_delta", text: "hi there!" })); // 9 chars
    m.map(blockStop(0));
    // 实测（debug-usage.mjs）：message_delta/result 的 token 字段全 0，仅 ratio 有效
    m.map(messageDelta("end_turn", {
      input_tokens: 0, output_tokens: 0,
      cache_read_input_tokens: 0, cache_creation_input_tokens: 0,
      context_usage_ratio: 0.0185,
    }));
    const parts = m.map({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.0185 },
    });
    const fin = parts[0] as { type: string; usage: { inputTokens: Record<string, unknown>; outputTokens: Record<string, unknown> } };
    expect(fin.type).toBe("finish");
    // 输入 = round(0.0185 × 180_000) = 3330
    expect(fin.usage.inputTokens.total).toBe(3330);
    // 输出 = ceil(9 / 4) = 3
    expect(fin.usage.outputTokens.total).toBe(3);
  });

  it("modelUsage 全 0（实测形状）不产生 0 封顶，估算回退仍生效", () => {
    const m = new StreamMapper(undefined, 180_000);
    const parts = m.map({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 0, output_tokens: 0, context_usage_ratio: 0.05 },
      modelUsage: { lite: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 } },
    });
    const fin = parts[0] as { type: string; usage: { inputTokens: Record<string, unknown>; outputTokens: Record<string, unknown> } };
    expect(fin.type).toBe("finish");
    expect(fin.usage.inputTokens.total).toBe(9000); // round(0.05 × 180_000)
    expect(fin.usage.outputTokens.total).toBeUndefined(); // 无字符、无真实值
  });

  it("credits（message_delta 实测来源）直通 finish 的 copilot totalNanoAiu", () => {
    const m = new StreamMapper();
    const credits = 0.030271428571428567;
    m.map(messageDelta("end_turn", { credits }));
    const fin = m.flushFinish()[0] as {
      type: string;
      providerMetadata?: Record<string, Record<string, unknown>>;
    };
    expect(fin.type).toBe("finish");
    // opencode getUsage: cost = totalNanoAiu / 1e11 = credits
    expect(fin.providerMetadata?.copilot?.totalNanoAiu).toBeCloseTo(credits * 1e11, 6);
  });

  it("assistant 消息的 request-level credits 被提取（官方推荐来源）", () => {
    const m = new StreamMapper();
    m.map({ type: "assistant", message: { content: [], usage: { credits: 0.5 } } });
    const fin = m.flushFinish()[0] as { providerMetadata?: Record<string, Record<string, unknown>> };
    expect(fin.providerMetadata?.copilot?.totalNanoAiu).toBeCloseTo(0.5e11, 6);
  });

  it("result.total_credits 作为兜底回退（usage 无 credits 时）", () => {
    const m = new StreamMapper();
    const parts = m.map({
      type: "result",
      subtype: "success",
      usage: { input_tokens: 0, output_tokens: 0 },
      total_credits: 0.12,
    });
    const fin = parts[0] as { providerMetadata?: Record<string, Record<string, unknown>> };
    expect(fin.providerMetadata?.copilot?.totalNanoAiu).toBeCloseTo(0.12e11, 6);
  });

  it("无 credits 时 finish 不携带 providerMetadata；credits=0 视为未报告", () => {
    const m1 = new StreamMapper();
    const fin1 = m1.flushFinish()[0] as { providerMetadata?: unknown };
    expect(fin1.providerMetadata).toBeUndefined();

    const m2 = new StreamMapper();
    m2.map(messageDelta("end_turn", { credits: 0 }));
    const fin2 = m2.flushFinish()[0] as { providerMetadata?: unknown };
    expect(fin2.providerMetadata).toBeUndefined();
  });
});
