import { describe, it, expect, vi, beforeEach } from "vitest";

// V2 插件（src/plugin-v2.ts）单元测试：假 ctx 复现 opencode 2.0.18 的真实 draft 形态
// （ctx.model.transform + draft.update(providerID, modelID, fn)，upsert 语义）。
const mock = vi.hoisted(() => {
  process.env.QODER_LOG_FILE = "/tmp/qoder-provider-tests.log"; // 不污染真实日志
  return {
    order: [] as string[],
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
  fetchModelCatalog: vi.fn(async () => {
    mock.order.push("fetch");
    return [...mock.CATALOG];
  }),
  getCachedModels: vi.fn(() => {
    mock.order.push("cache");
    return [...mock.CACHED];
  }),
  resolveRegion: (override?: string) => (String(override ?? "") === "cn" ? "cn" : "global"),
}));

import { QoderPluginV2 } from "../src/plugin-v2.js";

// 2.0.18：包规格直接挂在 provider 上（package / settings）
const QODER_PROVIDER_206 = {
  provider: {
    id: "qoder-cn",
    name: "Qoder CN",
    package: "file:///root/workspace/my/opencode-2-qoder-provider/dist/index.js",
    settings: { region: "cn" },
  },
  models: new Map<string, unknown>(),
};

// 早期 beta：包规格在 api 里
const QODER_PROVIDER_LEGACY = {
  provider: {
    id: "qoder-cn",
    name: "Qoder CN",
    api: { type: "aisdk", package: "github:DevDengChao/opencode-2-qoder-provider", settings: { region: "cn" } },
  },
  models: new Map<string, unknown>(),
};

const OTHER_PROVIDER = {
  provider: { id: "other", name: "Other", package: "@ai-sdk/openai-compatible" },
  models: new Map<string, unknown>(),
};

/** 假 draft：记录每次 update 的 entry 快照 */
function makeDraft(records: unknown[], opts: { frozen?: boolean; throwOn?: string } = {}) {
  const updates: Array<{ providerID: string; modelID: string; model: any }> = [];
  const update = (providerID: string, modelID: string, fn: (m: any) => void) => {
    if (opts.throwOn === modelID) throw new Error("[Immer] This object has been frozen and should not be mutated");
    const model: any = {
      id: modelID,
      modelID,
      providerID,
      name: modelID,
      capabilities: { tools: false, input: [], output: [] },
      limit: { context: 0, output: 0 },
      enabled: false,
      status: "active",
    };
    if (opts.frozen) Object.freeze(model);
    fn(model);
    if (!opts.frozen) updates.push({ providerID, modelID, model });
  };
  const draft = {
    list: () => [],
    get: () => undefined,
    update,
    remove: () => {},
    provider: {
      list: () => records,
      get: (id: string) => (records as any[]).find((r) => r.provider.id === id),
    },
  };
  return { draft, updates };
}

/** opencode 2.0.18 形态：ctx.model.transform */
function makeCtx2(options: Record<string, unknown>, records: unknown[], opts: { frozen?: boolean; throwOn?: string } = {}) {
  const { draft, updates } = makeDraft(records, opts);
  return {
    updates,
    ctx: {
      options,
      model: {
        transform: async (cb: any) => {
          mock.order.push("transform");
          await cb(draft);
        },
      },
    },
  };
}

/** 早期 beta 形态：ctx.catalog.transform + draft.model.update */
function makeCtxLegacy(options: Record<string, unknown>, records: unknown[]) {
  const { draft, updates } = makeDraft(records);
  return {
    updates,
    ctx: {
      options,
      catalog: {
        transform: async (cb: any) => {
          await cb({ provider: { list: () => records }, model: { update: draft.update } });
        },
      },
    },
  };
}

beforeEach(() => {
  delete process.env.QODERCN_PERSONAL_ACCESS_TOKEN;
  delete process.env.QODER_PERSONAL_ACCESS_TOKEN;
});

describe("V2 插件（opencode 2.0.18：ctx.model.transform）", () => {
  it("按 provider.package 自动识别，并注入目录（name/capabilities/limit/enabled/status）", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test"; // 走远端目录分支（2 个模型）
    const { ctx, updates } = makeCtx2({}, [QODER_PROVIDER_206]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.map((u) => u.modelID)).toEqual(["auto", "qwen3.7-max"]);
    expect(updates.every((u) => u.providerID === "qoder-cn")).toBe(true);
    expect(updates[0].model.name).toBe("Auto · Qoder CN");
    expect(updates[0].model.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] });
    expect(updates[0].model.limit).toEqual({ context: 180_000, output: 32_768 });
    expect(updates[0].model.enabled).toBe(true);
    expect(updates[0].model.status).toBe("active");
  });

  it("早期 beta 的 api.package 规格同样被识别", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test";
    const { ctx, updates } = makeCtx2({}, [QODER_PROVIDER_LEGACY]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.length).toBe(2);
    expect(updates[0].providerID).toBe("qoder-cn");
  });

  it("options.providerID 显式指定时，provider 尚未出现在列表里也能注入", async () => {
    const { ctx, updates } = makeCtx2({ providerID: "qoder-cn" }, [OTHER_PROVIDER]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.length).toBeGreaterThan(0);
    expect(updates[0].providerID).toBe("qoder-cn");
  });

  it("非 qoder provider 不注入；列表为空时安全退出", async () => {
    const a = makeCtx2({}, [OTHER_PROVIDER]);
    await (QoderPluginV2.setup as any)(a.ctx);
    expect(a.updates).toEqual([]);

    const b = makeCtx2({}, []);
    await expect((QoderPluginV2.setup as any)(b.ctx)).resolves.toBeUndefined();
    expect(b.updates).toEqual([]);
  });

  it("本地 CLI 上下文（只有 app/location，没有 model 命名空间）不抛错", async () => {
    const ctx: any = { app: { name: "opencode" }, location: { directory: "/tmp" } };
    await expect((QoderPluginV2.setup as any)(ctx)).resolves.toBeUndefined();
  });

  it("冻结条目上仍调 update（不抛错），但只有未冻结的条目会真正落地", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test";
    const { ctx, updates } = makeCtx2({}, [QODER_PROVIDER_206], { frozen: true });

    await (QoderPluginV2.setup as any)(ctx);

    // 假 draft 在 frozen 模式下不记录 updates（真实框架里冻结=重放，值已是上次注入结果）
    expect(updates).toEqual([]);
  });

  it("单条模型注入抛错（冻结异常）不影响其余模型", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test";
    const { ctx, updates } = makeCtx2({}, [QODER_PROVIDER_206], { throwOn: "auto" });

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.map((u) => u.modelID)).toEqual(["qwen3.7-max"]);
  });

  it("目录抓取必须在注册 transform 之前完成（draft 不能跨 await）", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test";
    mock.order.length = 0;
    const { ctx } = makeCtx2({}, [QODER_PROVIDER_206]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(mock.order).toContain("fetch");
    expect(mock.order).toContain("transform");
    expect(mock.order.indexOf("fetch")).toBeLessThan(mock.order.indexOf("transform"));
  });

  it("导出形状符合 V2 插件契约（id + setup）", () => {
    expect(QoderPluginV2.id).toBe("qoder.provider");
    expect(typeof QoderPluginV2.setup).toBe("function");
  });
});

describe("V2 插件（早期 beta：ctx.catalog.transform + draft.model.update）", () => {
  it("旧形态下同样注入", async () => {
    process.env.QODERCN_PERSONAL_ACCESS_TOKEN = "pt-test";
    const { ctx, updates } = makeCtxLegacy({}, [QODER_PROVIDER_206]);

    await (QoderPluginV2.setup as any)(ctx);

    expect(updates.map((u) => u.modelID)).toEqual(["auto", "qwen3.7-max"]);
  });
});
