// src/models.ts
import crypto from "node:crypto";
import { existsSync as existsSync2, mkdirSync as mkdirSync2, readFileSync, writeFileSync } from "node:fs";
import { homedir as homedir2 } from "node:os";
import { dirname, join as join2 } from "node:path";

// src/logger.ts
import { appendFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
var LOG_DIR = join(homedir(), ".local", "state", "opencode");
var LOG_FILE = join(LOG_DIR, "qoder-provider.log");
try {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });
} catch {
}
var DEBUG = !!(process.env.DEBUG || process.env.QODER_DEBUG);
function timestamp() {
  return (/* @__PURE__ */ new Date()).toISOString();
}
function write(level, args) {
  const line = `[${timestamp()}] [${level}] ${args.map((a) => {
    if (a instanceof Error) return a.stack || a.message;
    if (typeof a === "object") {
      try {
        return JSON.stringify(a);
      } catch {
        return String(a);
      }
    }
    return String(a);
  }).join(" ")}
`;
  try {
    appendFileSync(LOG_FILE, line, "utf8");
  } catch {
  }
}
function log(...args) {
  if (DEBUG) write("DEBUG", args);
}
function logError(...args) {
  write("ERROR", args);
}
function logInfo(...args) {
  write("INFO", args);
}

// src/models.ts
function safeValidateURL(url, context) {
  try {
    const parsed = new URL(url);
    log(`URL OK [${context}]:`, url);
    return parsed;
  } catch (err) {
    logError(`[qoder-models] Invalid URL [${context}]:`, url);
    logError("[qoder-models]   Error:", err.message);
    if (DEBUG && err.stack) logError(err.stack);
    throw err;
  }
}
function resolveRegion(override) {
  const env = process.env.QODER_REGION || process.env.QODER_BACKEND || process.env.QODER_MODE || "";
  const mode = (override || env).toLowerCase();
  if (["cn", "china", "qodercn", "qoder-cn"].includes(mode)) return "cn";
  return "global";
}
function getBaseUrl(region) {
  const url = region === "cn" ? "https://gateway.qoder.com.cn/" : "https://api3.qoder.sh/";
  log(`getBaseUrl(${region}):`, url);
  return url;
}
function getModelListURL(region) {
  const url = `${getBaseUrl(region)}algo/api/v2/model/list?Encode=1`;
  log(`getModelListURL(${region}):`, url);
  return url;
}
function getOpenApiUrl(region) {
  const url = region === "cn" ? "https://openapi.qoder.com.cn" : "https://openapi.qoder.sh";
  log(`getOpenApiUrl(${region}):`, url);
  return url;
}
function getExchangeURL(region) {
  const url = `${getOpenApiUrl(region)}/api/v1/jobToken/exchange`;
  log(`getExchangeURL(${region}):`, url);
  return url;
}
var CN_FRIENDLY = {
  auto: { id: "auto", name: "Auto \xB7 Qoder CN", sdkKey: "auto" },
  "qwen3.7-max": { id: "qwen3.7-max", name: "Qwen 3.7 Max \xB7 Qoder CN", sdkKey: "qmodel_latest" },
  "qwen3.7-plus": { id: "qwen3.7-plus", name: "Qwen 3.7 Plus \xB7 Qoder CN", sdkKey: "qmodel" },
  "qwen3.6-flash": { id: "qwen3.6-flash", name: "Qwen 3.6 Flash \xB7 Qoder CN", sdkKey: "q36fmodel" },
  "deepseek-v4-pro": { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro \xB7 Qoder CN", sdkKey: "dmodel" },
  "deepseek-v4-flash": { id: "deepseek-v4-flash", name: "DeepSeek V4 Flash \xB7 Qoder CN", sdkKey: "dfmodel" },
  "glm-5.2": { id: "glm-5.2", name: "GLM 5.2 \xB7 Qoder CN", sdkKey: "gm51model" },
  "kimi-k2.6": { id: "kimi-k2.6", name: "Kimi K2.6 \xB7 Qoder CN", sdkKey: "kmodel" },
  "minimax-m2.7": { id: "minimax-m2.7", name: "MiniMax M2.7 \xB7 Qoder CN", sdkKey: "mmodel" }
};
var staticGlobalModels = [
  { id: "auto", name: "Qoder Auto", reasoning: true, input: ["text", "image"], contextWindow: 18e4, maxTokens: 32768, sdkModelId: "auto" },
  { id: "ultimate", name: "Qoder Ultimate", reasoning: true, input: ["text"], contextWindow: 1e6, maxTokens: 32768, sdkModelId: "ultimate" },
  { id: "performance", name: "Qoder Performance", reasoning: true, input: ["text"], contextWindow: 1e6, maxTokens: 32768, sdkModelId: "performance" },
  { id: "efficient", name: "Qoder Efficient", reasoning: false, input: ["text"], contextWindow: 18e4, maxTokens: 32768, sdkModelId: "efficient" },
  { id: "lite", name: "Qoder Lite", reasoning: false, input: ["text"], contextWindow: 18e4, maxTokens: 32768, sdkModelId: "lite" }
];
var staticCnModels = [
  { id: "auto", name: "Auto \xB7 Qoder CN", reasoning: true, input: ["text"], contextWindow: 18e4, maxTokens: 32768, sdkModelId: "auto" }
];
function getCachePath(region) {
  return join2(
    homedir2(),
    ".opencode",
    region === "cn" ? "qoder-cn-models.json" : "qoder-models.json"
  );
}
function getCachedModels(region) {
  const p = getCachePath(region);
  if (existsSync2(p)) {
    try {
      const data = JSON.parse(readFileSync(p, "utf8"));
      if (data?.models?.length) return data.models;
    } catch {
    }
  }
  return region === "cn" ? staticCnModels : staticGlobalModels;
}
function isCacheStale(region) {
  const p = getCachePath(region);
  if (!existsSync2(p)) return true;
  try {
    const data = JSON.parse(readFileSync(p, "utf8"));
    return Date.now() - (data.updatedAt || 0) > 36e5;
  } catch {
    return true;
  }
}
function fetchWithTimeout(url, init = {}) {
  const { timeout = 1e4, ...fetchInit } = init;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...fetchInit, signal: controller.signal }).finally(() => clearTimeout(timeoutId));
}
async function exchangePatForJobToken(pat, region) {
  const exchangeURL = getExchangeURL(region);
  log("exchangePatForJobToken: exchanging PAT for jobToken at", exchangeURL);
  safeValidateURL(exchangeURL, "exchangePatForJobToken");
  let res;
  try {
    res = await fetchWithTimeout(exchangeURL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        "User-Agent": "opencode-qoder-provider",
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5"
      },
      body: JSON.stringify({ personal_token: pat })
    });
  } catch (err) {
    logError("[qoder-models] exchangePatForJobToken fetch failed:");
    logError("[qoder-models]   URL:", exchangeURL);
    logError("[qoder-models]   Error:", err.message);
    if (DEBUG && err.stack) logError(err.stack);
    throw err;
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`PAT exchange failed: ${res.status} ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  if (!data.token) throw new Error("PAT exchange returned no token");
  log("exchangePatForJobToken: success, got jobToken");
  return data.token;
}
var RSA_KEY = `-----BEGIN PUBLIC KEY-----
MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDA8iMH5c02LilrsERw9t6Pv5Nc
4k6Pz1EaDicBMpdpxKduSZu5OANqUq8er4GM95omAGIOPOh+Nx0spthYA2BqGz+l
6HRkPJ7S236FZz73In/KVuLnwI8JJ2CbuJap8kvheCCZpmAWpb/cPx/3Vr/J6I17
XcW+ML9FoCI6AOvOzwIDAQAB
-----END PUBLIC KEY-----`;
var QODER_IDE_VERSION = "1.1.3";
var QODER_CLIENT_TYPE = "5";
var QODER_DATA_POLICY = "disagree";
var QODER_LOGIN_VERSION = "v2";
var QODER_MACHINE_TYPE = "5";
var QODER_MACHINE_OS = process.platform === "win32" ? process.arch === "arm64" ? "aarch64_windows" : "x86_64_windows" : process.arch === "arm64" ? "aarch64_linux" : "x86_64_linux";
function getMachineId() {
  const paths = [
    join2(homedir2(), ".qoder", ".auth", "machine_id"),
    join2(homedir2(), ".pi", "agent", "qoder-machine-id")
  ];
  for (const p of paths) {
    if (existsSync2(p)) {
      try {
        const val = readFileSync(p, "utf8").trim();
        if (val) return val;
      } catch {
      }
    }
  }
  const newId = crypto.randomUUID();
  try {
    mkdirSync2(dirname(paths[1]), { recursive: true });
    writeFileSync(paths[1], newId, "utf8");
  } catch {
  }
  return newId;
}
function computeSigPath(urlStr) {
  const parsed = new URL(urlStr);
  let sigPath = parsed.pathname;
  if (sigPath.startsWith("/algo")) {
    sigPath = sigPath.substring("/algo".length);
  }
  return sigPath;
}
function buildAuthHeaders(body, requestURL, creds) {
  const parsed = safeValidateURL(requestURL, "buildAuthHeaders");
  const aesKey = crypto.randomUUID().replace(/-/g, "").slice(0, 16);
  const userInfo = {
    uid: creds.userID,
    security_oauth_token: creds.authToken,
    name: creds.name || "",
    aid: "",
    email: creds.email || ""
  };
  const cipher = crypto.createCipheriv("aes-128-cbc", Buffer.from(aesKey), Buffer.from(aesKey));
  const infoB64 = cipher.update(JSON.stringify(userInfo), "utf8", "base64") + cipher.final("base64");
  const cosyKey = crypto.publicEncrypt(
    { key: RSA_KEY, padding: crypto.constants.RSA_PKCS1_PADDING },
    Buffer.from(aesKey)
  ).toString("base64");
  const timestamp2 = Math.floor(Date.now() / 1e3).toString();
  const payloadB64 = Buffer.from(JSON.stringify({
    version: "v1",
    requestId: crypto.randomUUID(),
    info: infoB64,
    cosyVersion: QODER_IDE_VERSION,
    ideVersion: ""
  })).toString("base64");
  const sigPath = computeSigPath(requestURL);
  const bodyStr = body ? Buffer.isBuffer(body) ? body.toString("utf8") : body : "";
  const sig = crypto.createHash("md5").update(`${payloadB64}
${cosyKey}
${timestamp2}
${bodyStr}
${sigPath}`).digest("hex");
  const bodyHash = crypto.createHash("md5").update(body || "").digest("hex");
  const bodyLen = body ? (Buffer.isBuffer(body) ? body.length : Buffer.from(body).length).toString() : "0";
  const machineID = getMachineId();
  log("buildAuthHeaders: url=", requestURL, "sigPath=", sigPath);
  return {
    Authorization: `Bearer COSY.${payloadB64}.${sig}`,
    "Cosy-Key": cosyKey,
    "Cosy-User": creds.userID,
    "Cosy-Date": timestamp2,
    "Cosy-Version": QODER_IDE_VERSION,
    "Cosy-Machineid": machineID,
    "Cosy-Machinetoken": machineID,
    "Cosy-Machinetype": QODER_MACHINE_TYPE,
    "Cosy-Machineos": QODER_MACHINE_OS,
    "Cosy-Clienttype": QODER_CLIENT_TYPE,
    "Cosy-Clientip": "127.0.0.1",
    "Cosy-Bodyhash": bodyHash,
    "Cosy-Bodylength": bodyLen,
    "Cosy-Sigpath": sigPath,
    "Cosy-Data-Policy": QODER_DATA_POLICY,
    "Cosy-Organization-Id": "",
    "Cosy-Organization-Tags": "",
    "Login-Version": QODER_LOGIN_VERSION,
    "X-Request-Id": crypto.randomUUID()
  };
}
async function fetchModelCatalog(pat, region) {
  log("fetchModelCatalog: start, region=", region, "pat=", pat ? pat.slice(0, 4) + "..." : "(empty)");
  if (!isCacheStale(region)) {
    const cached = getCachedModels(region);
    log(`fetchModelCatalog: cache fresh (${cached.length} models), skipping remote fetch`);
    return cached;
  }
  const jobToken = await exchangePatForJobToken(pat, region);
  const openApi = getOpenApiUrl(region);
  const userInfoURL = `${openApi}/api/v1/userinfo`;
  log("fetchModelCatalog: fetching userinfo at", userInfoURL);
  safeValidateURL(userInfoURL, "fetchModelCatalog-userinfo");
  let userRes;
  try {
    userRes = await fetchWithTimeout(userInfoURL, {
      headers: {
        Authorization: `Bearer ${jobToken}`,
        Accept: "application/json",
        "User-Agent": "opencode-qoder-provider",
        "Cosy-Version": "1.0.1",
        "Cosy-ClientType": "5"
      }
    });
  } catch (err) {
    logError("[qoder-models] fetchModelCatalog userinfo fetch failed:");
    logError("[qoder-models]   URL:", userInfoURL);
    logError("[qoder-models]   Error:", err.message);
    if (DEBUG && err.stack) logError(err.stack);
    throw err;
  }
  const userInfo = userRes.ok ? await userRes.json() : {};
  const userID = userInfo?.id || userInfo?.data?.id || userInfo?.user?.id || userInfo?.uid || userInfo?.data?.uid || "unknown";
  const userName = userInfo?.name || userInfo?.data?.name || userInfo?.user?.name || "";
  const userEmail = userInfo?.email || userInfo?.data?.email || userInfo?.user?.email || "";
  log("fetchModelCatalog: userID=", userID, "name=", userName ? "(set)" : "(empty)", "email=", userEmail ? "(set)" : "(empty)");
  const modelURL = getModelListURL(region);
  log("fetchModelCatalog: fetching model list at", modelURL);
  safeValidateURL(modelURL, "fetchModelCatalog-modelList");
  const headers = buildAuthHeaders(null, modelURL, {
    userID,
    authToken: jobToken,
    name: userName,
    email: userEmail
  });
  let modelRes;
  try {
    modelRes = await fetchWithTimeout(modelURL, {
      method: "GET",
      headers: { Accept: "application/json", ...headers }
    });
  } catch (err) {
    logError("[qoder-models] fetchModelCatalog model list fetch failed:");
    logError("[qoder-models]   URL:", modelURL);
    logError("[qoder-models]   Error:", err.message);
    if (DEBUG && err.stack) logError(err.stack);
    throw err;
  }
  if (!modelRes.ok) {
    log("fetchModelCatalog: model list response not ok, status=", modelRes.status);
    return getCachedModels(region);
  }
  const data = await modelRes.json();
  const chatModels = data.chat || [];
  if (!chatModels.length) return getCachedModels(region);
  const models = [];
  for (const entry of chatModels) {
    const key = entry.key;
    if (!key || !entry.enable) continue;
    const display = entry.display_name || key;
    const isVl = entry.is_vl === true;
    const isReasoning = !!entry.is_reasoning || !!entry.thinking_config;
    let ctxLen = entry.max_input_tokens || 18e4;
    if (entry.context_config && typeof entry.context_config === "object") {
      for (const v of Object.values(entry.context_config)) {
        if (v?.token_count && v.token_count > ctxLen) ctxLen = v.token_count;
      }
    }
    const friendly = region === "cn" ? Object.values(CN_FRIENDLY).find((f) => f.sdkKey === key) : void 0;
    models.push({
      id: friendly?.id ?? key,
      name: friendly?.name ?? display,
      reasoning: isReasoning,
      input: isVl ? ["text", "image"] : ["text"],
      contextWindow: ctxLen,
      maxTokens: entry.max_output_tokens || 32768,
      sdkModelId: key
    });
  }
  if (!models.some((m) => m.id === "auto")) {
    models.unshift({
      id: "auto",
      name: region === "cn" ? "Auto \xB7 Qoder CN" : "Qoder Auto",
      reasoning: true,
      input: region === "cn" ? ["text"] : ["text", "image"],
      contextWindow: 18e4,
      maxTokens: 32768,
      sdkModelId: "auto"
    });
  }
  if (models.length > 0) {
    const cache = { updatedAt: Date.now(), models };
    try {
      const p = getCachePath(region);
      mkdirSync2(dirname(p), { recursive: true });
      writeFileSync(p, JSON.stringify(cache), "utf-8");
    } catch {
    }
  }
  log("fetchModelCatalog: done, total models=", models.length);
  return models;
}

// src/catalog-loader.ts
function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}
function resolvePat(options, region) {
  return options?.apiKey || (region === "cn" ? process.env.QODERCN_PERSONAL_ACCESS_TOKEN : void 0) || process.env.QODER_PERSONAL_ACCESS_TOKEN || "";
}
async function loadCatalog(options, region, timeoutMs = 8e3) {
  const pat = resolvePat(options, region);
  if (!pat) return getCachedModels(region);
  try {
    return await withTimeout(fetchModelCatalog(pat, region), timeoutMs, "model catalog fetch");
  } catch (err) {
    logError(
      "[qoder] model catalog fetch failed, falling back to local cache:",
      err?.message || err
    );
    return getCachedModels(region);
  }
}
function isQoderPackage(spec) {
  return typeof spec === "string" && spec.includes("qoder");
}

// src/plugin-v2.ts
var QoderPluginV2 = {
  id: "qoder.provider",
  setup: async (ctx) => {
    const options = ctx.options ?? {};
    await ctx.catalog.transform(async (catalog) => {
      const targets = [];
      if (typeof options.providerID === "string" && options.providerID.length > 0) {
        targets.push({ id: options.providerID, settings: {} });
      } else {
        for (const record of catalog.provider.list()) {
          const api = record.provider.api;
          if (!isQoderPackage(api?.package)) continue;
          targets.push({
            id: record.provider.id,
            settings: api?.settings ?? {}
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
          options.region ?? (typeof settings.region === "string" ? settings.region : void 0)
        );
        const loaderOptions = { ...settings };
        if (options.apiKey !== void 0) loaderOptions.apiKey = options.apiKey;
        const catalogModels = await loadCatalog(loaderOptions, region);
        if (catalogModels.length === 0) {
          logInfo(`[qoder-v2] no models resolved for provider "${target.id}" (region=${region})`);
          continue;
        }
        const providerApi = catalog.provider.get(target.id)?.provider.api;
        for (const model of catalogModels) {
          catalog.model.update(target.id, model.id, (entry) => {
            if (providerApi) entry.api = { ...providerApi, id: model.id };
            entry.name = model.name;
            entry.capabilities = {
              tools: true,
              input: [...model.input],
              output: ["text"]
            };
            entry.limit = { context: model.contextWindow, output: model.maxTokens };
            entry.enabled = true;
          });
        }
        logInfo(`[qoder-v2] injected ${catalogModels.length} models into provider "${target.id}" (region=${region})`);
      }
    });
  }
};
var plugin_v2_default = QoderPluginV2;
export {
  QoderPluginV2,
  plugin_v2_default as default
};
