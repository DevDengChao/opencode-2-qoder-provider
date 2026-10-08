/**
 * mapper.ts — SDKMessage → LanguageModelV3StreamPart 映射器
 *
 * 将 SDK 的 28 种 SDKMessage 变体映射为 AI SDK 的流式事件。
 * 核心处理 stream_event 的 6 种 BetaRawMessageStreamEvent 变体：
 *   message_start, content_block_start, content_block_delta,
 *   content_block_stop, message_delta, message_stop
 *
 * 另含「工具调用文本泄漏回收」：qfmodel 偶发把 tool_use 以
 * `<tool_call><function=…>…</function></tool_call>` 纯文本形式输出
 * （stop_reason=end_turn），opencode 会当作普通文本、整轮无声中断。
 * text 块流式阶段做 holdback 拦截，块结束时解析回真正的 tool-call
 * 事件（解析器见 toolcall-leak.ts）。
 *
 * 每个 Query 对应一个 StreamMapper 实例（per-query state）。
 */
import { parseLeakedToolCalls, LEAK_MARKER, type LeakedToolCall } from "./toolcall-leak.js";
import { logInfo } from "./logger.js";

// ─── AI SDK V3 流式事件类型 ────────────────────────────────────────────────
/** JSON 兼容值（结构与 AI SDK 内部 JSONValue 一致，保证可赋给 SharedV3ProviderMetadata） */
type JSONValue = null | string | number | boolean | { [key: string]: JSONValue | undefined } | JSONValue[];
export type V3ProviderMetadata = Record<string, { [key: string]: JSONValue | undefined }>;

export type V3StreamPart =
  | { type: "stream-start"; warnings: Array<{ type: string; message: string }> }
  | { type: "text-start"; id: string }
  | { type: "text-delta"; id: string; delta: string }
  | { type: "text-end"; id: string }
  | { type: "reasoning-start"; id: string }
  | { type: "reasoning-delta"; id: string; delta: string }
  | { type: "reasoning-end"; id: string }
  | { type: "tool-input-start"; id: string; toolName: string; providerExecuted?: boolean }
  | { type: "tool-input-delta"; id: string; delta: string }
  | { type: "tool-input-end"; id: string }
  | { type: "tool-call"; toolCallId: string; toolName: string; input: string; providerExecuted?: boolean }
  | { type: "finish"; finishReason: V3FinishReason; usage: V3Usage; providerMetadata?: V3ProviderMetadata }
  | { type: "error"; error: unknown }
  | { type: "raw"; rawValue: unknown };

export interface V3FinishReason {
  unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
  raw: string | undefined;
}

export interface V3Usage {
  inputTokens: { total: number | undefined; noCache: number | undefined; cacheRead: number | undefined; cacheWrite: number | undefined };
  outputTokens: { total: number | undefined; text: number | undefined; reasoning: number | undefined };
}

// ─── Content Block 类型跟踪 ─────────────────────────────────────────────────
type BlockType = "text" | "thinking" | "tool_use";

interface BlockState {
  type: BlockType;
  id: string;       // tool_use: call ID; text/thinking: 生成的 ID
  name?: string;    // tool_use: tool name
  accumulatedArgs: string; // tool_use: accumulated JSON args
  // ── text 块专用（工具调用文本泄漏回收，见 toolcall-leak.ts）──
  textStarted?: boolean;   // 懒发 text-start：首个实际文本 delta 时才发（纯泄漏块不产生空文本段）
  holdback?: string;       // 疑似 `<tool_call>` 前缀的暂扣缓冲（≤10 字符）
  inLeak?: boolean;        // 已命中 `<tool_call>`，后续 delta 全部收入 leakBuffer
  leakBuffer?: string;     // `<tool_call>` 之后的原始文本（块结束/收尾时解析）
}

/** BetaUsage（qodercli 流式事件的 usage 结构，Anthropic 风格） */
interface QoderUsage {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  context_usage_ratio?: number | null;
  /** Qoder 请求级真实计量（折扣后 credits） */
  credits?: number | null;
}

/** SDK result.modelUsage 的单模型条目（camelCase，见 SDK protocol/common.d.ts） */
interface QoderModelUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
}

// ─── StreamMapper ───────────────────────────────────────────────────────────
export class StreamMapper {
  /** index → block 状态（per-query） */
  private blocks = new Map<number, BlockState>();
  private messageId = "";
  private modelId = "";
  private emittedFinish = false;
  /** qodercli 侧工具名 → opencode 原名（声明型 MCP 桥接） */
  private toOpencodeName?: (providerName: string) => string | undefined;
  /** 模型上下文窗口（用于 context_usage_ratio 估算输入 token） */
  private contextWindow: number;
  /** opencode 工具名清单（文本泄漏回收时的名称归一化参考） */
  private knownToolNames?: string[];
  /** 本消息是否从文本中回收过工具调用（finish 判定为 tool-calls） */
  private synthesizedToolCalls = false;
  /** 泄漏回收 tool-call id 的序号（保证同一消息内 id 唯一） */
  private leakSeq = 0;

  // usage 累积状态：流式事件增量合并（max），result 权威替换（final）
  private usageInput?: number;
  private usageOutput?: number;
  private usageCacheRead?: number;
  private usageCacheWrite?: number;
  /** 仅有 context_usage_ratio 时的输入估算值（真实 input_tokens 到达后被替换） */
  private estimatedContext?: number;
  /** 生成字符数累计（qodercli 不上报 output token，用字符数粗略估算） */
  private outputChars = 0;
  /** 服务端请求级真实计量（Qoder credits；0/缺失视为未报告） */
  private credits?: number;
  private pendingStopReason?: string | null;

  constructor(
    toOpencodeName?: (providerName: string) => string | undefined,
    contextWindow?: number,
    knownToolNames?: string[],
  ) {
    this.toOpencodeName = toOpencodeName;
    this.contextWindow = contextWindow ?? 0;
    this.knownToolNames = knownToolNames && knownToolNames.length > 0 ? knownToolNames : undefined;
  }

  /** 工具名映射：未知名转换为安全的占位名，由 opencode 返回 tool not found */
  private mapToolName(providerName: string | undefined): string {
    if (!providerName) return "unknown_tool";
    return this.toOpencodeName?.(providerName) ?? `__qoder_unsupported__${providerName.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48)}`;
  }

  /** 重置状态（新消息开始时） */
  reset(): void {
    this.blocks.clear();
    this.messageId = "";
    this.modelId = "";
    this.emittedFinish = false;
    this.usageInput = undefined;
    this.usageOutput = undefined;
    this.usageCacheRead = undefined;
    this.usageCacheWrite = undefined;
    this.estimatedContext = undefined;
    this.outputChars = 0;
    this.credits = undefined;
    this.pendingStopReason = undefined;
    this.synthesizedToolCalls = false;
  }

  /**
   * 处理一个 SDKMessage，返回零或多个 LanguageModelV3StreamPart。
   *
   * SDKMessage 类型（来自 @qoder-ai/qoder-agent-sdk）：
   *  - system/init → 跳过
   *  - assistant → 完整消息（非流式场景）
   *  - stream_event → 6 种 BetaRawMessageStreamEvent
   *  - result → 最终结果
   *  - 其他 → 跳过或作为 raw 事件
   */
  map(msg: any): V3StreamPart[] {
    if (!msg || typeof msg !== "object") return [];

    switch (msg.type) {
      case "system":
        // system/init: 提取模型信息，不产生流式事件
        return [];

      case "stream_event":
        return this.mapStreamEvent(msg.event);

      case "assistant":
        // 完整 assistant 消息：内容由 stream_event 覆盖（includePartialMessages
        // 恒 true），但请求级 credits 官方指定从这里读取（result.usage 的
        // credits 不可靠），跳过内容前先提取
        this.applyUsage(msg.message?.usage, true);
        return [];

      case "result":
        return this.mapResult(msg);

      default:
        // 其他 20+ 种消息类型：忽略
        return [];
    }
  }

  // ─── stream_event 处理 ──────────────────────────────────────────────────
  private mapStreamEvent(event: any): V3StreamPart[] {
    if (!event) return [];
    const parts: V3StreamPart[] = [];

    switch (event.type) {
      case "message_start": {
        const message = event.message;
        if (message) {
          this.messageId = message.id || "";
          this.modelId = message.model || "";
          // message_start.usage 可能携带 context_usage_ratio 等初始计量
          this.applyUsage(message.usage, false);
        }
        parts.push({ type: "stream-start", warnings: [] });
        break;
      }

      case "content_block_start": {
        const idx = event.index as number;
        const block = event.content_block;
        if (block && typeof idx === "number") {
          const state: BlockState = {
            type: block.type as BlockType,
            id: "",
            name: undefined,
            accumulatedArgs: "",
          };

          switch (block.type) {
            case "text":
              // 懒发 text-start：等首个实际文本 delta 再发（纯泄漏块不产生空文本段）
              state.id = `t${idx}`;
              state.textStarted = false;
              state.holdback = "";
              state.inLeak = false;
              state.leakBuffer = "";
              break;

            case "thinking":
              state.id = `r${idx}`;
              parts.push({ type: "reasoning-start", id: state.id });
              break;

            case "tool_use":
              state.id = block.id || `tc${idx}`;
              state.name = this.mapToolName(block.name);
              parts.push({
                type: "tool-input-start",
                id: state.id,
                toolName: state.name || "",
                providerExecuted: false,
              });
              break;
          }

          this.blocks.set(idx, state);
        }
        break;
      }

      case "content_block_delta": {
        const idx = event.index as number;
        const delta = event.delta;
        if (delta && typeof idx === "number") {
          const state = this.blocks.get(idx);

          switch (delta.type) {
            case "text_delta":
              if (state) {
                const text = delta.text || "";
                this.outputChars += text.length;
                parts.push(...this.pushTextDelta(state, text));
              }
              break;

            case "thinking_delta":
              if (state) {
                const thinking = delta.thinking || "";
                this.outputChars += thinking.length;
                parts.push({
                  type: "reasoning-delta",
                  id: state.id,
                  delta: thinking,
                });
              }
              break;

            case "input_json_delta":
              if (state) {
                const jsonDelta = delta.partial_json || "";
                state.accumulatedArgs += jsonDelta;
                this.outputChars += jsonDelta.length;
                parts.push({
                  type: "tool-input-delta",
                  id: state.id,
                  delta: jsonDelta,
                });
              }
              break;

            case "signature_delta":
              // thinking signature — 不映射到 AI SDK 事件
              break;
          }
        }
        break;
      }

      case "content_block_stop": {
        const idx = event.index as number;
        const state = this.blocks.get(idx);
        if (state) {
          switch (state.type) {
            case "text":
              parts.push(...this.finalizeTextBlock(state));
              break;
            case "thinking":
              parts.push({ type: "reasoning-end", id: state.id });
              break;
            case "tool_use":
              parts.push({ type: "tool-input-end", id: state.id });
              // 同时发出 tool-call 事件（V3 格式）
              parts.push({
                type: "tool-call",
                toolCallId: state.id,
                toolName: state.name || "",
                input: state.accumulatedArgs || "{}",
                providerExecuted: false,
              });
              break;
          }
          this.blocks.delete(idx);
        }
        break;
      }

      case "message_delta": {
        // usage 增量合并 + stop_reason 暂存；finish 统一延迟到 result /
        // flushFinish() 发出——立即发 finish 会用不完整的 usage 封顶，
        // 且工具轮次终止进程后 result（权威 usage）再也无法补入
        this.applyUsage(event.usage, false);
        // 发生文本泄漏回收时保持 tool_use 边界，不让 end_turn 覆盖
        if (event.delta?.stop_reason && !this.synthesizedToolCalls) this.pendingStopReason = event.delta.stop_reason;
        break;
      }

      case "message_stop":
        // 流结束标记——finish 统一由 result / flushFinish() 发出，此处不处理，
        // 避免在权威 usage（result）到达前用不完整数据发出 finish
        break;
    }

    return parts;
  }

  // （assistant 完整消息处理已移除：includePartialMessages 恒为 true 时，
  //   stream_event 与 assistant 完整消息内容重复，统一只走 stream_event 路径）

  // ─── result 消息处理 ─────────────────────────────────────────────────────
  private mapResult(msg: any): V3StreamPart[] {
    // 失败结果必须显式报错：qodercli 的失败 subtype 不止 "error"。
    // 实测（CN 账号配了 global 构建的 CLI）：
    //   {type:"result", subtype:"error_during_execution", is_error:true,
    //    errors:["The provided access token was rejected by the API"],
    //    terminal_reason:"access_token_invalid"}
    // 旧实现只认 subtype==="error" → 把失败当成功 → 上层收到空回复（内容为空、无报错）。
    const subtype: unknown = msg.subtype;
    const isError =
      msg.is_error === true ||
      subtype === "error" ||
      (typeof subtype === "string" && subtype.startsWith("error"));

    if (isError) {
      const raw = Array.isArray(msg.errors) ? msg.errors : [];
      const messages = raw
        .map((e: any) => (typeof e === "string" ? e : e?.message))
        .filter((s: unknown): s is string => typeof s === "string" && s.length > 0);
      const detail =
        messages.join("; ") ||
        (typeof msg.terminal_reason === "string" ? msg.terminal_reason : "") ||
        (typeof subtype === "string" ? subtype : "") ||
        "Unknown error";
      return [{ type: "error", error: new Error(detail) }];
    }
    // result/success — 权威 usage（final 替换流式累积值），stop_reason 一并更新，
    // 然后发出唯一的 finish（result 是工具轮次终止前最后的 usage 来源）
    this.applyUsage(msg.usage, true);
    this.applyModelUsage(msg.modelUsage);
    // total_credits 是会话累计；本 provider 每请求独立 CLI 会话
    // （persistSession: false），累计即本请求 credits，作为兜底回退
    if (this.credits === undefined) {
      const total = msg.total_credits;
      if (typeof total === "number" && Number.isFinite(total) && total > 0) this.credits = total;
    }
    // 泄漏回收的 tool_use 边界不被 result.stop_reason（end_turn）覆盖
    if (msg.stop_reason && !this.synthesizedToolCalls) this.pendingStopReason = msg.stop_reason;
    return this.flushFinish();
  }

  // ─── stop_reason 映射 ───────────────────────────────────────────────────
  private mapStopReason(reason: string | null | undefined): V3FinishReason {
    if (!reason) return { unified: "stop", raw: undefined };
    switch (reason) {
      case "end_turn":
      case "stop":
      case "stop_sequence":
        return { unified: "stop", raw: reason };
      case "max_tokens":
        return { unified: "length", raw: reason };
      case "tool_use":
        return { unified: "tool-calls", raw: reason };
      case "content_filter":
        return { unified: "content-filter", raw: reason };
      default:
        return { unified: "other", raw: reason };
    }
  }

  // ─── Usage 累积与发射 ────────────────────────────────────────────────────
  /**
   * 合并一帧 usage 数据。流式事件（message_start/message_delta）增量到达，
   * 取 max 防止缺字段的后续帧覆盖已有值；result 为权威终值，直接替换。
   *
   * 重要：qodercli 上报的 token 计数字段在 0 值时表示"未报告"（实测
   * input/output/cache 恒为 0，仅 context_usage_ratio 有效），因此 >0 才视为有效数据。
   */
  private applyUsage(usage: QoderUsage | undefined, final: boolean): void {
    if (!usage || typeof usage !== "object") return;
    const num = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const merge = (current: number | undefined, direct: number | undefined): number | undefined =>
      direct === undefined ? current : final ? direct : Math.max(current ?? 0, direct);

    this.usageInput = merge(this.usageInput, num(usage.input_tokens));
    this.usageOutput = merge(this.usageOutput, num(usage.output_tokens));
    this.usageCacheRead = merge(this.usageCacheRead, num(usage.cache_read_input_tokens));
    this.usageCacheWrite = merge(this.usageCacheWrite, num(usage.cache_creation_input_tokens));

    // 仅有 context_usage_ratio 时按上下文窗口估算输入规模（真实 input_tokens 到达后替换）
    const ratio = num(usage.context_usage_ratio);
    if (ratio !== undefined && this.contextWindow > 0) {
      const estimated = Math.min(this.contextWindow, Math.max(1, Math.round(ratio * this.contextWindow)));
      this.estimatedContext = merge(this.estimatedContext, estimated);
    }

    // credits 是请求级总量（多帧重复携带同值），取 max 合并防旧帧覆盖
    const credits = num(usage.credits);
    if (credits !== undefined) this.credits = merge(this.credits, credits);
  }

  /** result.modelUsage 聚合兜底：direct usage 缺失的字段按各模型条目求和 */
  private applyModelUsage(modelUsage: Record<string, QoderModelUsage> | undefined): void {
    if (!modelUsage || typeof modelUsage !== "object") return;
    const sum = (pick: (m: QoderModelUsage) => number | undefined): number | undefined => {
      let total: number | undefined;
      for (const m of Object.values(modelUsage)) {
        const v = pick(m);
        // 与 applyUsage 的 num 一致：0 表示"未报告"，不计入聚合，
        // 否则全 0 的 modelUsage（实测形状）会以 0 封顶、挡住估算回退
        if (typeof v === "number" && Number.isFinite(v) && v > 0) {
          total = (total ?? 0) + v;
        }
      }
      return total;
    };
    if (this.usageInput === undefined) this.usageInput = sum((m) => m.inputTokens);
    if (this.usageOutput === undefined) this.usageOutput = sum((m) => m.outputTokens);
    if (this.usageCacheRead === undefined) this.usageCacheRead = sum((m) => m.cacheReadInputTokens);
    if (this.usageCacheWrite === undefined) this.usageCacheWrite = sum((m) => m.cacheCreationInputTokens);
  }

  /** 当前累积 usage 的 V3 快照（无服务端数据时用本地估算兜底） */
  private currentUsage(): V3Usage {
    const input = this.usageInput ?? this.estimatedContext;
    // qodercli 不上报 output token：按生成字符数粗估（≈4 字符/token，
    // 英文较准、中文偏低估，仅供 UI 展示）
    const output = this.usageOutput ?? (this.outputChars > 0 ? Math.ceil(this.outputChars / 4) : undefined);
    return {
      inputTokens: { total: input, noCache: undefined, cacheRead: this.usageCacheRead, cacheWrite: this.usageCacheWrite },
      outputTokens: { total: output, text: output, reasoning: undefined },
    };
  }

  /**
   * 发出唯一的 finish（幂等）。
   * model.ts 在循环结束 / 工具边界终止进程前调用，确保 finish 携带
   * 此刻累积到的最完整 usage（result 权威值或流式增量）。
   * 发出前先收尾未关闭的文本块（flushPending）：模型进程提前终止时，
   * 暂扣/泄漏缓冲中的内容不丢失，回收出的工具调用也能计入 finishReason。
   */
  flushFinish(): V3StreamPart[] {
    if (this.emittedFinish) return [];
    const pending = this.flushPending();
    this.emittedFinish = true;
    const part: Extract<V3StreamPart, { type: "finish" }> = {
      type: "finish",
      finishReason: this.mapStopReason(this.pendingStopReason),
      usage: this.currentUsage(),
    };
    // credits 直通 opencode 的 cost：opencode getUsage 优先读
    // providerMetadata["copilot"]["totalNanoAiu"] 并除以 1e11 作为 cost，
    // credits × 1e11 使 $ spent 直接显示服务端真实计量（credits 数值，非 USD）
    if (this.credits !== undefined) {
      part.providerMetadata = { copilot: { totalNanoAiu: this.credits * 1e11 } };
    }
    return [...pending, part];
  }

  /** 是否已到达工具边界（暂存的 stop_reason=tool_use），供 model.ts 决定终止时机 */
  isToolBoundary(): boolean {
    return this.pendingStopReason === "tool_use";
  }

  // ─── 文本泄漏回收（tool_call XML，解析器见 toolcall-leak.ts） ─────────────
  /**
   * text 块 holdback 流式处理：
   *  - 常规文本即时发出（懒发 text-start）
   *  - 命中 `<tool_call>`：标记之前的文本照发，之后的 delta 收入 leakBuffer，
   *    等块结束（或流终止的兜底收尾）时解析成真正的 tool-call
   *  - 疑似标记前缀（≤10 字符）暂扣，避免把半截 `<tool_ca` 发进文本
   */
  private pushTextDelta(state: BlockState, text: string): V3StreamPart[] {
    if (!text) return [];
    if (state.inLeak) {
      state.leakBuffer = (state.leakBuffer || "") + text;
      return [];
    }
    const parts: V3StreamPart[] = [];
    const pending = (state.holdback || "") + text;
    const markerIdx = pending.indexOf(LEAK_MARKER);
    if (markerIdx >= 0) {
      parts.push(...this.emitText(state, pending.slice(0, markerIdx)));
      state.inLeak = true;
      state.leakBuffer = pending.slice(markerIdx + LEAK_MARKER.length);
      state.holdback = "";
      return parts;
    }
    // 暂扣疑似标记前缀（`<`、`<t`、…、`<tool_call`）
    let keep = 0;
    const maxKeep = Math.min(pending.length, LEAK_MARKER.length - 1);
    for (let p = maxKeep; p >= 1; p--) {
      if (pending.endsWith(LEAK_MARKER.slice(0, p))) {
        keep = p;
        break;
      }
    }
    if (keep > 0) {
      parts.push(...this.emitText(state, pending.slice(0, pending.length - keep)));
      state.holdback = pending.slice(pending.length - keep);
    } else {
      parts.push(...this.emitText(state, pending));
      state.holdback = "";
    }
    return parts;
  }

  /** 发出文本（懒发 text-start，保证纯泄漏块不产生空文本段） */
  private emitText(state: BlockState, text: string): V3StreamPart[] {
    if (!text) return [];
    const parts: V3StreamPart[] = [];
    if (!state.textStarted) {
      state.textStarted = true;
      parts.push({ type: "text-start", id: state.id });
    }
    parts.push({ type: "text-delta", id: state.id, delta: text });
    return parts;
  }

  /**
   * text 块结束：处于泄漏捕获态则尝试解析。
   *  - 解析成功：残余文本 + 真正的 tool-call（并置 tool_use 边界，finish=tool-calls）
   *  - 解析失败：原始文本原样吐出（绝不丢内容）
   */
  private finalizeTextBlock(state: BlockState): V3StreamPart[] {
    const parts: V3StreamPart[] = [];
    if (!state.inLeak) {
      if (state.holdback) {
        parts.push(...this.emitText(state, state.holdback));
        state.holdback = "";
      }
      if (state.textStarted) parts.push({ type: "text-end", id: state.id });
      return parts;
    }

    const raw = LEAK_MARKER + (state.leakBuffer || "");
    const parsed = parseLeakedToolCalls(raw);
    if (parsed.callCount === 0) {
      parts.push(...this.emitText(state, raw));
      if (state.textStarted) parts.push({ type: "text-end", id: state.id });
      logInfo("mapper: <tool_call> text detected but not parseable; kept as text");
      return parts;
    }

    for (const item of parsed.items) {
      if (item.kind === "text") {
        if (item.text.trim()) parts.push(...this.emitText(state, item.text));
      } else {
        parts.push(...this.emitToolCallParts(state, item.call));
      }
    }
    if (state.textStarted) parts.push({ type: "text-end", id: state.id });
    this.synthesizedToolCalls = true;
    this.pendingStopReason = "tool_use";
    const names = parsed.items.flatMap((i) => (i.kind === "call" ? [i.call.rawName] : []));
    logInfo(`mapper: recovered ${parsed.callCount} leaked tool call(s) from text: ${names.join(", ")}`);
    return parts;
  }

  /** 泄漏工具调用 → tool-input-start/delta/end + tool-call 事件（名称做归一化） */
  private emitToolCallParts(state: BlockState, call: LeakedToolCall): V3StreamPart[] {
    const toolName = this.resolveLeakedName(call.rawName);
    const input = JSON.stringify(call.input);
    const id = `${state.id}_leak${++this.leakSeq}`;
    return [
      { type: "tool-input-start", id, toolName, providerExecuted: false },
      { type: "tool-input-delta", id, delta: input },
      { type: "tool-input-end", id },
      { type: "tool-call", toolCallId: id, toolName, input, providerExecuted: false },
    ];
  }

  /**
   * 泄漏名 → opencode 工具名：
   * 映射表命中 → `tools.` 前缀剥离后映射 → 与 opencode 工具名做大小写不敏感匹配
   * → 兜底占位名（opencode 返回 tool not found，模型可自行纠正）
   */
  private resolveLeakedName(raw: string): string {
    const clean = raw.trim();
    const candidates = [clean];
    const stripped = clean.replace(/^tools\./i, "");
    if (stripped !== clean) candidates.push(stripped);
    for (const c of candidates) {
      const mapped = this.toOpencodeName?.(c);
      if (mapped) return mapped;
    }
    if (this.knownToolNames) {
      for (const c of candidates) {
        const lower = c.toLowerCase();
        const hit = this.knownToolNames.find((n) => n.toLowerCase() === lower);
        if (hit) return hit;
      }
    }
    return this.mapToolName(stripped || clean);
  }

  /**
   * 收尾未关闭的文本块（模型进程提前终止 / 流结束而不发 content_block_stop 时），
   * 防止暂扣文本与泄漏缓冲丢失，并让泄漏回收在 flushFinish 路径同样生效。
   */
  private flushPending(): V3StreamPart[] {
    if (this.blocks.size === 0) return [];
    const parts: V3StreamPart[] = [];
    for (const [, state] of this.blocks) {
      if (state.type === "text") parts.push(...this.finalizeTextBlock(state));
    }
    this.blocks.clear();
    return parts;
  }
}
