/**
 * index.ts — OpenCode Qoder Provider 入口
 *
 * 导出 opencode 可加载的 provider 工厂函数。
 * 内部使用 @qoder-ai/qoder-agent-sdk 的 query() API。
 *
 * opencode.json 配置示例：
 * {
 *   "provider": {
 *     "qoder": {
 *       "npm": "github:wcmk21/opencode-qoder-provider",
 *       "name": "Qoder",
 *       "options": { "region": "global" },
 *       "models": {
 *         "auto": { "name": "Qoder Auto" },
 *         "performance": { "name": "Qoder Performance" }
 *       }
 *     }
 *   }
 * }
 */
import { QoderLanguageModel, type QoderProviderOptions } from "./model.js";
import {
  getCachedModels,
  fetchModelCatalog,
  resolveRegion,
  type QoderRegion,
  type QoderModelDef,
} from "./models.js";

import { log, logError, logInfo, DEBUG } from "./logger.js";

// 模块加载标记：进程 import 本包时打印一行（部署验证用——
// 重启/重载 opencode 服务后 grep 本行，即可确认新的 dist 已被加载）
logInfo("qoder-provider: dist module loaded");

function maskPat(pat: string): string {
  if (!pat) return "(empty)";
  if (pat.length <= 8) return "***";
  return pat.slice(0, 4) + "..." + pat.slice(-4);
}

// ─── Model Metadata ─────────────────────────────────────────────────────────
/** 将 QoderModelDef 转换为 opencode 可识别的模型元数据 */
function buildModelMap(region: QoderRegion): Record<string, {
  name: string;
  reasoning?: boolean;
  input?: string[];
  contextWindow?: number;
  maxTokens?: number;
}> {
  const models = getCachedModels(region);
  const map: Record<string, any> = {};
  for (const m of models) {
    map[m.id] = {
      name: m.name,
      reasoning: m.reasoning,
      input: m.input,
      contextWindow: m.contextWindow,
      maxTokens: m.maxTokens,
    };
  }
  return map;
}

// ─── Provider Factory ───────────────────────────────────────────────────────
/**
 * opencode 加载此包时调用。
 * `settings` 来自 opencode.json 的 `settings` 字段。
 * `apiKey` 来自 opencode 的 /connect 或 env 字段指定的环境变量。
 *
 * 动态模型发现：
 *  - 同步读取本地缓存（上次 fetchModelCatalog 的结果）
 *  - 异步刷新远端缓存（下次启动生效）
 *  - 注意：opencode 不读取 factory 返回的 models 对象（只调用 languageModel()），
 *    模型列表由 plugin.ts 的 config hook 注入 opencode.json 的 provider.models
 */
function createQoderProvider(options: QoderProviderOptions = {}) {
  const region = resolveRegion(options.region);
  // CN 区优先读 QODERCN_PERSONAL_ACCESS_TOKEN，否则回退到全局 QODER_PERSONAL_ACCESS_TOKEN
  const pat = options.apiKey
    || (region === "cn" ? process.env.QODERCN_PERSONAL_ACCESS_TOKEN : undefined)
    || process.env.QODER_PERSONAL_ACCESS_TOKEN
    || "";

  // ── 诊断日志：provider 初始化 ──
  log("createQoderProvider called");
  log("  region:", region);
  log("  pat:", maskPat(pat));
  log("  options.apiKey:", options.apiKey ? "(provided)" : "(not provided)");
  log("  options.cwd:", options.cwd || "(default)");
  log("  env.QODER_REGION:", process.env.QODER_REGION || "(unset)");
  log("  env.QODER_PERSONAL_ACCESS_TOKEN:", process.env.QODER_PERSONAL_ACCESS_TOKEN ? "(set)" : "(unset)");

  // 启动时异步刷新模型缓存（不阻塞 provider 加载）
  if (pat) {
    fetchModelCatalog(pat, region)
      .then((models) => log("Model catalog refreshed:", models.length, "models"))
      .catch((err) => {
        logError("[qoder-provider] fetchModelCatalog failed:", err?.message || err);
        if (DEBUG && err?.stack) logError(err.stack);
      });
  } else {
    log("No PAT found, skipping model catalog refresh");
  }

  // 从缓存构建模型元数据 map（同步，来自上次刷新的结果）
  const modelMap = buildModelMap(region);

  return {
    /**
     * 所有已知模型定义（缓存 + 静态 fallback）。
     * 注意：opencode 不读取此字段——模型选择器的数据源是 opencode.json 中
     * provider.models 的声明，本包通过 plugin.ts 的 config hook 自动注入。
     * 此 map 仅供测试与编程式调用使用。
     */
    models: modelMap,

    /**
     * opencode 为每个模型调用此方法。
     * 返回 LanguageModelV3 兼容实例。
     */
    languageModel(modelId: string): QoderLanguageModel {
      return new QoderLanguageModel(modelId, {
        ...options,
        region,
      });
    },
  };
}

// ─── Exports ────────────────────────────────────────────────────────────────
export default createQoderProvider;
export { createQoderProvider, QoderLanguageModel };
export type { QoderProviderOptions, QoderModelDef, QoderRegion };
export { getCachedModels, fetchModelCatalog, resolveRegion };
