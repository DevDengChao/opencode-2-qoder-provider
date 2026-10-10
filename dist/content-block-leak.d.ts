/**
 * content-block-leak.ts — 工具调用"内容块 JSON"文本泄漏回收
 *
 * 背景：除 `<tool_call>` XML 形（见 toolcall-leak.ts）之外，模型还会把整轮
 * 回复以内容块 JSON 的形态写进 text 块——与桥 replay 转录的记号同构：
 *
 *   [{"type":"text","text":"…"},
 *    {"type":"tool_use","id":"call_…","name":"read","pi_tool_name":"read","input":{…}},
 *    {"type":"tool_use","id":"call_…","name":"grep","input":{…}}]
 *
 * 此时 stop_reason=end_turn，opencode 把整轮当作普通文本结束——任务无声中断
 * （真实语料：本机 2026-10-10 会话库，修复 app/home/active 两轮均为
 * text+tool_use 混合数组；亦出现纯调用数组）。
 *
 * 与 XML 形不同，JSON 形没有短小的流式标记（以 `[`/`{` 开头），因此 mapper
 * 采用"块首探测 + 整块缓冲"：text 块开头约 30 字符内用
 * classifyContentBlockJsonStart 判定；疑似则整块缓冲到块结束再解析。
 *
 * 安全取向与 toolcall-leak.ts 一致——"仅转换可完整校验的内容；绝不丢内容"：
 *  - 只接受"整块（trim 后）即一个 JSON"的形态（真实泄漏均以整个 text 块承载）；
 *  - 数组元素必须全部是可识别内容块（text/tool_use），且至少 1 个 tool_use；
 *  - tool_use 必须带非空 name（或 pi_tool_name），input 为对象或可解析为对象的
 *    JSON 字符串；
 *  - 其余情况整段原样保留为文本，绝不执行无法完整校验的调用。
 *
 * 已知不支持（语料未出现，保持保守）：`{"role":…,"content":[…]}` 包裹形态、
 * 前后夹杂散文的数组。
 */
import type { LeakParseResult } from "./toolcall-leak.js";
/** 块首探测的最大缓冲长度（真实 JSON 开头约 30 字符内必然收敛） */
export declare const CONTENT_BLOCK_PROBE_MAX = 128;
export type ContentBlockStartVerdict = "keep" | "commit" | "reject";
/**
 * 对 text 块开头做轻量探测（纯函数，可增量调用）：
 *  - "keep"   —— 仍可能是内容块 JSON 开头，继续缓冲
 *  - "commit" —— 判定为候选，转入整块缓冲
 *  - "reject" —— 排除，按普通文本（含 XML 泄漏检测）流程继续
 * 判定在约 30 字符内收敛；缓冲超过 CONTENT_BLOCK_PROBE_MAX 由调用方按 reject 处理。
 */
export declare function classifyContentBlockJsonStart(buffer: string): ContentBlockStartVerdict;
/**
 * 解析整块内容块 JSON（trim 后须为单个 JSON 值）。
 * 成功：items 按数组原顺序展开（text 项 + call 项），callCount ≥ 1。
 * 失败：items = [整段原文]，callCount = 0（调用方原样吐出，绝不丢内容）。
 */
export declare function parseLeakedContentBlocks(text: string): LeakParseResult;
