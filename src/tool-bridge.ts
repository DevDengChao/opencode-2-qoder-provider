/**
 * tool-bridge.ts — 声明型 MCP 工具桥接
 *
 * 参考 pi-qoder-provider 的方案：把 opencode 的工具（bash/edit/grep 等）通过
 * createSdkMcpServer "声明" 给 qodercli：
 *  - 模型能看到工具名/描述/参数 schema，从而发出 tool_use 调用
 *  - 但 qodercli 侧永不执行：MCP handler 是无副作用的错误兜底，
 *    canUseTool 永远返回 deny
 *  - model.ts 拦截 tool_use 流事件，转成 AI SDK 的 tool-call 交回 opencode 执行
 *
 * 安全不变量：
 *  1. qodercli 原生工具始终关闭（tools: []）
 *  2. MCP handler 无副作用
 *  3. canUseTool 始终拒绝
 *  4. 与 qodercli 保留名冲突的 opencode 工具名使用 oc_<hash> 别名
 */
import { createHash } from "node:crypto";
import {
  createSdkMcpServer,
  tool as qoderTool,
  type CanUseTool,
  type McpSdkServerConfigWithInstance,
} from "@qoder-ai/qoder-agent-sdk";
import { z } from "zod";
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
import { logInfo, logError } from "./logger.js";

export const OPENCODE_MCP_SERVER_KEY = "opencode";

/** qodercli 内置工具名保留列表（同名冲突时需别名，避免与原生工具混淆） */
const RESERVED_NAMES = new Set([
  "mcp_list", "mcp_get", "mcp_call",
  "Agent", "AskUserQuestion", "Bash", "Edit", "Glob", "Grep", "ImageGen",
  "ImageSearch", "NotebookEdit", "Read", "Skill", "TodoWrite", "WebFetch",
  "WebSearch", "Write",
]);

const VALID_NAME = /^[A-Za-z0-9_-]{1,64}$/;

export interface QoderToolBridge {
  server: McpSdkServerConfigWithInstance;
  toolCount: number;
  /** opencode 侧原始工具名清单（mapper 回收 `<tool_call>` 文本泄漏时的名称归一化） */
  toolNames: string[];
  canUseTool: CanUseTool;
  /** qodercli 侧工具名（exposedName/内部名/mcp__ 全名）→ opencode 原名 */
  toOpencodeName(providerName: string): string | undefined;
  /** opencode 原名 → qodercli 侧 exposedName */
  toProviderName(opencodeName: string): string | undefined;
}

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function uniqueAlias(name: string, used: Set<string>): string {
  if (VALID_NAME.test(name) && !RESERVED_NAMES.has(name) && !used.has(name)) {
    used.add(name);
    return name;
  }
  const base = `oc_${shortHash(name)}`;
  let alias = base;
  let suffix = 1;
  while (used.has(alias) || RESERVED_NAMES.has(alias)) {
    alias = `${base}_${suffix++}`;
  }
  used.add(alias);
  return alias;
}

/**
 * 从 opencode 传入的工具定义（LanguageModelV3FunctionTool）构建声明型 MCP server。
 * tools 为空时返回 undefined（不挂载 MCP）。
 */
export function buildQoderToolBridge(
  tools: Array<LanguageModelV3FunctionTool | { type?: string; name?: string }> | undefined,
): QoderToolBridge | undefined {
  const functionTools = (tools || []).filter(
    (t): t is LanguageModelV3FunctionTool => t?.type === "function" && typeof t?.name === "string",
  );
  if (functionTools.length === 0) return undefined;

  const usedAliases = new Set<string>();
  const ocToProvider = new Map<string, string>();
  const providerToOc = new Map<string, string>();
  const names: string[] = [];

  const declarations = functionTools.map((definition, index) => {
    const providerName = uniqueAlias(definition.name, usedAliases);
    const internalName = `decl_${index}_${shortHash(definition.name)}`;
    ocToProvider.set(definition.name, providerName);
    // 模型可能以 exposedName、内部名或完整 mcp__ 形式引用工具，统一映射
    providerToOc.set(providerName, definition.name);
    providerToOc.set(internalName, definition.name);
    providerToOc.set(`mcp__${OPENCODE_MCP_SERVER_KEY}__${internalName}`, definition.name);
    names.push(definition.name);

    let shape: Record<string, z.ZodType> = {};
    try {
      const converted = z.fromJSONSchema(
        definition.inputSchema || { type: "object", properties: {} },
      );
      if (!(converted instanceof z.ZodObject)) {
        throw new Error("tool schema root must be an object");
      }
      shape = converted.shape;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      logError(`tool-bridge: cannot expose tool ${definition.name}: ${detail}`);
    }

    const description = providerName === definition.name
      ? (definition.description || `Tool ${definition.name}`)
      : `OpenCode tool name: ${definition.name}. ${definition.description || ""}`;

    return qoderTool(
      internalName,
      description,
      shape,
      // 无副作用 handler：真正的执行发生在 opencode 侧
      async () => ({
        isError: true,
        content: [{
          type: "text",
          text: "Execution is delegated to the OpenCode host; this declaration adapter cannot execute tools.",
        }],
      }),
      {
        exposedName: providerName,
        alwaysLoad: true,
        permissionPolicy: "always_ask",
      },
    );
  });

  const server = createSdkMcpServer({
    name: "opencode-tool-declarations",
    tools: declarations,
  });

  // canUseTool 永远拒绝：qodercli 只负责"发出调用"，执行权 100% 在 opencode
  const canUseTool: CanUseTool = async (_toolName, _input, options) => {
    options.signal.throwIfAborted();
    return {
      behavior: "deny",
      message: "Execution is delegated to the OpenCode host.",
      interrupt: true,
      toolUseID: options.toolUseID,
      decisionClassification: "user_reject",
    };
  };

  logInfo(`tool-bridge: bridged ${declarations.length} opencode tools: ${names.join(",")}`);
  return {
    server,
    toolCount: declarations.length,
    toolNames: [...names],
    canUseTool,
    toOpencodeName: (providerName) => providerToOc.get(providerName),
    toProviderName: (opencodeName) => ocToProvider.get(opencodeName),
  };
}
