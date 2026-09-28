import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const mock = vi.hoisted(() => {
  process.env.QODER_LOG_FILE = "/tmp/qoder-provider-tests.log"; // 不污染真实日志
  const CATALOG = [
    { id: "auto", name: "Auto · Qoder CN", reasoning: true, input: ["text"], contextWindow: 180_000, maxTokens: 32_768, sdkModelId: "auto" },
  ];
  const CACHED = [
    { id: "auto", name: "cached-auto", reasoning: true, input: ["text"], contextWindow: 1, maxTokens: 1, sdkModelId: "auto" },
  ];
  return { CATALOG, CACHED, fetch: vi.fn(async () => CATALOG), cached: vi.fn(() => CACHED) };
});

vi.mock("../src/models.js", () => ({
  fetchModelCatalog: mock.fetch,
  getCachedModels: mock.cached,
  resolveRegion: (override?: string) =>
    ["cn", "china", "qodercn", "qoder-cn"].includes(String(override ?? "").toLowerCase())
      ? "cn"
      : "global",
}));

import { isQoderPackage, loadCatalog, resolvePat, withTimeout } from "../src/catalog-loader.js";

const ENV_KEYS = ["QODERCN_PERSONAL_ACCESS_TOKEN", "QODER_PERSONAL_ACCESS_TOKEN"] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  for (const k of ENV_KEYS) delete process.env[k];
  mock.fetch.mockClear();
  mock.cached.mockClear();
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("resolvePat", () => {
  it("options.apiKey 优先级最高", () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-env";
    expect(resolvePat({ apiKey: "pt-opt" }, "cn")).toBe("pt-opt");
  });

  it("cn 区域优先 QODERCN_*，缺失时回退全局", () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn";
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global";
    expect(resolvePat(undefined, "cn")).toBe("pt-cn");

    delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
    expect(resolvePat(undefined, "cn")).toBe("pt-global");
  });

  it("global 区域只读全局变量", () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-cn";
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global";
    expect(resolvePat(undefined, "global")).toBe("pt-global");
  });

  it("都没有时返回空串", () => {
    expect(resolvePat(undefined, "cn")).toBe("");
  });
});

describe("withTimeout", () => {
  it("超时抛带 label 的错误", async () => {
    await expect(withTimeout(new Promise(() => {}), 30, "catalog fetch")).rejects.toThrow(
      /catalog fetch timed out after 30ms/,
    );
  });

  it("按时完成则透传结果", async () => {
    await expect(withTimeout(Promise.resolve(42), 1000, "x")).resolves.toBe(42);
  });
});

describe("loadCatalog", () => {
  it("有 PAT 时走远端目录", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global";
    const models = await loadCatalog({}, "global");
    expect(models.map((m) => m.id)).toEqual(["auto"]);
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });

  it("无 PAT 时直接用缓存/静态表，不发网络请求", async () => {
    const models = await loadCatalog({}, "cn");
    expect(models[0].name).toBe("cached-auto");
    expect(mock.fetch).not.toHaveBeenCalled();
  });

  it("远端失败时回退缓存", async () => {
    process.env.QODER_PERSONAL_ACCESS_TOKEN = "pt-global";
    mock.fetch.mockRejectedValueOnce(new Error("boom"));
    const models = await loadCatalog({}, "global");
    expect(models[0].name).toBe("cached-auto");
  });

  it("options.apiKey 也会被使用（无需环境变量）", async () => {
    const models = await loadCatalog({ apiKey: "pt-opt" }, "cn");
    expect(models[0].name).toBe("Auto · Qoder CN");
    expect(mock.fetch).toHaveBeenCalledTimes(1);
  });
});

describe("isQoderPackage", () => {
  it("命中 fork 名 / 上游名 / file:// 规格", () => {
    expect(isQoderPackage("file:///root/workspace/my/opencode-2-qoder-provider/dist/index.js")).toBe(true);
    expect(isQoderPackage("github:DevDengChao/opencode-2-qoder-provider")).toBe(true);
    expect(isQoderPackage("opencode-qoder-provider")).toBe(true);
    expect(isQoderPackage("github:wcmk21/opencode-qoder-provider")).toBe(true);
  });

  it("其它 provider 不命中", () => {
    expect(isQoderPackage("@ai-sdk/openai-compatible")).toBe(false);
    expect(isQoderPackage("@ai-sdk/anthropic")).toBe(false);
    expect(isQoderPackage(undefined)).toBe(false);
    expect(isQoderPackage(null)).toBe(false);
  });
});
