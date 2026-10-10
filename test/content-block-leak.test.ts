import { describe, it, expect } from "vitest";
import {
  classifyContentBlockJsonStart,
  parseLeakedContentBlocks,
  CONTENT_BLOCK_PROBE_MAX,
} from "../src/content-block-leak.js";

// ─── 块首探测（classifyContentBlockJsonStart） ──────────────────────────────

describe("classifyContentBlockJsonStart 块首判定", () => {
  it("数组形态：判定键闭合后收敛（keep → commit / reject）", () => {
    expect(classifyContentBlockJsonStart("[")).toBe("keep");
    expect(classifyContentBlockJsonStart("[{")).toBe("keep");
    expect(classifyContentBlockJsonStart("[{\"")).toBe("keep");
    expect(classifyContentBlockJsonStart("[{\"ty")).toBe("keep");
    expect(classifyContentBlockJsonStart("[{\"type")).toBe("keep");
    expect(classifyContentBlockJsonStart("[{\"type\"")).toBe("commit");
    expect(classifyContentBlockJsonStart("[{\"type\":")).toBe("commit");
    expect(classifyContentBlockJsonStart("[{\"id\"")).toBe("commit");
    expect(classifyContentBlockJsonStart("[{\"pi_tool_name\"")).toBe("commit");
    expect(classifyContentBlockJsonStart("[{\"foo\"")).toBe("reject");
  });

  it("数组形态：快速排除普通文本", () => {
    expect(classifyContentBlockJsonStart("[Download] x")).toBe("reject");
    expect(classifyContentBlockJsonStart("[参考] 先看这里")).toBe("reject");
    expect(classifyContentBlockJsonStart("[ ]")).toBe("reject");
    expect(classifyContentBlockJsonStart("[1,2]")).toBe("reject");
    expect(classifyContentBlockJsonStart("[true")).toBe("reject");
    expect(classifyContentBlockJsonStart("hello")).toBe("reject");
    expect(classifyContentBlockJsonStart("# 标题")).toBe("reject");
  });

  it("单对象形态：值必须向 \"tool_use\" 收敛", () => {
    expect(classifyContentBlockJsonStart("{")).toBe("keep");
    expect(classifyContentBlockJsonStart("{\"")).toBe("keep");
    expect(classifyContentBlockJsonStart("{\"type\"")).toBe("keep");
    expect(classifyContentBlockJsonStart("{\"type\":")).toBe("keep");
    expect(classifyContentBlockJsonStart("{\"type\":\"")).toBe("keep");
    expect(classifyContentBlockJsonStart("{\"type\":\"tool_us")).toBe("keep");
    expect(classifyContentBlockJsonStart("{\"type\":\"tool_use\"")).toBe("commit");
    expect(classifyContentBlockJsonStart("{\"type\": \"tool_use\"")).toBe("commit");
    expect(classifyContentBlockJsonStart("{\"type\":\"text\"")).toBe("reject");
    expect(classifyContentBlockJsonStart("{\"type\":\"Tool_use\"")).toBe("reject");
    expect(classifyContentBlockJsonStart("{\"name\":\"x\"")).toBe("reject");
  });

  it("空白处理：少量前导空白容忍，超量判非法", () => {
    expect(classifyContentBlockJsonStart("")).toBe("keep");
    expect(classifyContentBlockJsonStart("   ")).toBe("keep");
    expect(classifyContentBlockJsonStart("  [{\"type\"")).toBe("commit");
    expect(classifyContentBlockJsonStart(" ".repeat(20))).toBe("reject");
  });

  it("探测上限常量存在且为有限值（调用方超界按 reject 处理）", () => {
    expect(CONTENT_BLOCK_PROBE_MAX).toBeGreaterThan(32);
    expect(CONTENT_BLOCK_PROBE_MAX).toBeLessThan(1024);
  });
});

// ─── 整块解析（parseLeakedContentBlocks，真实语料形状） ─────────────────────

const MIXED = JSON.stringify([
  {
    type: "text",
    text: "继续排查 active 数据链路:并行查看 mixin 处理器、会员查询实现、Mapper、DO 字段类型,并提取工单截图文字与近期改动。",
  },
  {
    type: "tool_use",
    id: "call_00_A1b2C3d4E5f6G7h8I9j0K1",
    name: "read",
    pi_tool_name: "read",
    input: { filePath: "/root/workspace/dianyan/hi-line/api/MemberUserDO.java" },
  },
  {
    type: "tool_use",
    id: "call_01_B1b2C3d4E5f6G7h8I9j0K2",
    pi_tool_name: "grep",
    input: { pattern: "(avatar|banner)", path: "/root/workspace/dianyan/hi-line/api/MemberUserDO.java" },
  },
]);

describe("parseLeakedContentBlocks 真实语料形状", () => {
  it("混合数组：text 回流 + 2 个调用回收（pi_tool_name 兜底、顺序保持）", () => {
    const { items, callCount } = parseLeakedContentBlocks(MIXED);
    expect(callCount).toBe(2);
    expect(items.map((i) => i.kind)).toEqual(["text", "call", "call"]);
    expect((items[0] as { kind: "text"; text: string }).text).toContain("继续排查 active 数据链路");
    expect(items[1]).toEqual({
      kind: "call",
      call: { rawName: "read", input: { filePath: "/root/workspace/dianyan/hi-line/api/MemberUserDO.java" } },
    });
    // name 缺失 → pi_tool_name 兜底
    expect(items[2]).toEqual({
      kind: "call",
      call: { rawName: "grep", input: { pattern: "(avatar|banner)", path: "/root/workspace/dianyan/hi-line/api/MemberUserDO.java" } },
    });
  });

  it("纯调用数组（无 text 块）", () => {
    const raw = JSON.stringify([
      { type: "tool_use", id: "call_00_x", name: "shell", pi_tool_name: "shell", input: { command: "git status" } },
      { type: "tool_use", id: "call_01_y", name: "read", input: { filePath: "/a.ts" } },
    ]);
    const { items, callCount } = parseLeakedContentBlocks(raw);
    expect(callCount).toBe(2);
    expect(items.every((i) => i.kind === "call")).toBe(true);
    expect((items[0] as { kind: "call"; call: { rawName: string } }).call.rawName).toBe("shell");
  });

  it("16:24 自序列化变体（[{\"type\":\"text\",…} 包裹 + 调用）", () => {
    const raw = JSON.stringify([
      { type: "text", text: "上一条消息把工具调用写进了普通文本里，不会被执行；这里改用正式的工具调用通道重发。" },
      { type: "tool_use", id: "call_08_Tm3kR6sQp8Wv4Xz9Bn5Gj2d7", name: "shell", pi_tool_name: "shell", input: { command: "date", workdir: "/root" } },
    ]);
    const { items, callCount } = parseLeakedContentBlocks(raw);
    expect(callCount).toBe(1);
    expect((items[0] as { kind: "text"; text: string }).text).toContain("上一条消息把工具调用写进了普通文本里");
    expect((items[1] as { kind: "call"; call: { input: unknown } }).call.input).toEqual({ command: "date", workdir: "/root" });
  });

  it("单对象 {\"type\":\"tool_use\",…}", () => {
    const raw = `{"type":"tool_use","name":"shell","input":{"command":"ls"}}`;
    const { items, callCount } = parseLeakedContentBlocks(raw);
    expect(callCount).toBe(1);
    expect((items[0] as { kind: "call"; call: { rawName: string; input: unknown } }).call).toEqual({
      rawName: "shell",
      input: { command: "ls" },
    });
  });

  it("input 为 JSON 字符串 → 解析为对象；arguments 别名亦可", () => {
    const raw = JSON.stringify([
      { type: "tool_use", name: "edit", input: JSON.stringify({ filePath: "/a.ts", oldString: "a", newString: "b" }) },
      { type: "tool_use", name: "read", arguments: { filePath: "/b.ts" } },
    ]);
    const { items, callCount } = parseLeakedContentBlocks(raw);
    expect(callCount).toBe(2);
    expect((items[0] as { kind: "call"; call: { input: unknown } }).call.input).toEqual({ filePath: "/a.ts", oldString: "a", newString: "b" });
    expect((items[1] as { kind: "call"; call: { input: unknown } }).call.input).toEqual({ filePath: "/b.ts" });
  });

  it("input 缺失 → {}（无参调用）", () => {
    const raw = JSON.stringify([{ type: "tool_use", name: "noop" }]);
    const { items, callCount } = parseLeakedContentBlocks(raw);
    expect(callCount).toBe(1);
    expect((items[0] as { kind: "call"; call: { input: unknown } }).call.input).toEqual({});
  });
});

describe("parseLeakedContentBlocks 拒绝与保守语义（绝不丢内容）", () => {
  const expectFail = (raw: string) => {
    const { items, callCount } = parseLeakedContentBlocks(raw);
    expect(callCount).toBe(0);
    expect(items).toEqual([{ kind: "text", text: raw }]);
  };

  it("纯文本（非 JSON）", () => expectFail("普通回复，没有任何工具调用。"));
  it("文本形态数组（无调用）", () => expectFail(`[{"type":"text","text":"hi"}]`));
  it("未知块类型（image）", () => expectFail(`[{"type":"image","source":{"type":"base64"}}]`));
  it("单对象 text（无调用）", () => expectFail(`{"type":"text","text":"hi"}`));
  it("截断 JSON", () => expectFail(`[{"type":"tool_use","name":"read","input":{"filePath":"/a`));
  it("前后夹杂散文", () => expectFail(`继续：[{"type":"tool_use","name":"read","input":{}}]`));
  it("tool_use 缺 name/pi_tool_name", () => expectFail(`[{"type":"tool_use","input":{"a":1}}]`));
  it("input 为不可解析字符串", () => expectFail(`[{"type":"tool_use","name":"x","input":"not json"}]`));
  it("input 为数字", () => expectFail(`[{"type":"tool_use","name":"x","input":42}]`));
  it("元素非对象", () => expectFail(`[1,2,3]`));
  it("空数组", () => expectFail(`[]`));
  it("JSON 顶层是字符串/数字", () => {
    expectFail(`"hello"`);
    expectFail(`42`);
  });
});
