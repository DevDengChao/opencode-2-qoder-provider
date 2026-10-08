/** JSON 兼容值（结构与 AI SDK 内部 JSONValue 一致，保证可赋给 SharedV3ProviderMetadata） */
type JSONValue = null | string | number | boolean | {
    [key: string]: JSONValue | undefined;
} | JSONValue[];
export type V3ProviderMetadata = Record<string, {
    [key: string]: JSONValue | undefined;
}>;
export type V3StreamPart = {
    type: "stream-start";
    warnings: Array<{
        type: string;
        message: string;
    }>;
} | {
    type: "text-start";
    id: string;
} | {
    type: "text-delta";
    id: string;
    delta: string;
} | {
    type: "text-end";
    id: string;
} | {
    type: "reasoning-start";
    id: string;
} | {
    type: "reasoning-delta";
    id: string;
    delta: string;
} | {
    type: "reasoning-end";
    id: string;
} | {
    type: "tool-input-start";
    id: string;
    toolName: string;
    providerExecuted?: boolean;
} | {
    type: "tool-input-delta";
    id: string;
    delta: string;
} | {
    type: "tool-input-end";
    id: string;
} | {
    type: "tool-call";
    toolCallId: string;
    toolName: string;
    input: string;
    providerExecuted?: boolean;
} | {
    type: "finish";
    finishReason: V3FinishReason;
    usage: V3Usage;
    providerMetadata?: V3ProviderMetadata;
} | {
    type: "error";
    error: unknown;
} | {
    type: "raw";
    rawValue: unknown;
};
export interface V3FinishReason {
    unified: "stop" | "length" | "content-filter" | "tool-calls" | "error" | "other";
    raw: string | undefined;
}
export interface V3Usage {
    inputTokens: {
        total: number | undefined;
        noCache: number | undefined;
        cacheRead: number | undefined;
        cacheWrite: number | undefined;
    };
    outputTokens: {
        total: number | undefined;
        text: number | undefined;
        reasoning: number | undefined;
    };
}
export declare class StreamMapper {
    /** index → block 状态（per-query） */
    private blocks;
    private messageId;
    private modelId;
    private emittedFinish;
    /** qodercli 侧工具名 → opencode 原名（声明型 MCP 桥接） */
    private toOpencodeName?;
    /** 模型上下文窗口（用于 context_usage_ratio 估算输入 token） */
    private contextWindow;
    /** opencode 工具名清单（文本泄漏回收时的名称归一化参考） */
    private knownToolNames?;
    /** 本消息是否从文本中回收过工具调用（finish 判定为 tool-calls） */
    private synthesizedToolCalls;
    /** 泄漏回收 tool-call id 的序号（保证同一消息内 id 唯一） */
    private leakSeq;
    private usageInput?;
    private usageOutput?;
    private usageCacheRead?;
    private usageCacheWrite?;
    /** 仅有 context_usage_ratio 时的输入估算值（真实 input_tokens 到达后被替换） */
    private estimatedContext?;
    /** 生成字符数累计（qodercli 不上报 output token，用字符数粗略估算） */
    private outputChars;
    /** 服务端请求级真实计量（Qoder credits；0/缺失视为未报告） */
    private credits?;
    private pendingStopReason?;
    constructor(toOpencodeName?: (providerName: string) => string | undefined, contextWindow?: number, knownToolNames?: string[]);
    /** 工具名映射：未知名转换为安全的占位名，由 opencode 返回 tool not found */
    private mapToolName;
    /** 重置状态（新消息开始时） */
    reset(): void;
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
    map(msg: any): V3StreamPart[];
    private mapStreamEvent;
    private mapResult;
    private mapStopReason;
    /**
     * 合并一帧 usage 数据。流式事件（message_start/message_delta）增量到达，
     * 取 max 防止缺字段的后续帧覆盖已有值；result 为权威终值，直接替换。
     *
     * 重要：qodercli 上报的 token 计数字段在 0 值时表示"未报告"（实测
     * input/output/cache 恒为 0，仅 context_usage_ratio 有效），因此 >0 才视为有效数据。
     */
    private applyUsage;
    /** result.modelUsage 聚合兜底：direct usage 缺失的字段按各模型条目求和 */
    private applyModelUsage;
    /** 当前累积 usage 的 V3 快照（无服务端数据时用本地估算兜底） */
    private currentUsage;
    /**
     * 发出唯一的 finish（幂等）。
     * model.ts 在循环结束 / 工具边界终止进程前调用，确保 finish 携带
     * 此刻累积到的最完整 usage（result 权威值或流式增量）。
     * 发出前先收尾未关闭的文本块（flushPending）：模型进程提前终止时，
     * 暂扣/泄漏缓冲中的内容不丢失，回收出的工具调用也能计入 finishReason。
     */
    flushFinish(): V3StreamPart[];
    /** 是否已到达工具边界（暂存的 stop_reason=tool_use），供 model.ts 决定终止时机 */
    isToolBoundary(): boolean;
    /**
     * text 块 holdback 流式处理：
     *  - 常规文本即时发出（懒发 text-start）
     *  - 命中 `<tool_call>`：标记之前的文本照发，之后的 delta 收入 leakBuffer，
     *    等块结束（或流终止的兜底收尾）时解析成真正的 tool-call
     *  - 疑似标记前缀（≤10 字符）暂扣，避免把半截 `<tool_ca` 发进文本
     */
    private pushTextDelta;
    /** 发出文本（懒发 text-start，保证纯泄漏块不产生空文本段） */
    private emitText;
    /**
     * text 块结束：处于泄漏捕获态则尝试解析。
     *  - 解析成功：残余文本 + 真正的 tool-call（并置 tool_use 边界，finish=tool-calls）
     *  - 解析失败：原始文本原样吐出（绝不丢内容）
     */
    private finalizeTextBlock;
    /** 泄漏工具调用 → tool-input-start/delta/end + tool-call 事件（名称做归一化） */
    private emitToolCallParts;
    /**
     * 泄漏名 → opencode 工具名：
     * 映射表命中 → `tools.` 前缀剥离后映射 → 与 opencode 工具名做大小写不敏感匹配
     * → 兜底占位名（opencode 返回 tool not found，模型可自行纠正）
     */
    private resolveLeakedName;
    /**
     * 收尾未关闭的文本块（模型进程提前终止 / 流结束而不发 content_block_stop 时），
     * 防止暂扣文本与泄漏缓冲丢失，并让泄漏回收在 flushFinish 路径同样生效。
     */
    private flushPending;
}
export {};
