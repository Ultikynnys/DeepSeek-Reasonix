import {
  ANTIGRAVITY_MODELS,
  GPT56_MODELS,
  OPENCODE_MODELS,
  SUPPORTED_OFFICIAL_MODELS,
  ZAI_MODELS,
  isUsableAntigravityModel,
  modelAcceptsImages,
} from "@reasonix/core-utils";

export type ModelCatalogGroupKey =
  | "deepseek"
  | "openai"
  | "zai"
  | "opencode"
  | "custom"
  | "antigravity";

export const MODEL_CATALOG_GROUP_LABELS = {
  deepseek: "composer.modelDeepSeekGroup",
  openai: "composer.modelOpenAIGroup",
  zai: "composer.modelZaiGroup",
  opencode: "composer.modelOpencodeGroup",
  custom: "composer.modelCustomGroup",
  antigravity: "composer.modelAntigravityGroup",
} as const satisfies Record<ModelCatalogGroupKey, string>;

export interface ModelCatalogGroup {
  key: ModelCatalogGroupKey;
  models: readonly string[];
}

export interface ModelCatalogOptions {
  discoveredAntigravityModels?: readonly string[];
  customModels?: readonly string[];
  opencodeModels?: readonly string[];
  includeAntigravity?: boolean;
  ollamaVisionModels?: ReadonlySet<string>;
  opencodeVisionModels?: ReadonlySet<string>;
}

export interface ModelCatalogView {
  groups: ModelCatalogGroup[];
  knownModelIds: ReadonlySet<string>;
  customModelIds: string[];
  antigravityModelIds: string[];
  acceptsImages(model: string | undefined | null): boolean;
}

/** Derive model membership and capabilities once for every desktop picker.
 * Provider identity is never inferred from an id: Antigravity membership comes
 * only from the built-in catalog or daemon-discovered model ids. */
export function deriveModelCatalog(options: ModelCatalogOptions): ModelCatalogView {
  const antigravityModelIds = Array.from(
    new Set([
      ...(options.discoveredAntigravityModels?.filter(isUsableAntigravityModel) ?? []),
      ...ANTIGRAVITY_MODELS,
    ]),
  );
  const opencodeModels =
    options.opencodeModels && options.opencodeModels.length > 0
      ? options.opencodeModels
      : OPENCODE_MODELS;
  const knownModelIds = new Set([
    ...SUPPORTED_OFFICIAL_MODELS,
    ...GPT56_MODELS,
    ...ZAI_MODELS,
    ...opencodeModels,
    ...antigravityModelIds,
  ]);
  const customModelIds = (options.customModels ?? []).filter((id) => !knownModelIds.has(id));
  const includeAntigravity =
    options.includeAntigravity === true ||
    (options.customModels ?? []).some((id) => ANTIGRAVITY_MODELS.includes(id));
  const groups: ModelCatalogGroup[] = [
    { key: "deepseek", models: SUPPORTED_OFFICIAL_MODELS },
    { key: "openai", models: GPT56_MODELS },
    { key: "zai", models: ZAI_MODELS },
    { key: "opencode", models: opencodeModels },
    ...(customModelIds.length > 0 ? [{ key: "custom" as const, models: customModelIds }] : []),
    ...(includeAntigravity ? [{ key: "antigravity" as const, models: antigravityModelIds }] : []),
  ];

  return {
    groups,
    knownModelIds,
    customModelIds,
    antigravityModelIds,
    acceptsImages: (model) =>
      modelAcceptsImages(model, options.ollamaVisionModels, options.opencodeVisionModels),
  };
}
