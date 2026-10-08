import { describe, it, expect } from "vitest";
import { parseLeakedToolCalls, normalizeExecuteCode, LEAK_MARKER } from "../src/toolcall-leak.js";

// ─── 结构级用例（真实语料形状） ─────────────────────────────────────────────

describe("parseLeakedToolCalls 基础结构", () => {
  it("单块单参数：调用项 + 无残留文本", () => {
    const text = `<tool_call>\n<function=shell>\n<parameter=command>\ngit status\n</parameter>\n</function>\n</tool_call>`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(1);
    expect(items).toEqual([
      { kind: "call", call: { rawName: "shell", input: { command: "git status" } } },
    ]);
  });

  it("多参数保留书写顺序；行内缩进保留（只剥结构性换行）", () => {
    const text = `<tool_call>\n<function=edit>\n<parameter=filePath>\n/a.kt\n</parameter>\n<parameter=oldString>\n    @NotNull\n    private final X x;\n</parameter>\n<parameter=newString>\n    @Nullable\n    private final X x;\n</parameter>\n</function>\n</tool_call>`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(1);
    const call = (items[0] as { kind: "call"; call: { rawName: string; input: Record<string, unknown> } }).call;
    expect(call.rawName).toBe("edit");
    expect(Object.keys(call.input)).toEqual(["filePath", "oldString", "newString"]);
    expect(call.input.oldString).toBe("    @NotNull\n    private final X x;");
    expect(call.input.newString).toBe("    @Nullable\n    private final X x;");
  });

  it("单个文本内多个块全部解析，块间文本按原顺序保留", () => {
    const text = `前缀说明\n<tool_call>\n<function=shell>\n<parameter=command>\nls\n</parameter>\n</function>\n</tool_call>\n中间过渡\n<tool_call>\n<function=read>\n<parameter=filePath>\n/b.ts\n</parameter>\n</function>\n</tool_call>\n尾部说明`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(2);
    expect(items.map((i) => i.kind)).toEqual(["text", "call", "text", "call", "text"]);
    expect((items[0] as { kind: "text"; text: string }).text).toBe("前缀说明\n");
    expect((items[2] as { kind: "text"; text: string }).text).toBe("\n中间过渡\n");
    expect((items[4] as { kind: "text"; text: string }).text).toBe("\n尾部说明");
  });

  it("7 个块 = 7 个调用（真实语料：一次消息里连发多个 edit）", () => {
    let text = "";
    for (let i = 1; i <= 7; i++) {
      text += `<tool_call>\n<function=edit>\n<parameter=filePath>\n/f${i}.kt\n</parameter>\n<parameter=oldString>\nold${i}\n</parameter>\n<parameter=newString>\nnew${i}\n</parameter>\n</function>\n</tool_call>\n`;
    }
    const { callCount, items } = parseLeakedToolCalls(text);
    expect(callCount).toBe(7);
    const calls = items.filter((i) => i.kind === "call");
    expect(calls).toHaveLength(7);
  });
});

describe("parseLeakedToolCalls 畸形变体", () => {
  it("裸 JSON 体（缺失 <parameter> 开标签，仅残留闭合标签）", () => {
    const text = `<tool_call>\n<function=tools.memory>\n{"mode":"view","path":"/root/x.md"}\n</parameter>\n</function>\n</tool_call>`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(1);
    const call = (items[0] as { kind: "call"; call: { rawName: string; input: unknown } }).call;
    expect(call.rawName).toBe("tools.memory");
    expect(call.input).toEqual({ mode: "view", path: "/root/x.md" });
  });

  it("execute 携带 command 参数 → 按 shell 处理（保留 workdir）", () => {
    const text = `<tool_call>\n<function=execute>\n<parameter=command>\nfind . -name "*.java" | head\n</parameter>\n<parameter=workdir>\n/app\n</parameter>\n</function>\n</tool_call>`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(1);
    const call = (items[0] as { kind: "call"; call: { rawName: string; input: unknown } }).call;
    expect(call.rawName).toBe("shell");
    expect(call.input).toEqual({ command: `find . -name "*.java" | head`, workdir: "/app" });
  });

  it("execute 代码：保留 code 并改写陈旧工具名 tools.bash/exec/execute_shell → tools.shell", () => {
    const code = `const a = await tools.bash({ command: "ls" });\nconst b = await tools.exec({ command: "pwd" });\nconst c = await tools.execute_shell({ command: "whoami" });\nreturn a;`;
    const text = `<tool_call>\n<function=execute>\n<parameter=code>\n${code}\n</parameter>\n</function>\n</tool_call>`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(1);
    const call = (items[0] as { kind: "call"; call: { rawName: string; input: { code: string } } }).call;
    expect(call.rawName).toBe("execute");
    expect(call.input.code).toContain(`tools.shell({ command: "ls" })`);
    expect(call.input.code).toContain(`tools.shell({ command: "pwd" })`);
    expect(call.input.code).toContain(`tools.shell({ command: "whoami" })`);
    expect(call.input.code).not.toContain("tools.bash");
    expect(call.input.code).not.toContain("tools.exec(");
  });

  it("缺失 </tool_call> 但结构闭合（有 </function>）→ 仍可解析", () => {
    const text = `<tool_call>\n<function=shell>\n<parameter=command>\nrm -rf node_modules\n</parameter>\n</function>`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(1);
    expect((items[0] as { kind: "call"; call: { input: unknown } }).call.input).toEqual({
      command: "rm -rf node_modules",
    });
  });

  it("截断的块（无任何闭合标签）→ 整段保留为文本，绝不产生调用", () => {
    const text = `<tool_call>\n<function=shell>\n<parameter=command>\ngit push --force`;
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(0);
    expect(items).toEqual([{ kind: "text", text }]);
  });

  it("函数名无法识别 → 整块保留为文本", () => {
    const block = `<tool_call>\n<function=>\n奇怪内容\n</function>\n</tool_call>`;
    const { items, callCount } = parseLeakedToolCalls(`注意 ${block} 结束`);
    expect(callCount).toBe(0);
    expect(items.map((i) => i.kind)).toEqual(["text", "text"]);
    // 无法解析的块与紧邻的前置文本合并为一段保留（内容零丢失）
    expect((items[0] as { kind: "text"; text: string }).text).toBe(`注意 ${block}`);
    const merged = items.map((i) => (i.kind === "text" ? i.text : "")).join("");
    expect(merged).toBe(`注意 ${block} 结束`);
  });

  it("普通文本（无标记）原样返回", () => {
    const text = "普通回复，没有任何工具调用。";
    const { items, callCount } = parseLeakedToolCalls(text);
    expect(callCount).toBe(0);
    expect(items).toEqual([{ kind: "text", text }]);
  });

  it("LEAK_MARKER 常量与语料一致", () => {
    expect(LEAK_MARKER).toBe("<tool_call>");
  });
});

describe("normalizeExecuteCode", () => {
  it("三种陈旧工具名均改写为 tools.shell，其余内容不动", () => {
    const input = `tools.bash({ a: 1 }); tools.exec({ b: 2 }); tools.execute_shell({ c: 3 }); tools.shell({ d: 4 });`;
    const out = normalizeExecuteCode(input);
    expect(out).toBe(`tools.shell({ a: 1 }); tools.shell({ b: 2 }); tools.shell({ c: 3 }); tools.shell({ d: 4 });`);
  });

  it("不触碰其它名字（如 tools.opencode.xxx、bare search）", () => {
    const input = `await tools.opencode.read_mcp_resource({ uri: "x" }); const s = search("shell");`;
    expect(normalizeExecuteCode(input)).toBe(input);
  });
});
