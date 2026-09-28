interface V2ProviderInfo {
    id: string;
    name?: string;
    api?: {
        type?: string;
        package?: string;
        settings?: Record<string, unknown>;
    };
}
interface V2CatalogProviderRecord {
    readonly provider: V2ProviderInfo;
    readonly models: ReadonlyMap<string, unknown>;
}
interface V2ModelInfo {
    id: string;
    providerID: string;
    name: string;
    capabilities: {
        tools: boolean;
        input: string[];
        output: string[];
    };
    limit: {
        context: number;
        input?: number;
        output: number;
    };
    enabled: boolean;
}
interface V2CatalogDraft {
    readonly provider: {
        list(): readonly V2CatalogProviderRecord[];
        get(providerID: string): V2CatalogProviderRecord | undefined;
        update(providerID: string, update: (provider: V2ProviderInfo) => void): void;
        remove(providerID: string): void;
    };
    readonly model: {
        get(providerID: string, modelID: string): V2ModelInfo | undefined;
        update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void;
        remove(providerID: string, modelID: string): void;
    };
}
export interface V2PluginContext {
    readonly options?: Record<string, unknown>;
    readonly catalog: {
        transform(callback: (draft: V2CatalogDraft) => Promise<void> | void): Promise<unknown>;
        reload(): Promise<void>;
    };
}
export interface QoderV2PluginOptions {
    /** 显式指定 provider ID；不填则按 api.package 自动识别 */
    providerID?: string;
    /** 覆盖区域（global|cn），默认取 provider settings.region / QODER_REGION */
    region?: string;
    /** 覆盖 PAT，默认取 provider settings.apiKey / 环境变量 */
    apiKey?: string;
}
export declare const QoderPluginV2: {
    id: string;
    setup: (ctx: V2PluginContext) => Promise<void>;
};
export default QoderPluginV2;
