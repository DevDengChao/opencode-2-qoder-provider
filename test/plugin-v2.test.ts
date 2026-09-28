import { describe, it, expect, vi, beforeEach } from "vitest";

// V2 插件（src/plugin-v2.ts）单元测试：用假 ctx 捕获 catalog.transform 的 draft 调用。
const mock = vi.hoisted(() => {
  process.env.QODER_LOG_FILE = "/tmp/qoder-provider-tests.log"; // 不污染真实日志
  return {
  CATALOG: [
    { id: "auto", name: "Auto · Qoder CN", reasoning: true, input: ["text"], contextWindow: 180_000, maxTokens: 32_768, sdkModelId: "auto" },
    { id: "qwen3.7-max", name: "Qwen 3.7 Max · Qoder CN", reasoning: true, input: ["text"], contextWindow: 1_000_000, maxTokens: 32_768, sdkModelId: "qmodel_latest" },
  ],
  CACHED: [
    { id: "auto", name: "Auto · Qoder CN", reasoning: true, input: ["text"], contextWindow: 180_000, maxTokens: 32_768, sdkModelId: "auto" },
  ],
  };
});

vi.mock("../src/models.js", () => ({
  fetchModelCatalog: vi.fn(async () => [...mock.CATALOG]),
  getCachedModels: vi.fn(() => [...mock.CACHED]),
  resolveRegion: (override?: string) => (String(override ?? "") === "cn" ? "cn" : "global"),
}));

import { QoderPluginV2 } from "../src/plugin-v2.js";

const QODER_PROVIDER_RECORD = {
  provider: {
    id: "qoder-cn",
    name: "Qoder CN",
    api: {
      type: "aisdk",
      package: "file:///root/workspace/my/opencode-2-qoder-provider/dist/index.js",
      settings: { region: "cn" },
    },
    request: { headers: {}, body: {} },
  },
  models: new Map<string, unknown>(),
};

const OTHER_PROVIDER_RECORD = {
  provider: {
    id: "other",
    name: "Other",
    api: { type: "aisdk", package: "@ai-sdk/openai-compatible" },
    request: { headers: {}, body: {} },
  },
  models: new Map<string, unknown>(),
};

function makeCtx(options: Record<string, unknown>, records: unknown[]) {
  const updates: Array<{ providerID: string; modelID: string; model: any }> = [];
  const draft = {
    provider: {
      list: () => records,
      get: (id: string) => (records as any[]).find((r) => r.provider.id === id),
      update: (id: string, fn: (p: any) => void) =>
        fn((records as any[]).find((r) => r.provider.id === id)?.provider),
      remove: () => {},
    },
    model: {
      get: () => undefined,
      remove: () => {},
      update: (providerID: string, modelID: string, fn: (m: any) => void) => {
        const model: any = {
          id: modelID,
          providerID,
          name: modelID,
          api: { type: "aisdk", id: modelID },
          capabilities: { tools: false, input: [], output: [] },
          request: { headers: {}, body: {} },
          variants: [],
          time: { released: 0 },
          cost: [],
          status: "active",
          enabled: false,
          limit: { context: 0, output: 0 },
        };
        fn(model);
        updates.push({ providerID, modelID, model });
      },
    },
  };
  const ctx = {
    options,
    catalog: {
      transform: async (cb: any) => { await cb(draft); },
      reload: async () => {},
    },
  };
  return { ctx, updates };
}

beforeEach(() => {
  delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
});

describe("V2 插件：catalog.transform 注入模型", () => {
  it("按 api.package 自动识别 provider，并注入目录（capabilities/limit/enabled）", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test"; // 走远端目录分支（2 个模型）
    const { ctx, updates } = makeCtx({}, [QODER_PROVIDER_RECORD]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.map((u) => u.modelID)).toEqual(["auto", "qwen3.7-max"]);
    expect(updates.every((u) => u.providerID === "qoder-cn")).toBe(true);
    expect(updates[0].model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] });
    expect(updates[0].model.limit).toEqual({ context: 180_000, output: 32_768 });
    expect(updates[0].model.enabled).toBe(true);
    expect(updates[0].model.name).toBe("Auto · Qoder CN");
    // 必须继承 provider 的 api（type/package/settings），否则新建条目会是 native
    expect(updates[0].model.api).toEqual({
      type: "aisdk",
      package: "file:///root/workspace/my/opencode-2-qoder-provider/dist/index.js",
      settings: { region: "cn" },
      id: "auto",
    });
  });

  it("options.providerID 显式指定时，即使 catalog 里还看不到该 provider 也能注入（顺序无关）", async () => {
    const { ctx, updates } = makeCtx({ providerID: "qoder-cn" }, [OTHER_PROVIDER_RECORD]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].providerID).toBe("qoder-cn");
  });

  it("非 qoder provider 不注入", async () => {
    const { ctx, updates } = makeCtx({}, [OTHER_PROVIDER_RECORD]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates).toEqual([]);
  });

  it("catalog 里没有 qoder provider 且未显式指定时安全退出", async () => {
    const { ctx, updates } = makeCtx({}, []);

    await expect((QoderPluginV2.setup as any)(ctx)).resolves.toBeUndefined();
    expect(updates).toEqual([]);
  });

  it("导出形状符合 V2 插件契约（id + setup）", () => {
    expect(QoderPluginV2.id).toBe("qoder.provider");
    expect(typeof QoderPluginV2.setup).toBe("function");
  });
});
