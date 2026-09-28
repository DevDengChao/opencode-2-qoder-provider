/**
 * plugin-v2.ts — OpenCode V2 插件入口（配置里的 `plugins` 字段）。
 *
 * 实测结论（opencode 2.0.18，依据二进制内的 draft 实现 + 本机验证）：
 *   - 插件定义必须是默认导出 `{ id, setup }`（或 effect）；V1 的裸函数被拒：
 *       Plugin must export a default definition with an id and an effect or setup function
 *   - `plugins` 路径必须指向**目录包**（目录内有 package.json）；写 .js 文件路径会报：
 *       configured plugin path must be a directory
 *   - 2.0.18 的 ctx **没有 catalog 命名空间**，而是拆成 `ctx.model` / `ctx.provider`：
 *       ctx.model.transform(draft => draft.update(providerID, modelID, entry => {...}))
 *     draft 含 { list, get, update, remove, default, provider:{ list, get } }；
 *     `update` 对 config 未声明的 modelID 是 **upsert**（会新建条目）；
 *     provider 未注册时 update 静默不生效（故支持 options.providerID 兜底）。
 *   - transform 会被重放：重放时既有条目可能已被冻结（Immer），改它会抛
 *       "This object has been frozen and should not be mutated"
 *     → 写入前判 `Object.isFrozen(entry)`，并对整体做 try/catch。
 *   - CLI/本地上下文里 ctx 可能只有 { app, location }（没有 model 命名空间）
 *     → 必须静默跳过，抛错会在日志里刷 "failed to load plugin"。
 *
 * 同时兼容早期 V2 beta 的 `ctx.catalog.transform(draft => draft.model.update(...))` 形态。
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
 *       "package": "aisdk:file:///abs/path/to/opencode-2-qoder-provider/dist/index.js",
 *       "settings": { "region": "cn" },
 *       "models": { "auto": { "name": "Auto · Qoder CN" } }   // 锚点，其余自动注入
 *     }
 *   },
 *   "plugins": ["opencode-qoder-provider-v2@file:/abs/path/to/opencode-2-qoder-provider/plugin-v2"]
 * }
 */
import { isQoderPackage, loadCatalog, resolveRegion, type LoaderOptions } from "./catalog-loader.js";
import type { QoderModelDef, QoderRegion } from "./models.js";
import { logError, logInfo } from "./logger.js";

/** 支持的区域；两个都预取，避免依赖 provider settings 里才知道的 region */
const REGIONS: readonly QoderRegion[] = ["cn", "global"];

// ── V2 插件 API 的最小子集（beta 期不依赖 @opencode-ai/plugin 的具体版本） ──
interface V2ProviderInfo {
  id: string;
  name?: string;
  /** 2.0.18：包规格直接挂在 provider 上 */
  package?: string;
  settings?: Record<string, unknown>;
  /** 早期 beta：包规格在 api 里 */
  api?: { type?: string; package?: string; settings?: Record<string, unknown> };
}
interface V2ModelInfo {
  id?: string;
  modelID?: string;
  providerID?: string;
  name?: string;
  capabilities?: { tools: boolean; input: string[]; output: string[] };
  limit?: { context: number; input?: number; output: number };
  enabled?: boolean;
  status?: string;
}
/** 2.0.18 的 model draft */
interface V2ModelDraft {
  update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void;
  provider?: { list?(): readonly unknown[] };
}
/** 早期 V2 beta 的 catalog draft */
interface V2CatalogDraft {
  readonly provider: { list(): readonly unknown[] };
  readonly model: { update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void };
}
export interface V2PluginContext {
  readonly options?: Record<string, unknown>;
  /** 2.0.18+ */
  readonly model?: { transform(callback: (draft: V2ModelDraft) => Promise<void> | void): Promise<unknown> };
  /** 早期 beta / 兼容 */
  readonly catalog?: { transform(callback: (draft: V2CatalogDraft) => Promise<void> | void): Promise<unknown> };
}

export interface QoderV2PluginOptions {
  /** 显式指定 provider ID；不填则按包规格自动识别 */
  providerID?: string;
  /** 覆盖区域（global|cn），默认取 provider settings.region / QODER_REGION */
  region?: string;
  /** 覆盖 PAT，默认取 provider settings.apiKey / 环境变量 */
  apiKey?: string;
}

/** provider 记录可能是 { provider: {...} } 也可能是扁平的 {...}（不同 beta 修订） */
function providerInfoOf(item: unknown): V2ProviderInfo | undefined {
  if (!item || typeof item !== "object") return undefined;
  const rec = item as Record<string, unknown>;
  const inner = (rec.provider && typeof rec.provider === "object" ? rec.provider : rec) as V2ProviderInfo;
  return typeof inner?.id === "string" ? inner : undefined;
}

/** 从 draft 里取 provider 列表（2.0.18 = draft.provider.list()；早期 beta 同形） */
function listProviders(draft: unknown): V2ProviderInfo[] {
  const seam = draft as { provider?: { list?: () => readonly unknown[] } };
  const raw = seam?.provider?.list?.() ?? [];
  return (raw as unknown[]).map(providerInfoOf).filter((p): p is V2ProviderInfo => !!p);
}

const packageOf = (p: V2ProviderInfo): unknown => p.api?.package ?? p.package;
const settingsOf = (p: V2ProviderInfo): Record<string, unknown> =>
  (p.api?.settings ?? p.settings ?? {}) as Record<string, unknown>;

type ModelUpdater = (providerID: string, modelID: string, update: (model: V2ModelInfo) => void) => void;

/** 取"模型 upsert"函数：2.0.18 在 draft.update；早期 beta 在 draft.model.update */
function modelUpdaterOf(draft: V2ModelDraft | V2CatalogDraft): ModelUpdater | undefined {
  const d = draft as V2ModelDraft & { model?: { update?: ModelUpdater } };
  if (typeof d.update === "function") return (p, m, fn) => d.update(p, m, fn);
  if (typeof d.model?.update === "function") return (p, m, fn) => d.model!.update!(p, m, fn);
  return undefined;
}

export const QoderPluginV2 = {
  id: "qoder.provider",
  setup: async (ctx: V2PluginContext): Promise<void> => {
    const options = (ctx.options ?? {}) as QoderV2PluginOptions;

    // 2.0.18：ctx.model；早期 beta：ctx.catalog。都没有 = 本地 CLI 上下文 → 静默跳过。
    const seam = ctx.model ?? ctx.catalog;
    if (!seam || typeof seam.transform !== "function") {
      logInfo("[qoder-v2] no model-catalog namespace on ctx (local context); nothing to do");
      return;
    }

    // ⚠️ 关键约束：transform 的回调必须**同步**（回调里不能有 await）。
    // 框架用 Immer 管理 draft，回调一旦 await，draft 就被 finalize 并冻结，
    // 之后再改条目会抛："This object has been frozen and should not be mutated"。
    // （实测：回调里 await 目录抓取 → 14/14 全部注入失败。）
    // 因此异步的目录抓取一律放在注册 transform 之前完成。
    // provider 的 region 只有在 draft 里才看得到，所以两个区域都预取
    // （没有对应区域 PAT 时 loadCatalog 直接读本地缓存/静态表，不发网络请求）。
    const loaderOptions: LoaderOptions = {};
    if (options.apiKey !== undefined) loaderOptions.apiKey = options.apiKey;

    const catalogs = new Map<string, QoderModelDef[]>();
    for (const region of REGIONS) catalogs.set(region, await loadCatalog(loaderOptions, region));

    const prefetchedRegion = resolveRegion(options.region);
    if ((catalogs.get(prefetchedRegion) ?? []).length === 0) {
      logInfo(`[qoder-v2] model catalog is empty for region=${prefetchedRegion}`);
    }

    await seam.transform((draft: V2ModelDraft | V2CatalogDraft) => {
      const upsertModel = modelUpdaterOf(draft);
      if (!upsertModel) {
        logError("[qoder-v2] unsupported V2 draft shape (no model update op); skipping injection");
        return;
      }

      const providers = listProviders(draft);
      const targets: Array<{ id: string; settings: Record<string, unknown> }> = [];

      if (typeof options.providerID === "string" && options.providerID.length > 0) {
        // 显式指定：不依赖 provider 是否已出现在 draft 列表里
        const found = providers.find((p) => p.id === options.providerID);
        targets.push({ id: options.providerID, settings: found ? settingsOf(found) : {} });
      } else {
        for (const p of providers) {
          if (!isQoderPackage(packageOf(p))) continue;
          targets.push({ id: p.id, settings: settingsOf(p) });
        }
      }

      if (targets.length === 0) {
        logInfo("[qoder-v2] no qoder provider found in catalog; declare one under `providers` (see README)");
        return;
      }

      for (const target of targets) {
        const region = resolveRegion(
          options.region ?? (typeof target.settings.region === "string" ? target.settings.region : undefined),
        );
        const catalogModels = catalogs.get(region) ?? catalogs.get(prefetchedRegion) ?? [];
        if (catalogModels.length === 0) {
          logInfo(`[qoder-v2] no models available for provider "${target.id}" (region=${region})`);
          continue;
        }

        let applied = 0;
        for (const model of catalogModels) {
          try {
            upsertModel(target.id, model.id, (entry) => {
              // 目录重放时既有条目可能已冻结 → 跳过（其值即上次注入结果）
              if (Object.isFrozen(entry)) return;
              entry.name = model.name;
              entry.capabilities = { tools: true, input: [...model.input], output: ["text"] };
              entry.limit = { context: model.contextWindow, output: model.maxTokens };
              entry.enabled = true;
              entry.status = "active";
            });
            applied += 1;
          } catch (err) {
            logError(`[qoder-v2] failed to inject model "${model.id}" into "${target.id}":`,
              (err as Error)?.message || err);
          }
        }

        logInfo(`[qoder-v2] injected ${applied}/${catalogModels.length} models into provider "${target.id}" (region=${region})`);
      }
    });
  },
};

export default QoderPluginV2;
