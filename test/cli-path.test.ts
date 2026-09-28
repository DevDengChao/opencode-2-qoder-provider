import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * cli-path 解析测试。
 *
 * 背景（实测）：npm 上的 @qoder-ai/qodercli 是 **global 构建**（区域在构建期就写死为
 * "global"，见 bundle 内 `"cn"==(<site>)` 常量），CN 账号的 PAT 会被它 exchange 到
 * 全球 openapi，直接报 `access_token_invalid`。CN 账号必须用 CN 版 CLI
 * （npm 包 @qodercn-ai/qoderclicn，或安装脚本装出的 qodercn）。
 * 因此解析必须按区域走：global → @qoder-ai/qodercli，cn → @qodercn-ai/qoderclicn。
 */
const cacheBuster = async () => {
  vi.resetModules(); // 每次都拿新的模块实例，避免命中模块级缓存
  return import("../src/cli-path.js");
};

const ENV_KEYS = ["QODER_CLI_PATH", "QODER_CN_CLI_PATH"] as const;

describe("resolveQoderCliPath", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "qoder-cli-path-"));
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const k of ENV_KEYS) delete process.env[k];
  });

  it("global：QODER_CLI_PATH 显式覆盖优先", async () => {
    const fake = join(dir, "qodercli.js");
    writeFileSync(fake, "// fake");
    process.env.QODER_CLI_PATH = fake;

    const { resolveQoderCliPath } = await cacheBuster();
    expect(resolveQoderCliPath("global")).toBe(fake);
  });

  it("cn：QODER_CN_CLI_PATH 优先于 QODER_CLI_PATH", async () => {
    const cn = join(dir, "qoderclicn.js");
    const global = join(dir, "qodercli.js");
    writeFileSync(cn, "// cn");
    writeFileSync(global, "// global");
    process.env.QODER_CLI_PATH = global;
    process.env.QODER_CN_CLI_PATH = cn;

    const { resolveQoderCliPath } = await cacheBuster();
    expect(resolveQoderCliPath("cn")).toBe(cn);
    expect(resolveQoderCliPath("global")).toBe(global);
  });

  it("cn：CN 包不可解析时回退到 CN 命令名（绝不回退到全局 qodercli）", async () => {
    const { resolveQoderCliPath } = await cacheBuster();
    const resolved = resolveQoderCliPath("cn");

    // 本仓库 node_modules 里没有 @qodercn-ai/qoderclicn（CN CLI 由用户自行安装），
    // 因此这里应当是命令名兜底；若某天仓库把它装成依赖，则解析到 bundle 路径也对。
    expect(resolved === "qoderclicn" || resolved.endsWith("@qodercn-ai/qoderclicn/bundle/qoderclicn.js")).toBe(true);
    expect(resolved).not.toContain("@qoder-ai/qodercli");
  });

  it("global：默认解析到包内 bundle（存在且为 .js）", async () => {
    const { resolveQoderCliPath } = await cacheBuster();
    const resolved = resolveQoderCliPath("global");

    expect(resolved.endsWith(join("@qoder-ai", "qodercli", "bundle", "qodercli.js"))).toBe(true);
    expect(existsSync(resolved)).toBe(true);
  });

  it("缓存：同一路径重复调用返回同一值", async () => {
    const { resolveQoderCliPath } = await cacheBuster();
    expect(resolveQoderCliPath("cn")).toBe(resolveQoderCliPath("cn"));
    expect(resolveQoderCliPath("global")).toBe(resolveQoderCliPath("global"));
  });

  it("不存在的 QODER_CLI_PATH 会被忽略（回落到默认解析）", async () => {
    process.env.QODER_CLI_PATH = join(dir, "nope.js");

    const { resolveQoderCliPath } = await cacheBuster();
    const resolved = resolveQoderCliPath("global");
    expect(resolved).not.toBe(join(dir, "nope.js"));
    expect(existsSync(resolved)).toBe(true);
  });
});
