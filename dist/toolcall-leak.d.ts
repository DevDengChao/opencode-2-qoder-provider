/**
 * toolcall-leak.ts — `<tool_call>` XML 文本泄漏回收
 *
 * 背景：qodercli（qfmodel）偶发把工具调用以纯文本 XML 形式写进 message text，
 * 而不是发出原生 tool_use 流事件，例如：
 *
 *   <tool_call>
 *   <function=shell>
 *   <parameter=command>
 *   git status
 *   </parameter>
 *   </function>
 *   </tool_call>
 *
 * 此时 stop_reason 是 end_turn，opencode 会把整轮当作普通文本回复结束——
 * 任务无声中断（真实故障：会话在实现中途停住）。本模块负责把这类文本
 * 解析回结构化调用，由 mapper.ts 在流内转成真正的 tool-call 事件。
 *
 * 真实语料支持（来自本机 2026-10 会话库）：
 *  - `<function=NAME>` / `<function NAME>`；`<parameter=KEY>VALUE</parameter>`
 *  - 单个 text 块内多个 `<tool_call>` 块（块间文本保留）
 *  - `<function=tools.X>` codemode 风格名（保留原文，由 mapper 归一化）
 *  - 裸 JSON 体（缺失 `<parameter=…>` 开标签的畸形块）
 *  - `<function=execute><parameter=command>`（意图为执行 shell 命令）
 *  - 末尾缺失 `</tool_call>` 但存在 `</function>`（视作完整块）
 *  - execute 代码内陈旧 codemode 工具名 → 当前名（tools.shell）
 *
 * 安全取向：仅转换“参数已闭合”的完整块；截断/畸形内容一律原样保留为
 * 文本（绝不执行半截命令）。绝不丢内容。
 */
export declare const LEAK_MARKER = "<tool_call>";
export declare const LEAK_MARKER_END = "</tool_call>";
export interface LeakedToolCall {
    /** 原始函数名（未做 opencode 名映射，mapper 负责解析） */
    rawName: string;
    input: Record<string, unknown>;
}
export type LeakParseItem = {
    kind: "text";
    text: string;
} | {
    kind: "call";
    call: LeakedToolCall;
};
export interface LeakParseResult {
    items: LeakParseItem[];
    callCount: number;
}
/** execute 代码内陈旧 codemode 工具名 → 当前名（V2 为 tools.shell） */
export declare function normalizeExecuteCode(code: string): string;
/**
 * 从一段文本中解析所有 `<tool_call>` 块。
 * 非调用内容（块间文本、无法解析的块）按原顺序保留为 text item。
 */
export declare function parseLeakedToolCalls(text: string): LeakParseResult;
