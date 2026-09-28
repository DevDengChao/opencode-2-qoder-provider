/**
 * catalog-loader.ts — V1（plugin.ts）与 V2（plugin-v2.ts）两个插件入口共用的
 * 模型目录加载逻辑，避免两份实现漂移。
 *
 * - resolvePat     PAT 解析：options.apiKey → 区域专属 env → 全局 env
 * - loadCatalog    带超时的目录抓取；无 PAT 或失败时回退本地缓存/静态表
 * - isQoderPackage 用包规格字符串识别"是不是本包声明的 provider"
 *   （V1 用 config.provider[].npm，V2 用 catalog provider 的 api.package；
 *    两者都可能是 npm 名 / github: 规格 / file:// 绝对路径，因此不能硬编码仓库名）
 */
import { resolveRegion, type QoderModelDef, type QoderRegion } from "./models.js";
export type LoaderOptions = Record<string, any> | undefined;
/** 超时包装：给远端抓取兜底，避免拖慢宿主启动 */
export declare function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T>;
/** PAT 解析：options.apiKey → 区域专属 env → 全局 env */
export declare function resolvePat(options: LoaderOptions, region: QoderRegion): string;
/**
 * 获取当前区域的模型目录。
 * fetchModelCatalog 在缓存新鲜（<1h）时不发起网络请求；缓存过期时走远端，
 * 整体限时 8s（避免拖慢宿主启动），失败/超时回退到本地缓存或静态列表。
 */
export declare function loadCatalog(options: LoaderOptions, region: QoderRegion, timeoutMs?: number): Promise<QoderModelDef[]>;
/**
 * 包规格识别：兼容
 *  - `opencode-qoder-provider`（上游包名）
 *  - `opencode-2-qoder-provider`（本 fork 的仓库目录名）
 *  - `github:<owner>/<repo>` 与 `file:///abs/path/...` 规格
 * 旧实现硬编码 `includes("opencode-qoder-provider")`，导致 fork 路径（`opencode-2-…`）
 * 匹配失败 → provider 已声明但模型列表恒为空。
 */
export declare function isQoderPackage(spec: unknown): boolean;
export { resolveRegion };
