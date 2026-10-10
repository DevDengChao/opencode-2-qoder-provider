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
import type { LeakParseItem, LeakParseResult, LeakedToolCall } from "./toolcall-leak.js";

/** 数组场景可接受的元素首键（仅用于快速判定候选；最终解析仍做严格校验） */
const ARRAY_FIRST_KEYS = new Set(["type", "id", "name", "input", "text", "pi_tool_name"]);
/** 块首探测的最大缓冲长度（真实 JSON 开头约 30 字符内必然收敛） */
export const CONTENT_BLOCK_PROBE_MAX = 128;
/** 块首最多容忍的前导空白字符数 */
const MAX_LEADING_WS = 16;
/** JSON 键名最大长度（超过判非法，防畸形输入无限缓冲） */
const MAX_KEY_LEN = 24;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

type KeyRead = { closed: boolean; text: string } | null;

/** 自开引号之后读 JSON 键名；null = 非法字符或超长（此后不可能再是合法延展） */
function readKey(s: string): KeyRead {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    const ok =
      (c >= 97 && c <= 122) || // a-z
      (c >= 65 && c <= 90) || // A-Z
      (c >= 48 && c <= 57) || // 0-9
      c === 95; // _
    if (c === 34 /* " */) return { closed: true, text: s.slice(0, i) };
    if (!ok) return null;
    i++;
    if (i > MAX_KEY_LEN) return null;
  }
  return { closed: false, text: s };
}

export type ContentBlockStartVerdict = "keep" | "commit" | "reject";

/**
 * 对 text 块开头做轻量探测（纯函数，可增量调用）：
 *  - "keep"   —— 仍可能是内容块 JSON 开头，继续缓冲
 *  - "commit" —— 判定为候选，转入整块缓冲
 *  - "reject" —— 排除，按普通文本（含 XML 泄漏检测）流程继续
 * 判定在约 30 字符内收敛；缓冲超过 CONTENT_BLOCK_PROBE_MAX 由调用方按 reject 处理。
 */
export function classifyContentBlockJsonStart(buffer: string): ContentBlockStartVerdict {
  const t = buffer.replace(/^\s+/, "");
  if (t.length === 0) return buffer.length > MAX_LEADING_WS ? "reject" : "keep";

  if (t[0] === "[") {
    const rest = t.slice(1).replace(/^\s+/, "");
    if (rest.length === 0) return "keep";
    if (rest[0] !== "{") return "reject";
    const rest2 = rest.slice(1).replace(/^\s+/, "");
    if (rest2.length === 0) return "keep";
    if (rest2[0] !== "\"") return "reject";
    const key = readKey(rest2.slice(1));
    if (!key) return "reject";
    if (!key.closed) return "keep";
    return ARRAY_FIRST_KEYS.has(key.text) ? "commit" : "reject";
  }

  if (t[0] === "{") {
    const rest = t.slice(1).replace(/^\s+/, "");
    if (rest.length === 0) return "keep";
    if (rest[0] !== "\"") return "reject";
    const key = readKey(rest.slice(1));
    if (!key) return "reject";
    if (!key.closed) return "keep";
    if (key.text !== "type") return "reject";
    const afterKey = rest.slice(1 + key.text.length + 1).replace(/^\s+/, "");
    if (afterKey.length === 0) return "keep";
    if (afterKey[0] !== ":") return "reject";
    const v = afterKey.slice(1).replace(/^\s+/, "");
    if (v.length === 0) return "keep";
    if (v[0] !== "\"") return "reject";
    const target = "\"tool_use\"";
    const prefix = v.slice(0, Math.min(v.length, target.length));
    if (!target.startsWith(prefix)) return "reject";
    return v.length >= target.length ? "commit" : "keep";
  }

  return "reject";
}

/**
 * 解析整块内容块 JSON（trim 后须为单个 JSON 值）。
 * 成功：items 按数组原顺序展开（text 项 + call 项），callCount ≥ 1。
 * 失败：items = [整段原文]，callCount = 0（调用方原样吐出，绝不丢内容）。
 */
export function parseLeakedContentBlocks(text: string): LeakParseResult {
  const fail = (): LeakParseResult => ({ items: [{ kind: "text", text }], callCount: 0 });

  const t = text.trim();
  if (!t || (t[0] !== "[" && t[0] !== "{")) return fail();

  let value: unknown;
  try {
    value = JSON.parse(t);
  } catch {
    return fail();
  }

  let elements: unknown[];
  if (Array.isArray(value)) {
    elements = value;
  } else if (isObject(value)) {
    // 单对象仅接受 {"type":"tool_use",…}（下方按 type 严格校验，其余形态整体放弃）
    elements = [value];
  } else {
    return fail();
  }

  const items: LeakParseItem[] = [];
  let callCount = 0;
  for (const el of elements) {
    if (!isObject(el)) return fail();
    if (el.type === "text") {
      if (typeof el.text !== "string") return fail();
      items.push({ kind: "text", text: el.text });
      continue;
    }
    if (el.type === "tool_use") {
      const name =
        typeof el.name === "string" && el.name.trim()
          ? el.name.trim()
          : typeof el.pi_tool_name === "string" && el.pi_tool_name.trim()
            ? el.pi_tool_name.trim()
            : "";
      if (!name) return fail();
      const rawInput = el.input !== undefined ? el.input : el.arguments;
      let input: Record<string, unknown>;
      if (rawInput === undefined || rawInput === null) {
        input = {};
      } else if (isObject(rawInput)) {
        input = rawInput;
      } else if (typeof rawInput === "string") {
        let parsed: unknown;
        try {
          parsed = JSON.parse(rawInput);
        } catch {
          return fail();
        }
        if (!isObject(parsed)) return fail();
        input = parsed;
      } else {
        return fail();
      }
      const call: LeakedToolCall = { rawName: name, input };
      items.push({ kind: "call", call });
      callCount++;
      continue;
    }
    // 未知块类型（thinking/image/…）：整体放弃，原样保留
    return fail();
  }

  if (callCount === 0) return fail();
  return { items, callCount };
}
