import { type CanUseTool, type McpSdkServerConfigWithInstance } from "@qoder-ai/qoder-agent-sdk";
import type { LanguageModelV3FunctionTool } from "@ai-sdk/provider";
export declare const OPENCODE_MCP_SERVER_KEY = "opencode";
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
/**
 * 从 opencode 传入的工具定义（LanguageModelV3FunctionTool）构建声明型 MCP server。
 * tools 为空时返回 undefined（不挂载 MCP）。
 */
export declare function buildQoderToolBridge(tools: Array<LanguageModelV3FunctionTool | {
    type?: string;
    name?: string;
}> | undefined): QoderToolBridge | undefined;
