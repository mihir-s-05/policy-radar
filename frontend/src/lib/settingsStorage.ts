import type { UserSettings, EmbeddingSettings } from "../components/SettingsModal";
import { DEFAULT_MODELS, MODEL_CATALOG_VERSION } from "./modelCatalog";

const SETTINGS_KEY = "policy-radar-settings";
const TAB_KEYS_KEY = "policy-radar-tab-keys";
const DEFAULT_EMBEDDING: EmbeddingSettings = {
  provider: "local", model: "sentence-transformers/all-MiniLM-L6-v2",
  apiKeys: {}, providerModels: {}, baseUrls: {},
};
export const DEFAULT_SETTINGS: UserSettings = {
  provider: "openai", model: DEFAULT_MODELS.openai[0], apiMode: "responses",
  apiKeys: {}, providerModels: {}, customModels: [], embedding: DEFAULT_EMBEDDING,
};

type TabKeys = {
  apiKeys?: UserSettings["apiKeys"];
  embeddingKeys?: EmbeddingSettings["apiKeys"];
  customKeys?: Record<string, string>;
};
let memoryKeys: TabKeys = {};

function withoutKeys(settings: UserSettings) {
  return {
    ...settings, catalogVersion: MODEL_CATALOG_VERSION, apiKeys: {},
    customModels: settings.customModels.map(item => ({ ...item, api_key: undefined })),
    embedding: { ...settings.embedding, apiKeys: {} },
  };
}

export function loadSettings(): UserSettings {
  let parsed;
  try { parsed = JSON.parse(localStorage.getItem(SETTINGS_KEY) || "null"); } catch { /* Defaults below. */ }
  let keys = memoryKeys;
  try { keys = JSON.parse(sessionStorage.getItem(TAB_KEYS_KEY) || "null") || keys; } catch { /* Memory fallback. */ }
  if (!parsed) return { ...DEFAULT_SETTINGS, apiKeys: keys.apiKeys || {}, embedding: { ...DEFAULT_EMBEDDING, apiKeys: keys.embeddingKeys || {} } };

  const currentCatalog = parsed.catalogVersion === MODEL_CATALOG_VERSION;
  const settings: UserSettings = {
    ...DEFAULT_SETTINGS, ...parsed,
    model: currentCatalog ? parsed.model : DEFAULT_MODELS[parsed.provider as keyof typeof DEFAULT_MODELS]?.[0] || DEFAULT_SETTINGS.model,
    providerModels: currentCatalog ? parsed.providerModels || {} : {},
    customModels: parsed.customModels || [],
    embedding: { ...DEFAULT_EMBEDDING, ...parsed.embedding },
  };
  // Erase legacy persisted credentials even when session storage is unavailable.
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(withoutKeys(settings))); } catch { /* Storage may be disabled. */ }
  return {
    ...settings, apiKeys: keys.apiKeys || {},
    customModels: settings.customModels.map(item => ({ ...item, api_key: keys.customKeys?.[JSON.stringify([item.base_url, item.model_name])] })),
    embedding: { ...settings.embedding, apiKeys: keys.embeddingKeys || {} },
  };
}

export function saveSettings(settings: UserSettings): void {
  memoryKeys = {
    apiKeys: settings.apiKeys, embeddingKeys: settings.embedding.apiKeys,
    customKeys: Object.fromEntries(settings.customModels.map(item => [JSON.stringify([item.base_url, item.model_name]), item.api_key || ""])),
  };
  // Independent writes: denying tab storage must never cause persistent key writes.
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(withoutKeys(settings))); } catch { /* Storage may be disabled. */ }
  try { sessionStorage.setItem(TAB_KEYS_KEY, JSON.stringify(memoryKeys)); } catch { /* Memory fallback. */ }
}
