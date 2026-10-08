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

export const LEAK_MARKER = "<tool_call>";
export const LEAK_MARKER_END = "</tool_call>";

export interface LeakedToolCall {
  /** 原始函数名（未做 opencode 名映射，mapper 负责解析） */
  rawName: string;
  input: Record<string, unknown>;
}

export type LeakParseItem =
  | { kind: "text"; text: string }
  | { kind: "call"; call: LeakedToolCall };

export interface LeakParseResult {
  items: LeakParseItem[];
  callCount: number;
}

/** `<function=name>` / `<function name>` / `<function: name>` */
const FUNCTION_RE = /<function[=:\s]+([A-Za-z0-9_.\-]+)[^>]*>/;
/** `<parameter=key>value</parameter>`（value 非贪婪，允许换行） */
const PARAM_RE = /<parameter[=:\s]+([A-Za-z0-9_.\-]+)[^>]*>([\s\S]*?)<\/parameter>/g;
/** 残留的孤立闭合标签（畸形块清理用） */
const STRAY_TAG_RE = /<\/?(?:parameter|function|tool_call)[^>]*>/g;

/** 只剥掉包裹值两侧的结构性换行（保留行内缩进——edit 的 oldString 依赖缩进） */
function stripStructureNewlines(value: string): string {
  return value.replace(/^\r?\n/, "").replace(/\r?\n$/, "");
}

function stripToolsPrefix(name: string): string {
  return name.replace(/^tools\./i, "");
}

function collectXmlParams(region: string): Record<string, unknown> | undefined {
  const out: Record<string, unknown> = {};
  let matched = false;
  PARAM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = PARAM_RE.exec(region)) !== null) {
    out[m[1]] = stripStructureNewlines(m[2]);
    matched = true;
  }
  return matched ? out : undefined;
}

function tryJsonObject(text: string): Record<string, unknown> | undefined {
  const cleaned = text.replace(STRAY_TAG_RE, "").trim();
  if (!cleaned) return undefined;
  try {
    const value = JSON.parse(cleaned);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    /* not JSON */
  }
  return undefined;
}

/** execute 代码内陈旧 codemode 工具名 → 当前名（V2 为 tools.shell） */
export function normalizeExecuteCode(code: string): string {
  return code
    .replace(/\btools\.execute_shell\s*\(/g, "tools.shell(")
    .replace(/\btools\.bash\s*\(/g, "tools.shell(")
    .replace(/\btools\.exec\s*\(/g, "tools.shell(");
}

/**
 * 由函数名 + 参数字区间构造一个工具调用。
 * 返回 undefined 表示该块不可安全转换（调用方将整块保留为文本）。
 */
function buildCall(rawName: string, region: string): LeakedToolCall | undefined {
  const name = rawName.trim();
  const base = stripToolsPrefix(name).toLowerCase();

  const params = collectXmlParams(region);
  if (params && Object.keys(params).length > 0) {
    if (base === "execute" && !("code" in params) && typeof params.command === "string") {
      // `<function=execute><parameter=command>…`：意图是执行一条 shell 命令
      const input: Record<string, unknown> = { command: params.command };
      if (typeof params.workdir === "string") input.workdir = params.workdir;
      return { rawName: "shell", input };
    }
    if (base === "execute" && typeof params.code === "string") {
      return { rawName: name, input: { ...params, code: normalizeExecuteCode(params.code) } };
    }
    return { rawName: name, input: params };
  }

  // 无 XML 参数：仅接受结构化回退（裸 JSON 体 / execute 代码文本）。
  // 不再为 shell 猜测裸文本参数——截断的命令文本绝不当作命令执行。
  const regionText = region.replace(STRAY_TAG_RE, "").trim();
  if (!regionText) return undefined;
  const asJson = tryJsonObject(region);
  if (asJson) return { rawName: name, input: asJson };
  if (base === "execute") return { rawName: name, input: { code: regionText } };
  return undefined;
}

/**
 * 从一段文本中解析所有 `<tool_call>` 块。
 * 非调用内容（块间文本、无法解析的块）按原顺序保留为 text item。
 */
export function parseLeakedToolCalls(text: string): LeakParseResult {
  const items: LeakParseItem[] = [];
  let callCount = 0;
  let pos = 0;

  const pushText = (s: string): void => {
    if (s) items.push({ kind: "text", text: s });
  };

  while (pos < text.length) {
    const start = text.indexOf(LEAK_MARKER, pos);
    if (start < 0) {
      pushText(text.slice(pos));
      break;
    }

    let end = text.indexOf(LEAK_MARKER_END, start + LEAK_MARKER.length);
    if (end < 0) {
      // 缺失 </tool_call>：仅当块内已有 </function>（结构闭合）时视作完整块，
      // 否则可能是截断输出——整体保留为文本，避免执行半截参数
      if (text.indexOf("</function>", start) >= 0) {
        end = text.length;
      } else {
        pushText(text.slice(start));
        break;
      }
    }
    const blockEnd = Math.min(end + LEAK_MARKER_END.length, text.length);
    const inner = text.slice(start + LEAK_MARKER.length, end);

    let call: LeakedToolCall | undefined;
    const fn = FUNCTION_RE.exec(inner);
    if (fn) {
      let region = inner.slice(fn.index + fn[0].length);
      const fnEnd = region.indexOf("</function>");
      if (fnEnd >= 0) region = region.slice(0, fnEnd);
      call = buildCall(fn[1], region);
    }

    if (call) {
      pushText(text.slice(pos, start));
      items.push({ kind: "call", call });
      callCount++;
    } else {
      // 无法安全转换的块：整块（含标签）原样保留
      pushText(text.slice(pos, blockEnd));
    }
    pos = blockEnd;
  }

  return { items, callCount };
}
