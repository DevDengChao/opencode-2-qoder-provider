/**
 * model.ts — LanguageModelV3 实现
 *
 * 参考 pi-qoder-provider 的架构：把 qodercli 当作无状态的语言模型后端，
 * 而不是 agent：
 *  - opencode 工具通过声明型 MCP 桥接给 qodercli（tool-bridge.ts）：
 *    模型能"看到"工具并发出 tool_use，但 qodercli 侧永不执行，
 *    tool_use 流事件转成 AI SDK tool-call 交回 opencode 执行
 *  - 多轮历史用 JSON transcript 回放（context.ts）
 *  - 每次请求：tools:[]（原生全禁）、maxTurns:1、persistSession:false
 *  - 收到权威工具边界（stop_reason=tool_use）后立即终止子进程，
 *    防止 canUseTool 的 deny 结果触发 qodercli 第二轮模型调用
 */
import {
  query,
  accessToken,
  ProcessTransport,
} from "@qoder-ai/qoder-agent-sdk";
import type { SDKUserMessage } from "@qoder-ai/qoder-agent-sdk";
import { log, logInfo, logError } from "./logger.js";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamResult,
  LanguageModelV3Content,
  LanguageModelV3StreamPart,
} from "@ai-sdk/provider";
import { StreamMapper, type V3FinishReason, type V3Usage, type V3ProviderMetadata } from "./mapper.js";
import { findModel, type QoderModelDef, type QoderRegion } from "./models.js";
import { resolveQoderCliPath } from "./cli-path.js";
import { buildQoderToolBridge, OPENCODE_MCP_SERVER_KEY, type QoderToolBridge } from "./tool-bridge.js";
import { buildQoderPrompt, withTransportNotice, type BuiltPrompt } from "./context.js";

// ─── Provider Options ───────────────────────────────────────────────────────
export interface QoderProviderOptions {
  /** Qoder PAT (Personal Access Token) */
  apiKey?: string;
  /** Region: "global" | "cn" */
  region?: string;
  /** 工作目录 */
  cwd?: string;
}

/**
 * 单消息短流：yield 一条携带 content blocks（图片+文本）的 user 消息后立即结束。
 * SDK 内部对 string prompt 的处理就是包装成同样的单消息流（streamInput 消费完
 * 即关闭 stdin，CLI 处理完该消息后返回 result，实测 qodercli 1.1.31 行为一致），
 * 因此短流与 string prompt 生命周期相同，无需挂起等待，无泄漏。
 */
function oneShotUserMessage(
  contentBlocks: SDKUserMessage["message"]["content"],
): AsyncIterable<SDKUserMessage> {
  return (async function* () {
    yield {
      type: "user",
      message: { role: "user", content: contentBlocks },
      parent_tool_use_id: null,
    };
  })();
}

// ─── Abort 联动与请求超时 ───────────────────────────────────────────────────
/**
 * 请求超时上限（与 pi-qoder-provider 的 DEFAULT_TIMEOUT_MS 对齐）。
 * CLI 挂死（存活但不输出）且宿主未取消时，SDK 的 for-await 会永久 pending，
 * 超时 abort 是最后一道兜底。
 */
export const REQUEST_TIMEOUT_MS = 10 * 60_000;

export interface LinkedAbort {
  controller: AbortController;
  /** 移除转发监听；query 结束后调用，避免 timeout signal 上的监听残留 */
  cleanup(): void;
}

/**
 * 创建内部 AbortController，把「宿主取消信号」与「请求超时」统一转发给 SDK。
 *
 * SDK 的 query options 只接受 abortController（AbortController 实例，
 * abort() 时 SDK close 并三阶段终止子进程）；AI SDK 传入的是 abortSignal，
 * 此前以 abortSignal 键透传会被 SDK 静默忽略，abort 时只剩
 * ReadableStream.cancel() 单保险（doGenerate 路径完全没有兜底）。
 */
export function createLinkedAbortController(
  hostSignal?: AbortSignal,
  timeoutMs = REQUEST_TIMEOUT_MS,
): LinkedAbort {
  const controller = new AbortController();
  const signals: AbortSignal[] = [];
  if (hostSignal) signals.push(hostSignal);
  if (timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs));

  const cleanups: Array<() => void> = [];
  for (const signal of signals) {
    if (signal.aborted) {
      controller.abort(signal.reason);
      break;
    }
    const listener = () => controller.abort(signal.reason);
    signal.addEventListener("abort", listener, { once: true });
    cleanups.push(() => signal.removeEventListener("abort", listener));
  }

  return {
    controller,
    cleanup() {
      for (const fn of cleanups) fn();
    },
  };
}

/** SDK 层错误转换：超时（非宿主 abort）给明确消息；其余原样透传 */
function describeQueryError(
  error: unknown,
  abort: LinkedAbort | undefined,
  hostSignal: AbortSignal | undefined,
): Error {
  const timedOut = !!abort?.controller.signal.aborted && !hostSignal?.aborted;
  if (timedOut) {
    return new Error(`Qoder request timed out after ${Math.round(REQUEST_TIMEOUT_MS / 60_000)} minutes`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

// ─── QoderLanguageModel ─────────────────────────────────────────────────────
export class QoderLanguageModel implements LanguageModelV3 {
  readonly specificationVersion = "v3" as const;
  readonly provider = "qoder";
  readonly modelId: string;
  readonly supportedUrls: Record<string, RegExp[]> = {};

  private region: QoderRegion;
  private pat: string;
  private cwd?: string;
  private modelDef?: QoderModelDef;
  private qoderCliPath: string;

  constructor(modelId: string, options: QoderProviderOptions) {
    this.modelId = modelId;
    this.region = (options.region === "cn" ? "cn" : "global") as QoderRegion;
    // CN 区优先读 QODERCN_PERSONAL_ACCESS_TOKEN（与 README / ensurePat 错误消息一致），
    // 否则回退到全局 QODER_PERSONAL_ACCESS_TOKEN
    this.pat = options.apiKey
      || (this.region === "cn" ? process.env.QODERCN_PERSONAL_ACCESS_TOKEN : undefined)
      || process.env.QODER_PERSONAL_ACCESS_TOKEN
      || process.env.QODER_PAT
      || "";
    this.cwd = options.cwd;

    // 查找模型定义
    this.modelDef = findModel(modelId, this.region);

    // 解析对应区域的 CLI 路径（用于 ProcessTransport，绕过 Bun 下 WorkerTransport 的兼容性问题）
    // CN 账号必须用 CN 版 CLI，否则 PAT 会被 exchange 到全球 openapi 并报 access_token_invalid
    this.qoderCliPath = resolveQoderCliPath(this.region);
    logInfo(`QoderLanguageModel created: model=${modelId}, cliPath=${this.qoderCliPath}`);
  }

  /** 确保 PAT 可用（延迟检查，避免初始化时抛异常） */
  private ensurePat(): void {
    if (!this.pat) {
      throw new Error(
        this.region === "cn"
          ? "Qoder CN: Set QODERCN_PERSONAL_ACCESS_TOKEN or QODER_PERSONAL_ACCESS_TOKEN."
          : "Qoder: Set QODER_PERSONAL_ACCESS_TOKEN.",
      );
    }
  }

  /**
   * 为一次调用准备 bridge / prompt / mapper / query。
   * doGenerate 与 doStream 共用，保证两条路径行为一致。
   */
  private prepare(options: LanguageModelV3CallOptions) {
    this.ensurePat();

    // 0. Abort 联动：宿主取消 + 请求超时 → SDK abortController（见 createLinkedAbortController）
    const abort = createLinkedAbortController(options.abortSignal, REQUEST_TIMEOUT_MS);

    // 1. 声明型 MCP 工具桥接：把 opencode 工具 schema 暴露给 qodercli（不执行）
    const bridge = buildQoderToolBridge(options.tools as any);

    // 2. Prompt 构建：多轮历史 → JSON transcript 回放
    const built = buildQoderPrompt(options.prompt, (name) => bridge?.toProviderName(name));

    // 3. 系统提示词 = opencode 提示词 + transport notice
    const systemPrompt = withTransportNotice(built.systemPrompt, bridge !== undefined);

    const q = query({
      // 含图片时走单消息短流：image block 经 wire 协议透传给模型；
      // 纯文本保持 string prompt 通道（零回归）
      prompt: built.contentBlocks
        ? oneShotUserMessage(built.contentBlocks)
        : built.userText,
      options: {
        auth: accessToken(this.pat),
        model: this.modelDef?.sdkModelId || this.modelId,
        cwd: this.cwd,
        transport: new ProcessTransport({ pathToQoderCLIExecutable: this.qoderCliPath, stderr: "ignore" }),
        // qodercli 原生工具/技能/插件/用户设置全禁
        tools: [],
        skills: [],
        plugins: [],
        settingSources: [],
        // 无状态单轮：不持久化 qodercli 会话（opencode 每轮重发完整历史）
        persistSession: false,
        maxTurns: 1,
        // 用 opencode 的系统提示词（+ transport notice）替换 qodercli 默认的
        systemPrompt,
        includePartialMessages: true,
        // opencode 工具经声明型 MCP 桥接；canUseTool 永远 deny，执行权在 opencode
        ...(bridge ? {
          mcpServers: { [OPENCODE_MCP_SERVER_KEY]: bridge.server },
          allowedMcpServerNames: [OPENCODE_MCP_SERVER_KEY],
          strictMcpConfig: true,
          canUseTool: bridge.canUseTool,
          permissionMode: "default" as const,
        } : { permissionMode: "acceptEdits" as const }),
        // SDK 只认 abortController；宿主 abort 或超时触发时 SDK close
        // query 并三阶段终止子进程（此前 abortSignal 键会被 SDK 静默忽略）
        abortController: abort.controller,
      },
    });

    // 4. mapper：qodercli 侧工具名 → opencode 原名；传入 contextWindow 供
    //    usage 的 context_usage_ratio 估算输入 token
    const mapper = new StreamMapper((providerName) => bridge?.toOpencodeName(providerName), this.modelDef?.contextWindow);

    return { q, mapper, built, bridge, abort };
  }

  // ── doGenerate (非流式) ──────────────────────────────────────────────────
  async doGenerate(options: LanguageModelV3CallOptions): Promise<LanguageModelV3GenerateResult> {
    const { q, mapper, built, bridge, abort } = this.prepare(options);
    logInfo(`doGenerate called: model=${this.modelId}, history=${built.hasHistory}, tools=${bridge?.toolCount ?? 0}`);

    const content: LanguageModelV3Content[] = [];
    let finishReason: V3FinishReason = { unified: "stop", raw: undefined };
    let usage: V3Usage = {
      inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
    let providerMetadata: V3ProviderMetadata | undefined;

    let textBuffer = "";
    let reasoningBuffer = "";
    let toolBoundary = false;

    try {
      for await (const msg of q) {
        const parts = mapper.map(msg);
        for (const part of parts) {
          switch (part.type) {
            case "text-delta":
              textBuffer += part.delta;
              break;
            case "reasoning-delta":
              reasoningBuffer += part.delta;
              break;
            case "tool-call":
              content.push({
                type: "tool-call",
                toolCallId: part.toolCallId,
                toolName: part.toolName,
                input: part.input,
                providerExecuted: part.providerExecuted,
              });
              break;
            case "finish":
              finishReason = part.finishReason;
              usage = part.usage;
              providerMetadata = part.providerMetadata;
              break;
            case "error":
              throw part.error instanceof Error ? part.error : new Error(String(part.error));
          }
        }
        // 权威工具边界：立即终止，防止 deny 触发 qodercli 第二轮模型调用
        if (mapper.isToolBoundary()) {
          toolBoundary = true;
          break;
        }
      }
      // 补发 finish（幂等）：result 已发过时为空；工具边界终止时 result 不会
      // 到达，用累积 usage 发出——保证 usage 不因提前终止而丢失
      for (const part of mapper.flushFinish()) {
        if (part.type === "finish") {
          finishReason = part.finishReason;
          usage = part.usage;
          providerMetadata = part.providerMetadata;
        }
      }
    } catch (error) {
      throw describeQueryError(error, abort, options.abortSignal);
    } finally {
      abort.cleanup();
      await q.close().catch(() => {});
    }
    logInfo(`doGenerate completed: finish=${finishReason.unified}, toolBoundary=${toolBoundary}`);

    // 构建 content 数组：reasoning → text → tool-calls
    if (reasoningBuffer) {
      content.unshift({ type: "reasoning", text: reasoningBuffer });
    }
    if (textBuffer) {
      // text 放在 reasoning 之后、tool-calls 之前
      const insertIdx = reasoningBuffer ? 1 : 0;
      content.splice(insertIdx, 0, { type: "text", text: textBuffer });
    }

    return {
      content,
      finishReason,
      usage,
      providerMetadata,
      warnings: [],
    };
  }

  // ── doStream ─────────────────────────────────────────────────────────────
  async doStream(options: LanguageModelV3CallOptions): Promise<LanguageModelV3StreamResult> {
    const self = this;
    // q / abort 提升到闭包外层：cancel() 时可主动终止 qodercli 子进程，
    // 避免 start() 卡在迭代/背压上导致 finally 永不执行、进程残留
    let q: ReturnType<typeof query> | undefined;
    let abort: ReturnType<typeof createLinkedAbortController> | undefined;

    const stream = new ReadableStream<LanguageModelV3StreamPart>({
      async start(controller) {
        // 流被取消（TUI 中断）后 controller.enqueue/close 会抛 TypeError，
        // 统一包装为安全调用，避免取消路径上的 unhandled rejection
        const safeEnqueue = (part: LanguageModelV3StreamPart): void => {
          try { controller.enqueue(part); } catch { /* stream cancelled */ }
        };
        const safeClose = (): void => {
          try { controller.close(); } catch { /* stream cancelled */ }
        };
        try {
          const prepared = self.prepare(options);
          q = prepared.q;
          abort = prepared.abort;
          const { mapper, built, bridge } = prepared;
          logInfo(`doStream: starting query() for model=${self.modelDef?.sdkModelId || self.modelId}, history=${built.hasHistory}, tools=${bridge?.toolCount ?? 0}`);
          log(`doStream: prompt=${JSON.stringify(built.userText).slice(0, 300)}`);

          let msgCount = 0;
          let partCount = 0;
          for await (const msg of q) {
            msgCount++;
            const parts = mapper.map(msg);
            if (parts.length > 0) {
              log(`doStream: msg#${msgCount} type=${(msg as any)?.type || 'unknown'} → ${parts.map(p => p.type).join(',')}`);
            }
            for (const part of parts) {
              partCount++;
              safeEnqueue(part as LanguageModelV3StreamPart);
            }
            // 权威工具边界：立即终止，防止 deny 触发 qodercli 第二轮模型调用
            if (mapper.isToolBoundary()) {
              logInfo(`doStream: tool boundary reached, terminating qodercli (msgs=${msgCount})`);
              break;
            }
          }
          // 补发 finish（幂等）：result 已发过时为空；工具边界/提前终止时
          // 携带累积 usage 发出——保证 opencode 每轮都能拿到 token 统计
          for (const part of mapper.flushFinish()) {
            partCount++;
            safeEnqueue(part as LanguageModelV3StreamPart);
          }
          logInfo(`doStream: query completed for model=${self.modelId}, msgs=${msgCount}, parts=${partCount}`);
          safeClose();
        } catch (error) {
          const timedOut = abort?.controller.signal.aborted && !options.abortSignal?.aborted;
          const described = describeQueryError(error, abort, options.abortSignal);
          logError(`doStream: query error for model=${self.modelId}:`, described.message);
          safeEnqueue({
            type: "error",
            error: described,
          } as LanguageModelV3StreamPart);
          safeClose();
        } finally {
          abort?.cleanup();
          if (q) await q.close().catch(() => {});
        }
      },

      async cancel() {
        // TUI 中断（ESC）：abortSignal 之外的双保险，主动终止 qodercli 子进程
        abort?.cleanup();
        if (q) await q.close().catch(() => {});
      },
    });

    return { stream };
  }
}
