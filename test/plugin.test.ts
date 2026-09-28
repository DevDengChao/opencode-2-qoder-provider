import { describe, it, expect, vi } from "vitest";

// 特征测试（characterization test）：重构 src/plugin.ts（抽出共享 catalog 加载器）
// 之前先锁定现有行为，重构期间必须一直保持绿。
// 第 3 个用例是**真实缺陷的 RED 测试**：现实现用 `npm.includes("opencode-qoder-provider")`
// 识别 provider，而本 fork 的目录名/文件路径是 `opencode-2-qoder-provider`，匹配不上，
// 会导致"配置里声明了 provider 但模型列表永远是空的"。T5 修复后必须转绿。
const mock = vi.hoisted(() => {
  const CATALOG = [
    { id: "auto", name: "Auto · Qoder CN", reasoning: true, input: ["text"] as const, contextWindow: 180_000, maxTokens: 32_768, sdkModelId: "auto" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max · Qoder CN", reasoning: true, input: ["text"] as const, contextWindow: 1_000_000, maxTokens: 32_768, sdkModelId: "qmodel_latest" },
  ];
  return { CATALOG };
});

vi.mock("../src/models.js", () => ({
  fetchModelCatalog: vi.fn(async () => [...mock.CATALOG]),
  getCachedModels: vi.fn(() => [...mock.CATALOG]),
  resolveRegion: (override?: string) =>
    String(override ?? "") === "cn" || process.env.QODER_REGION === "cn" ? "cn" : "global",
}));

import { QoderPlugin } from "../src/plugin.js";

function fakeCtx() {
  return {
    client: { app: { log: async () => {} } },
    directory: "/tmp",
  } as any;
}

describe("V1 插件：config hook 注入模型目录", () => {
  it("按上游 npm 规格识别 qoder provider 并注入动态目录", async () => {
    const hooks: any = await QoderPlugin(fakeCtx());
    const config: any = {
      provider: {
        "qoder-cn": {
          npm: "github:wcmk21/opencode-qoder-provider",
          options: { region: "cn" },
        },
        other: { npm: "@ai-sdk/openai-compatible" },
      },
    };

    await hooks.config(config);

    const models = config.provider["qoder-cn"].models;
    expect(Object.keys(models).sort()).toEqual(["auto", "qwen3.7-max"]);
    expect(models.auto.tool_call).toBe(true);
    expect(models.auto.name).toBe("Auto · Qoder CN");
    expect(models.auto.limit).toEqual({ context: 180_000, output: 32_768 });
    expect(models["qwen3.7-max"].modalities).toEqual({ input: ["text"], output: ["text"] });
    // 非 qoder provider 不得被注入
    expect(config.provider.other.models).toBeUndefined();
  });

  it("用户显式声明的字段优先覆盖注入值", async () => {
    const hooks: any = await QoderPlugin(fakeCtx());
    const config: any = {
      provider: {
        qoder: {
          npm: "github:wcmk21/opencode-qoder-provider",
          options: {},
          models: { auto: { name: "我的 Auto" } },
        },
      },
    };

    await hooks.config(config);

    expect(config.provider.qoder.models.auto.name).toBe("我的 Auto");
    expect(config.provider.qoder.models.auto.tool_call).toBe(true);
    expect(config.provider.qoder.models["qwen3.7-max"]).toBeDefined();
  });

  it("fork 的 file:// 规格（opencode-2-qoder-provider）同样被识别", async () => {
    const hooks: any = await QoderPlugin(fakeCtx());
    const config: any = {
      provider: {
        "qoder-cn": {
          npm: "file:///root/workspace/my/opencode-2-qoder-provider/dist/index.js",
          options: { region: "cn" },
        },
      },
    };

    await hooks.config(config);

    expect(Object.keys(config.provider["qoder-cn"].models).sort()).toEqual(["auto", "qwen3.7-max"]);
  });
});
