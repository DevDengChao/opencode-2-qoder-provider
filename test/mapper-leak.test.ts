import { describe, it, expect, vi } from "vitest";

// 泄漏回收会写日志：指向临时文件，避免污染真实的 qoder-provider.log
// （与 plugin-v2.test.ts 相同做法；vi.hoisted 在 import 求值前执行）
vi.hoisted(() => {
  process.env.QODER_LOG_FILE = "/tmp/qoder-provider-tests.log";
});

import { StreamMapper } from "../src/mapper.js";

// ─── 事件构造工具（与 mapper.test.ts 相同形状） ─────────────────────────────
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
/** 与 tool-bridge 同构：映射只认清单内名称（identity），清单外 undefined */
const mkMapper = () =>
  new StreamMapper((p) => (NAMES.includes(p) ? p : undefined), undefined, NAMES);

const callParts = (parts: Array<{ type: string }>) => parts.filter((p) => p.type === "tool-call") as any[];
const textOf = (parts: Array<any>) =>
  parts.filter((p) => p.type === "text-delta").map((p) => p.delta).join("");

describe("StreamMapper 工具调用文本泄漏回收", () => {
  it("前缀文本 + 泄漏 shell 调用（标记跨 delta 拆分）：文本不进泄漏内容，调用被回收", () => {
    const m = mkMapper();
    m.map(messageStart());
    expect(m.map(blockStart(0, { type: "text" }))).toEqual([]);

    const p1 = m.map(blockDelta(0, { type: "text_delta", text: "我先检查项目状态。\n\n" }));
    expect(p1).toEqual([
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "我先检查项目状态。\n\n" },
    ]);

    // 标记跨 delta 拆分：先到半截 "<tool_ca"，再补全
    expect(m.map(blockDelta(0, { type: "text_delta", text: "<tool_ca" }))).toEqual([]);
    expect(
      m.map(blockDelta(0, { type: "text_delta", text: "ll>\n<function=shell>\n<parameter=command>\ngit status\n</parameter>\n</function>\n</tool_call>\n" })),
    ).toEqual([]);

    const stopParts = m.map(blockStop(0));
    expect(stopParts).toEqual([
      { type: "tool-input-start", id: "t0_leak1", toolName: "shell", providerExecuted: false },
      { type: "tool-input-delta", id: "t0_leak1", delta: '{"command":"git status"}' },
      { type: "tool-input-end", id: "t0_leak1" },
      { type: "tool-call", toolCallId: "t0_leak1", toolName: "shell", input: '{"command":"git status"}', providerExecuted: false },
      { type: "text-end", id: "t0" },
    ]);
    expect(m.isToolBoundary()).toBe(true);
    const fin = m.flushFinish();
    expect(fin[0]).toMatchObject({ type: "finish", finishReason: { unified: "tool-calls", raw: "tool_use" } });
  });

  it("纯泄漏块：不产生任何 text 部件", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    expect(
      m.map(blockDelta(0, { type: "text_delta", text: "<tool_call>\n<function=shell>\n<parameter=command>\nls -la\n</parameter>\n</function>\n</tool_call>" })),
    ).toEqual([]);

    const stopParts = m.map(blockStop(0));
    expect(stopParts.map((p) => p.type)).toEqual(["tool-input-start", "tool-input-delta", "tool-input-end", "tool-call"]);
    expect(stopParts.some((p) => p.type.startsWith("text"))).toBe(false);
    expect(callParts(stopParts)[0].input).toBe('{"command":"ls -la"}');
    expect(m.isToolBoundary()).toBe(true);
  });

  it("同一 text 块内多个调用（7 个 edit）全部回收且顺序不变", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    let raw = "";
    for (let i = 1; i <= 7; i++) {
      raw += `<tool_call>\n<function=edit>\n<parameter=filePath>\n/f${i}.kt\n</parameter>\n<parameter=oldString>\nold${i}\n</parameter>\n<parameter=newString>\nnew${i}\n</parameter>\n</function>\n</tool_call>\n`;
    }
    m.map(blockDelta(0, { type: "text_delta", text: raw }));

    const stopParts = m.map(blockStop(0));
    const calls = callParts(stopParts);
    expect(calls).toHaveLength(7);
    expect(calls.map((c) => c.toolName)).toEqual(Array(7).fill("edit"));
    expect(calls[0].input).toBe('{"filePath":"/f1.kt","oldString":"old1","newString":"new1"}');
    expect(calls[6].input).toBe('{"filePath":"/f7.kt","oldString":"old7","newString":"new7"}');
    expect(m.isToolBoundary()).toBe(true);
  });

  it("tools.memory + 裸 JSON 体：名称经 tools. 前缀剥离后归一化到 memory", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(blockDelta(0, { type: "text_delta", text: `<tool_call>\n<function=tools.memory>\n{"mode":"view","path":"/root/x.md"}\n</parameter>\n</function>\n</tool_call>` }));
    const call = callParts(m.map(blockStop(0)))[0];
    expect(call.toolName).toBe("memory");
    expect(call.input).toBe('{"mode":"view","path":"/root/x.md"}');
  });

  it("execute 携带 command → 按 shell 回收", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(blockDelta(0, { type: "text_delta", text: `<tool_call>\n<function=execute>\n<parameter=command>\nfind . -name "*.java" | head\n</parameter>\n</function>\n</tool_call>` }));
    const call = callParts(m.map(blockStop(0)))[0];
    expect(call.toolName).toBe("shell");
    expect(call.input).toBe('{"command":"find . -name \\"*.java\\" | head"}');
  });

  it("名称大小写不敏感匹配；未知名走 __qoder_unsupported__ 占位", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(
      blockDelta(0, {
        type: "text_delta",
        text:
          `<tool_call>\n<function=SHELL>\n<parameter=command>\necho hi\n</parameter>\n</function>\n</tool_call>` +
          `<tool_call>\n<function=frobnicate>\n<parameter=value>\n1\n</parameter>\n</function>\n</tool_call>`,
      }),
    );
    const calls = callParts(m.map(blockStop(0)));
    expect(calls[0].toolName).toBe("shell");
    expect(calls[1].toolName).toBe("__qoder_unsupported__frobnicate");
  });

  it("无法解析的泄漏文本原样保留（不丢内容、不产生调用、边界不变）", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const full = `注意 <tool_call>\n<function=>\n奇怪内容\n</function>\n</tool_call> 结束`;
    const p1 = m.map(blockDelta(0, { type: "text_delta", text: full }));
    const stopParts = m.map(blockStop(0));
    expect(callParts(stopParts)).toHaveLength(0);
    expect(textOf([...p1, ...stopParts])).toBe(full);
    expect(m.isToolBoundary()).toBe(false);
    const fin = m.flushFinish();
    expect(fin[0]).toMatchObject({ finishReason: { unified: "stop" } });
  });

  it("截断的泄漏（无闭合）保留为文本，绝不执行半截命令", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const full = `<tool_call>\n<function=shell>\n<parameter=command>\nrm -rf /`;
    const p1 = m.map(blockDelta(0, { type: "text_delta", text: full }));
    const stopParts = m.map(blockStop(0));
    expect(callParts(stopParts)).toHaveLength(0);
    expect(textOf([...p1, ...stopParts])).toBe(full);
    expect(m.isToolBoundary()).toBe(false);
  });

  it("块未收到 content_block_stop 即结束：flushFinish 兜底回收", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    m.map(blockDelta(0, { type: "text_delta", text: "前缀\n<tool_call>\n<function=read>\n<parameter=filePath>\n/a.ts\n</parameter>\n</function>\n</tool_call>" }));

    const fin = m.flushFinish();
    const types = fin.map((p) => p.type);
    expect(types).toContain("tool-call");
    expect(types).toContain("finish");
    const call = callParts(fin)[0];
    expect(call.toolName).toBe("read");
    expect(call.input).toBe('{"filePath":"/a.ts"}');
    expect(fin[fin.length - 1]).toMatchObject({ finishReason: { unified: "tool-calls", raw: "tool_use" } });
    expect(m.isToolBoundary()).toBe(true);
  });

  it("普通长文本（含单个 < 字符）不被误伤，且照常流式发出", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const p1 = m.map(blockDelta(0, { type: "text_delta", text: "比较 a < b，还有 for(i=0; i<n; i++)" }));
    const p2 = m.map(blockDelta(0, { type: "text_delta", text: " 继续输出。" }));
    const stop = m.map(blockStop(0));
    expect(textOf([...p1, ...p2, ...stop])).toBe("比较 a < b，还有 for(i=0; i<n; i++) 继续输出。");
    expect(m.isToolBoundary()).toBe(false);
  });

  it("截断的疑似标记前缀（块尾的 '<tool_cal'）按文本吐出", () => {
    const m = mkMapper();
    m.map(messageStart());
    m.map(blockStart(0, { type: "text" }));
    const p1 = m.map(blockDelta(0, { type: "text_delta", text: "看这里 <tool_cal" }));
    expect(p1).toEqual([
      { type: "text-start", id: "t0" },
      { type: "text-delta", id: "t0", delta: "看这里 " },
    ]);
    const stop = m.map(blockStop(0));
    expect(stop).toEqual([
      { type: "text-delta", id: "t0", delta: "<tool_cal" },
      { type: "text-end", id: "t0" },
    ]);
    expect(m.isToolBoundary()).toBe(false);
  });
});
