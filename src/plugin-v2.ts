/**
 * plugin-v2.ts — OpenCode V2 插件入口（配置里的 `plugins` 字段）。
 *
 * 为什么需要它：V2 的插件加载器要求模块默认导出 `{ id, setup }`（或 effect），
 * V1 那种"默认导出裸异步函数"的定义会被直接拒载：
 *   Plugin must export a default definition with an id and an effect or setup function.
 *
 * V2 与 V1 的模型目录注入接口完全不同：
 *   V1：config hook 里改 `config.provider[].models`
 *   V2：`ctx.catalog.transform(draft => draft.model.update(providerID, modelID, fn))`
 *
 * 这里导出**纯对象字面量**而不是 `Plugin.define`（@opencode-ai/plugin/v2）：
 * 加载器只校验形状，纯对象让本包不引入任何 opencode 侧运行时依赖，
 * 也不与 V2 beta 期间的具体版本耦合（下方是最小类型声明）。
 *
 * opencode.json（V2）：
 * {
 *   "providers": {
 *     "qoder-cn": {
 *       "name": "Qoder CN",
 *       "package": "aisdk:file:///abs/path/to/opencode-qoder-provider/dist/index.js",
 *       "settings": { "region": "cn" },
 *       "models": { "auto": { "name": "Auto · Qoder CN" } }   // 锚点，其余自动注入
 *     }
 *   },
 *   "plugins": ["/abs/path/to/opencode-qoder-provider/dist/plugin-v2.js"]
 * }
 */
import { isQoderPackage, loadCatalog, resolveRegion, type LoaderOptions } from "./catalog-loader.js";
import { logInfo } from "./logger.js";

// ── V2 插件 API 的最小子集（beta 期不依赖 @opencode-ai/plugin 的具体版本） ──
interface V2ProviderInfo {
  id: string;
  name?: string;
  api?: { type?: string; package?: string; settings?: Record<string, unknown> };
}
interface V2CatalogProviderRecord {
  readonly provider: V2ProviderInfo;
  readonly models: ReadonlyMap<string, unknown>;
}
interface V2ModelApi {
  type?: string;
  package?: string;
  url?: string;
  settings?: Record<string, unknown>;
  id?: string;
}
interface V2ModelInfo {
  id: string;
  providerID: string;
  name: string;
  api: V2ModelApi;
  capabilities: { tools: boolean; input: string[]; output: string[] };
  limit: { context: number; input?: number; output: number };
  enabled: boolean;
}
interface V2CatalogDraft {
  readonly provider: {
    list(): readonly V2CatalogProviderRecord[];
    get(providerID: string): V2CatalogProviderRecord | undefined;
    update(providerID: string, update: (provider: V2ProviderInfo) => void): void;
    remove(providerID: string): void;
  };
  readonly model: {
    get(providerID: string, modelID: string): V2ModelInfo | undefined;
    update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void;
    remove(providerID: string, modelID: string): void;
  };
}
export interface V2PluginContext {
  readonly options?: Record<string, unknown>;
  readonly catalog: {
    transform(callback: (draft: V2CatalogDraft) => Promise<void> | void): Promise<unknown>;
    reload(): Promise<void>;
  };
}

export interface QoderV2PluginOptions {
  /** 显式指定 provider ID；不填则按 api.package 自动识别 */
  providerID?: string;
  /** 覆盖区域（global|cn），默认取 provider settings.region / QODER_REGION */
  region?: string;
  /** 覆盖 PAT，默认取 provider settings.apiKey / 环境变量 */
  apiKey?: string;
}

export const QoderPluginV2 = {
  id: "qoder.provider",
  setup: async (ctx: V2PluginContext): Promise<void> => {
    const options = (ctx.options ?? {}) as QoderV2PluginOptions;

    await ctx.catalog.transform(async (catalog) => {
      const targets: Array<{ id: string; settings: Record<string, unknown> }> = [];

      if (typeof options.providerID === "string" && options.providerID.length > 0) {
        // 显式指定：与"本插件 / 内建 config-provider 插件"的加载顺序无关
        targets.push({ id: options.providerID, settings: {} });
      } else {
        for (const record of catalog.provider.list()) {
          const api = record.provider.api;
          if (!isQoderPackage(api?.package)) continue;
          targets.push({
            id: record.provider.id,
            settings: (api?.settings ?? {}) as Record<string, unknown>,
          });
        }
      }

      if (targets.length === 0) {
        logInfo("[qoder-v2] no qoder provider found in catalog; declare one under `providers` (see README)");
        return;
      }

      for (const target of targets) {
        const settings = target.settings;
        const region = resolveRegion(
          options.region ?? (typeof settings.region === "string" ? settings.region : undefined),
        );

        const loaderOptions: LoaderOptions = { ...settings };
        if (options.apiKey !== undefined) loaderOptions.apiKey = options.apiKey;

        const catalogModels = await loadCatalog(loaderOptions, region);
        if (catalogModels.length === 0) {
          logInfo(`[qoder-v2] no models resolved for provider "${target.id}" (region=${region})`);
          continue;
        }

        // 新建的 catalog 模型条目默认 api.type = "native"（ModelV2.Info.empty），
        // 必须把 provider 的 api（type/package/settings）复制过来、只覆盖模型 id，
        // 否则该模型不会经由本包的 provider 包路由。
        const providerApi = catalog.provider.get(target.id)?.provider.api;

        for (const model of catalogModels) {
          catalog.model.update(target.id, model.id, (entry) => {
            if (providerApi) entry.api = { ...providerApi, id: model.id };
            entry.name = model.name;
            entry.capabilities = {
              tools: true,
              input: [...model.input],
              output: ["text"],
            };
            entry.limit = { context: model.contextWindow, output: model.maxTokens };
            entry.enabled = true;
          });
        }

        logInfo(`[qoder-v2] injected ${catalogModels.length} models into provider "${target.id}" (region=${region})`);
      }
    });
  },
};

export default QoderPluginV2;
