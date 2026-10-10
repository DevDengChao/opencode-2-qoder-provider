import { describe, it, expect, vi } from "vitest";

// 泄漏回收会写日志：指向临时文件，避免污染真实的 qoder-provider.log
vi.hoisted(() => {
  process.env.QODER_LOG_FILE = "/tmp/qoder-provider-tests.log";
});

import { StreamMapper } from "../src/mapper.js";

// ─── 事件构造工具（与 mapper-leak.test.ts 相同形状） ────────────────────────
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

const NAMES = ["shell", "edit", "read", "glob", "grep", "memory", "execute"];
const mkMapper = () =>
  new StreamMapper((p) => (NAMES.includes(p) ? p : undefined), undefined, NAMES);

const callParts = (parts: Array<{ type: string }>) => parts.filter((p) => p.type === "tool-call") as any[];
const textOf = (parts: Array<any>) =>
  parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");

// 真实语料形状（修复 app/home/active 15:35 轮）
const MIXED_CB = JSON.stringify([
  { type: "text", text: "继续排查 active 数据链路:并行查看 mixin 处理器、会员查询实现、Mapper、DO 字段类型,并提取工单截图文字与近期改动。" },
  { type: "tool_use", id: "call_00_A1", name: "read", pi_tool_name: "read", input: { filePath: "/root/workspace/dianyan/hi-line/api/A.java" } },
  { type: "tool_use", id: "call_01_B2", name: "grep", pi_tool_name: "grep", input: { pattern: "(avatar|banner)", path: "/root/workspace/dianyan/hi-line/api/B.java" } },
]);

describe("StreamMapper 内容块 JSON 泄漏回收", () => {
  it("混合数组跨 delta 拆分：文本回流 + 2 个调用回收 + tool_use 边界", () => {
    const m = mkMapper();
    m.map(messageStart());
    expect(m.map(blockStart(0, { type: "text" }))).toEqual([]);

    // 任意拆分三段（块首判定后进入整块缓冲，流式阶段全部暂扣）
    expect(m.map(blockDelta(0, { type: "text_delta", text: MIXED_CB.slice(0, 60) }))).toEqual([]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: MIXED_CB.slice(60, 220) }))).toEqual([]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: MIXED_CB.slice(220) }))).toEqual([]);

    const stopParts = m.map(blockStop(0));
    expect(stopParts.map((p) => p.type)).toEqual([
      "text-start",
      "text-delta",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "tool-input-start",
      "tool-input-delta",
      "tool-input-end",
      "tool-call",
      "text-end",
    ]);
    // 文本回流 = 数组内 text 块内容（不含 JSON 外壳）
    expect(textOf(stopParts)).toBe(
      "继续排查 active 数据链路:并行查看 mixin 处理器、会员查询实现、Mapper、DO 字段类型,并提取工单截图文字与近期改动。",
    );
    const calls = callParts(stopParts);
    expect(calls.map((c) => c.toolName)).toEqual(["read", "grep"]);
    expect(calls[0].input).toBe('{"filePath":"/root/workspace/dianyan/hi-line/api/A.java"}');
    expect(calls[1].input).toBe('{"pattern":"(avatar|banner)","path":"/root/workspace/dianyan/hi-line/api/B.java"}');
    expect(m.isToolBoundary()).toBe(true);

    const fin = m.flushFinish();
    expect(fin).toHaveLength(1);
    expect(fin[0]).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" } });
  });

  it("纯调用数组：不产生任何 text 部件", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const raw = JSON.stringify([
      { type: "tool_use", id: "call_00_x", name: "shell", pi_tool_name: "shell", input: { command: "git status" } },
      { type: "tool_use", id: "call_01_y", name: "read", input: { filePath: "/a.ts" } },
    ]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: raw }))).toEqual([]);

    const stopParts = m.map(blockStop(0));
    expect(stopParts.some((p) => p.type.startsWith("text"))).toBe(false);
    expect(callParts(stopParts)).toHaveLength(2);
    expect(m.isToolBoundary()).toBe(true);
  });

  it("16:24 自序列化变体：文本去壳回流、调用回收", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const raw = JSON.stringify([
      { type: "text", text: "上一条消息把工具调用写进了普通文本里，不会被执行；这里改用正式的工具调用通道重发。继续排查：查看工单截图确认哪些字段为 null。" },
      { type: "tool_use", id: "call_08_Tm3", name: "shell", pi_tool_name: "shell", input: { command: "date", workdir: "/root" } },
    ]);
    m.map(blockDelta(0, { type: "text_delta", text: raw }));
    const stopParts = m.map(blockStop(0));
    expect(textOf(stopParts)).toBe(
      "上一条消息把工具调用写进了普通文本里，不会被执行；这里改用正式的工具调用通道重发。继续排查：查看工单截图确认哪些字段为 null。",
    );
    const calls = callParts(stopParts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("shell");
    expect(calls[0].input).toBe('{"command":"date","workdir":"/root"}');
    expect(m.isToolBoundary()).toBe(true);
  });

  it("候选但不可安全回收（[{\"id\":1},…]）：原样保留为文本、边界不变", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const raw = `[{"id":1,"value":"x"},{"id":2,"value":"y"}]`;
    expect(m.map(blockDelta(0, { type: "text_delta", text: raw }))).toEqual([]);
    const stopParts = m.map(blockStop(0));
    expect(callParts(stopParts)).toHaveLength(0);
    expect(textOf(stopParts)).toBe(raw);
    expect(m.isToolBoundary()).toBe(false);
    const fin = m.flushFinish();
    expect(fin[0]).toMatchObject({ finishReason: { unified: "stop" } });
  });

  it("普通回复以 [ 开头：首块快速排除后照常流式（无整块缓冲）", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    expect(m.map(blockDelta(0, { type: "text_delta", text: "[参考] 先看这里" }))).toEqual([
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "[参考] 先看这里" },
    ]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: "，然后继续。" }))).toEqual([
      { type: "text-delta", id: "t0", delta: "，然后继续。" },
    ]);
    const stopParts = m.map(blockStop(0));
    expect(stopParts).toEqual([{ type: "text-end", id: "t0" }]);
    expect(textOf(stopParts)).toBe("");
    expect(m.isToolBoundary()).toBe(false);
  });

  it("单字符 [ 起步、次 delta 才排除：暂扣的 '[' 不丢失", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    expect(m.map(blockDelta(0, { type: "text_delta", text: "[" }))).toEqual([]);
    expect(m.map(blockDelta(0, { type: "text_delta", text: "参考] 内容" }))).toEqual([
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "[参考] 内容" },
    ]);
  });

  it("块中部的 JSON 数组不回收（仅整块形态在范围内）", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(blockDelta(0, { type: "text_delta", text: "说明文字 " }));
    const raw2 = `[{"type":"tool_use","name":"read","input":{}}]`;
    const p2 = m.map(blockDelta(0, { type: "text_delta", text: raw2 }));
    const stopParts = m.map(blockStop(0));
    expect(callParts([...p2, ...stopParts])).toHaveLength(0);
    expect(textOf([...p2, ...stopParts])).toBe(raw2);
    expect(m.isToolBoundary()).toBe(false);
  });

  it("候选内嵌 XML 泄漏：XML 解析兜底回收", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const raw = `[{"type":"text","text":"<tool_call><function=shell><parameter=command>ls -la</parameter></function></tool_call>"}]`;
    m.map(blockDelta(0, { type: "text_delta", text: raw }));
    const stopParts = m.map(blockStop(0));
    const calls = callParts(stopParts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("shell");
    expect(calls[0].input).toBe('{"command":"ls -la"}');
    expect(m.isToolBoundary()).toBe(true);
  });

  it("无 content_block_stop（进程终止）：flushFinish 兜底回收 + finish=tool-calls", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(blockDelta(0, { type: "text_delta", text: MIXED_CB }));
    const fin = m.flushFinish();
    expect(callParts(fin)).toHaveLength(2);
    expect(fin[fin.length - 1]).toMatchObject({ finishReason: { unified: "tool-calls", raw: "tool_use" } });
    expect(m.isToolBoundary()).toBe(true);
  });

  it("XML 形回归：JSON 探测不干扰既有 <tool_call> 泄漏回收", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    expect(m.map(blockDelta(0, { type: "text_delta", text: "先检查。" }))[0]?.type).toBe("text-start");
    expect(m.map(blockDelta(0, { type: "text_delta", text: "<tool_ca" }))).toEqual([]);
    expect(
      m.map(blockDelta(0, { type: "text_delta", text: "ll>\n<function=shell>\n<parameter=command>\ngit status\n</parameter>\n</function>\n</tool_call>" })),
    ).toEqual([]);
    const stopParts = m.map(blockStop(0));
    const calls = callParts(stopParts);
    expect(calls).toHaveLength(1);
    expect(calls[0].toolName).toBe("shell");
    expect(calls[0].input).toBe('{"command":"git status"}');
    expect(m.isToolBoundary()).toBe(true);
  });
});
