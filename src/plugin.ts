/**
 * plugin.ts — OpenCode V1 Plugin 入口
 *
 * opencode 的模型列表只来自 config（opencode.json 中 provider.models 的显式声明）。
 * provider factory 返回的 models 对象不会被 opencode 读取（opencode 加载 provider
 * 包时只调用其 languageModel()），因此本插件通过 config hook 在启动时把动态模型
 * 目录（HTTP API + 静态 fallback）注入 provider.models，实现"零声明"模型列表：
 * 无需在 opencode.json 中逐个手写模型 ID。
 *
 * 注意：不用 plugin 的 provider.models hook——它要求 provider 已存在于 models.dev
 * 数据库（opencode 源码 provider.ts 中 `if (!provider) continue`），qoder 不在其中，
 * 该 hook 永远不会被调用。
 *
 * opencode.json 配置：
 * {
 *   "provider": {
 *     "qoder": {
 *       "npm": "github:wcmk21/opencode-qoder-provider",
 *       "name": "Qoder",
 *       "options": { "region": "global" }
 *     }
 *   },
 *   "plugin": ["github:wcmk21/opencode-qoder-provider"]
 * }
 *
 * V2（opencode 2.x）请改用 src/plugin-v2.ts（本文件导出的是 V1 契约的裸函数，
 * V2 加载器会拒绝）。共享逻辑见 catalog-loader.ts。
 */
import type { Plugin, Config } from "@opencode-ai/plugin";
import { fetchModelCatalog, type QoderModelDef } from "./models.js";
import { isQoderPackage, loadCatalog, resolvePat, resolveRegion } from "./catalog-loader.js";
import { logInfo } from "./logger.js";

// ─── Helpers ────────────────────────────────────────────────────────────────
/** QoderModelDef → opencode config 中的模型声明（models.dev 风格字段） */
function toModelSpec(m: QoderModelDef) {
  return {
    name: m.name,
    reasoning: m.reasoning,
    tool_call: true,
    // attachment/modalities 必须跟随模型目录的 input 声明：声明 image 的模型
    // opencode 才会把用户消息中的图片作为 file part 传给 provider，
    // 进而由 context.ts 转成 image block 透传给模型；硬编码 text-only 会让
    // opencode 在宿主层剥掉图片，模型只能看到占位文本
    attachment: m.input.includes("image"),
    status: "active" as const,
    modalities: { input: [...m.input], output: ["text"] },
    limit: { context: m.contextWindow, output: m.maxTokens },
    cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
  };
}

// ─── Plugin ─────────────────────────────────────────────────────────────────
/**
 * opencode 插件入口。
 * 导出一个函数，接收 context，返回 hooks 对象。
 */
export const QoderPlugin: Plugin = async (ctx) => {
  const clientLog = (level: "debug" | "info" | "warn" | "error", message: string, extra?: Record<string, unknown>) =>
    ctx.client.app.log({
      body: { service: "qoder-provider", level, message, extra },
    }).catch(() => {});

  return {
    // ── Config hook：动态模型目录注入 ──
    // opencode 在读取 cfg.provider 之前运行所有插件的 config hook，
    // 此处写入的 provider.models 会在随后被解析进模型数据库（模型选择器数据源）。
    config: async (config: Config) => {
      const providers = config.provider as Record<string, any> | undefined;
      if (!providers) return;

      for (const [providerID, p] of Object.entries(providers)) {
        if (!p || !isQoderPackage(p.npm)) continue;

        const region = resolveRegion(p.options?.region);
        const models = await loadCatalog(p.options, region);
        if (!models.length) {
          logInfo(`[qoder-plugin] no models resolved for provider "${providerID}" (region=${region})`);
          continue;
        }

        // 动态目录为基础；用户在 opencode.json 中显式声明的字段优先覆盖
        const declared = (p.models ?? {}) as Record<string, Record<string, unknown>>;
        const injected: Record<string, Record<string, unknown>> = {};
        for (const m of models) injected[m.id] = toModelSpec(m);
        for (const [id, spec] of Object.entries(declared)) {
          injected[id] = { ...injected[id], ...spec };
        }
        p.models = injected;

        logInfo(`[qoder-plugin] injected ${Object.keys(injected).length} models into provider "${providerID}" (region=${region})`);
      }
    },

    // ── 通用事件处理 ──
    event: async ({ event }) => {
      if (event.type === "session.created") {
        await clientLog("info", "Qoder provider active", {
          directory: ctx.directory,
        });
      }

      if (event.type === "session.idle") {
        // 会话空闲时后台刷新模型缓存（下次启动生效）
        const region = resolveRegion();
        const pat = resolvePat(undefined, region);
        if (pat) {
          try {
            await fetchModelCatalog(pat, region);
            await clientLog("debug", "Model cache refreshed");
          } catch {
            await clientLog("debug", "Model cache refresh skipped");
          }
        }
      }

      if (event.type === "session.error") {
        await clientLog("warn", "Session error detected");
      }
    },
  };
};

export default QoderPlugin;
