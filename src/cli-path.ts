/**
 * cli-path.ts — 按区域解析 qodercli / qodercn 的运行时路径
 *
 * opencode 使用 Bun 运行时，SDK 默认的 WorkerTransport 在 Bun 下不兼容
 * （Worker Thread 无法正确启动 qoder-worker-runtime）。
 *
 * 解决方案：强制使用 ProcessTransport，指向 CLI 包内的 **JS 版 bundle**
 * （global: bundle/qodercli.js，cn: bundle/qoderclicn.js），让 Bun/Node 作为解释器运行它。
 *
 * 为什么必须按区域分开（实测）：
 *   npm 上的 `@qoder-ai/qodercli` 是 **global 构建** —— 区域在构建期写死
 *   （bundle 内可见 `"cn"==(<site>)`，site 常量为 "global"），它会把 access token
 *   exchange 到全球 openapi。拿 CN 账号的 PAT 去跑它，qodercli 直接返回
 *     {"type":"result","subtype":"error_during_execution","is_error":true,
 *      "errors":["The provided access token was rejected by the API"],
 *      "terminal_reason":"access_token_invalid"}
 *   CN 账号必须用 CN 版 CLI：npm 包 `@qodercn-ai/qoderclicn`（bundle/qoderclicn.js），
 *   或安装脚本 https://static.qoder.com.cn/qoder-cli-cn/install.sh 装出的 `qodercn`。
 */
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { logInfo, logError } from "./logger.js";
import type { QoderRegion } from "./models.js";

interface CliFlavor {
  /** 提供 CLI bundle 的 npm 包名 */
  readonly npmPackage: string;
  /** 包内 JS bundle 的相对路径 */
  readonly bundlePath: string;
  /** 兜底：PATH 上的可执行文件名 */
  readonly command: string;
  /** 该区域专属的显式覆盖环境变量 */
  readonly envVar: string;
}

const FLAVORS: Record<QoderRegion, CliFlavor> = {
  global: {
    npmPackage: "@qoder-ai/qodercli",
    bundlePath: "bundle/qodercli.js",
    command: "qodercli",
    envVar: "QODER_GLOBAL_CLI_PATH",
  },
  cn: {
    npmPackage: "@qodercn-ai/qoderclicn",
    bundlePath: "bundle/qoderclicn.js",
    command: "qoderclicn",
    envVar: "QODER_CN_CLI_PATH",
  },
};

const cache = new Map<string, string>();

/**
 * 解析指定区域的 CLI 绝对路径。
 *
 * 搜索策略（按优先级）：
 * 1. 区域专属环境变量（cn: QODER_CN_CLI_PATH / global: QODER_GLOBAL_CLI_PATH）
 * 2. QODER_CLI_PATH（跨区域通用覆盖，保留原有行为）
 * 3. import.meta.url 相对路径查找 node_modules（ESM 模式，两级嵌套）
 * 4. createRequire.resolve
 * 5. 兜底：PATH 上的命令名（cn: qoderclicn —— 绝不回退到全局 qodercli）
 */
export function resolveQoderCliPath(region: string = "global"): string {
  const key = region === "cn" ? "cn" : "global";
  const cached = cache.get(key);
  if (cached) return cached;

  const flavor = FLAVORS[key];

  // 1 & 2. 环境变量覆盖（区域专属优先于通用）
  for (const envKey of [flavor.envVar, "QODER_CLI_PATH"]) {
    const envPath = process.env[envKey];
    if (envPath && existsSync(envPath)) {
      logInfo(`resolveQoderCliPath(${key}): using ${envKey}=${envPath}`);
      cache.set(key, envPath);
      return envPath;
    }
  }

  // 3. 从当前模块位置向上查找 node_modules
  try {
    // fileURLToPath 才能在 Windows 上正确处理 file:///C:/... （
    // pathname 在 Windows 会产生 /C:/... 前导斜杠导致 existsSync 失败）
    const currentDir = dirname(fileURLToPath(import.meta.url));
    const [scope, name] = flavor.npmPackage.split("/");
    const candidates = [
      // bundle 后位于 dist/，node_modules 在上级（插件包根）
      join(currentDir, "..", "node_modules", scope, name, flavor.bundlePath),
      // 向上两级（嵌套安装）
      join(currentDir, "..", "..", "node_modules", scope, name, flavor.bundlePath),
    ];
    for (const candidate of candidates) {
      if (existsSync(candidate)) {
        logInfo(`resolveQoderCliPath(${key}): found at ${candidate}`);
        cache.set(key, candidate);
        return candidate;
      }
    }
  } catch {
    // import.meta.url 不可用，继续尝试其他方式
  }

  // 4. createRequire.resolve（ESM 中替代 require.resolve）
  try {
    const require = createRequire(import.meta.url);
    const resolved = require.resolve(`${flavor.npmPackage}/${flavor.bundlePath}`);
    if (existsSync(resolved)) {
      logInfo(`resolveQoderCliPath(${key}): require.resolve found ${resolved}`);
      cache.set(key, resolved);
      return resolved;
    }
  } catch {
    // 模块不可解析
  }

  // 5. 兜底：假设在 PATH 中能找到对应区域的命令
  const fallback = flavor.command;
  logError(
    `resolveQoderCliPath(${key}): could not resolve ${flavor.npmPackage}/${flavor.bundlePath}, ` +
      `falling back to "${fallback}" on PATH` +
      (key === "cn" ? " — install it with `npm i -g @qodercn-ai/qoderclicn` or set QODER_CN_CLI_PATH" : ""),
  );
  cache.set(key, fallback);
  return fallback;
}

/** 仅供测试：清空模块级缓存 */
export function __clearCliPathCache(): void {
  cache.clear();
}
