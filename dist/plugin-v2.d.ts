interface V2ModelInfo {
    id?: string;
    modelID?: string;
    providerID?: string;
    name?: string;
    capabilities?: {
        tools: boolean;
        input: string[];
        output: string[];
    };
    limit?: {
        context: number;
        input?: number;
        output: number;
    };
    enabled?: boolean;
    status?: string;
}
/** 2.0.18 的 model draft */
interface V2ModelDraft {
    update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void;
    provider?: {
        list?(): readonly unknown[];
    };
}
/** 早期 V2 beta 的 catalog draft */
interface V2CatalogDraft {
    readonly provider: {
        list(): readonly unknown[];
    };
    readonly model: {
        update(providerID: string, modelID: string, update: (model: V2ModelInfo) => void): void;
    };
}
export interface V2PluginContext {
    readonly options?: Record<string, unknown>;
    /** 2.0.18+ */
    readonly model?: {
        transform(callback: (draft: V2ModelDraft) => Promise<void> | void): Promise<unknown>;
    };
    /** 早期 beta / 兼容 */
    readonly catalog?: {
        transform(callback: (draft: V2CatalogDraft) => Promise<void> | void): Promise<unknown>;
    };
}
export interface QoderV2PluginOptions {
    /** 显式指定 provider ID；不填则按包规格自动识别 */
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
