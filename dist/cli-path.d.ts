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
export declare function resolveQoderCliPath(region?: string): string;
/** 仅供测试：清空模块级缓存 */
export declare function __clearCliPathCache(): void;
