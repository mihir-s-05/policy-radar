import { useState, useEffect, useCallback } from "react";
import { Settings, Eye, EyeOff, CheckCircle, XCircle, Plus, Trash2, X, ExternalLink, LogOut, RefreshCw } from "lucide-react";
import type {
    ApiMode,
    ModelProvider,
    CustomModelConfig,
    ProviderInfo,
    EmbeddingProvider,
    EmbeddingProviderInfo,
    OAuthTokenResponse,
} from "../types";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";
import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogTrigger,
    DialogFooter,
} from "./ui/Dialog";
import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
    SelectValue,
} from "./ui/Select";
import { validateModel, startOAuthFlow, getOAuthStatus, logoutOAuth } from "../api/client";

const SETTINGS_KEY = "policy-radar-settings";

export interface UserSettings {
    provider: ModelProvider;
    model: string;
    apiMode: ApiMode;
    apiKeys: {
        openai?: string;
        anthropic?: string;
        gemini?: string;
    };
    providerModels: {
        openai?: string[];
        anthropic?: string[];
        gemini?: string[];
    };
    customModels: CustomModelConfig[];
    embedding: EmbeddingSettings;
}

export interface EmbeddingSettings {
    provider: EmbeddingProvider;
    model: string;
    apiKeys: {
        openai?: string;
        huggingface?: string;
    };
    providerModels: {
        local?: string[];
        openai?: string[];
        huggingface?: string[];
    };
    baseUrls: {
        huggingface?: string;
    };
}

const DEFAULT_EMBEDDING_SETTINGS: EmbeddingSettings = {
    provider: "local",
    model: "sentence-transformers/all-MiniLM-L6-v2",
    apiKeys: {},
    providerModels: {},
    baseUrls: {},
};

const DEFAULT_SETTINGS: UserSettings = {
    provider: "openai",
    model: "gpt-5.2",
    apiMode: "responses",
    apiKeys: {},
    providerModels: {},
    customModels: [],
    embedding: DEFAULT_EMBEDDING_SETTINGS,
};

function loadSettings(): UserSettings {
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            return {
                ...DEFAULT_SETTINGS,
                ...parsed,
                embedding: {
                    ...DEFAULT_EMBEDDING_SETTINGS,
                    ...(parsed.embedding || {}),
                },
            };
        }
    } catch {
    }
    return DEFAULT_SETTINGS;
}

function saveSettings(settings: UserSettings): void {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
    }
}

interface SettingsModalProps {
    settings: UserSettings;
    onSettingsChange: (settings: UserSettings) => void;
    providers?: Record<string, ProviderInfo>;
    embeddingProviders?: Record<string, EmbeddingProviderInfo>;
    defaultApiMode?: ApiMode;
}

export function SettingsModal({
    settings,
    onSettingsChange,
    providers = {},
    embeddingProviders = {},
    defaultApiMode = "responses"
}: SettingsModalProps) {
    const [open, setOpen] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);
    const [showEmbeddingKey, setShowEmbeddingKey] = useState(false);
    const [activeTab, setActiveTab] = useState<"model" | "embedding">("model");

    const [newModelName, setNewModelName] = useState("");
    const [validatingModel, setValidatingModel] = useState(false);
    const [validationResult, setValidationResult] = useState<{ valid: boolean; message: string } | null>(null);

    const [newEndpointBaseUrl, setNewEndpointBaseUrl] = useState("");
    const [newEndpointModelName, setNewEndpointModelName] = useState("");
    const [newEndpointApiKey, setNewEndpointApiKey] = useState("");

    const [newEmbeddingModelName, setNewEmbeddingModelName] = useState("");
    const [embeddingValidatingModel, setEmbeddingValidatingModel] = useState(false);
    const [embeddingValidationResult, setEmbeddingValidationResult] = useState<{ valid: boolean; message: string } | null>(null);

    // OAuth state
    const [oauthStatus, setOauthStatus] = useState<OAuthTokenResponse | null>(null);
    const [oauthLoading, setOauthLoading] = useState(false);
    const [oauthError, setOauthError] = useState<string | null>(null);

    useEffect(() => {
        if (!settings.apiMode) {
            onSettingsChange({ ...settings, apiMode: defaultApiMode });
        }
    }, [settings, defaultApiMode, onSettingsChange]);

    // Fetch OAuth status when modal opens or provider changes to openai_oauth
    const fetchOAuthStatus = useCallback(async () => {
        if (settings.provider !== "openai_oauth") return;
        setOauthLoading(true);
        setOauthError(null);
        try {
            const status = await getOAuthStatus();
            setOauthStatus(status);
        } catch (error) {
            setOauthError(error instanceof Error ? error.message : "Failed to check OAuth status");
            setOauthStatus(null);
        } finally {
            setOauthLoading(false);
        }
    }, [settings.provider]);

    useEffect(() => {
        if (open && settings.provider === "openai_oauth") {
            fetchOAuthStatus();
        }
    }, [open, settings.provider, fetchOAuthStatus]);

    const handleStartOAuth = async () => {
        setOauthLoading(true);
        setOauthError(null);
        try {
            const result = await startOAuthFlow();
            // Open the authorization URL in a new window
            window.open(result.authorization_url, "_blank", "width=600,height=700");
            // Poll for status changes
            const pollInterval = setInterval(async () => {
                try {
                    const status = await getOAuthStatus();
                    if (status.authenticated) {
                        setOauthStatus(status);
                        clearInterval(pollInterval);
                        setOauthLoading(false);
                    }
                } catch {
                    // Ignore polling errors
                }
            }, 2000);
            // Stop polling after 2 minutes
            setTimeout(() => {
                clearInterval(pollInterval);
                setOauthLoading(false);
            }, 120000);
        } catch (error) {
            setOauthError(error instanceof Error ? error.message : "Failed to start OAuth flow");
            setOauthLoading(false);
        }
    };

    const handleLogoutOAuth = async () => {
        setOauthLoading(true);
        setOauthError(null);
        try {
            await logoutOAuth();
            setOauthStatus({ authenticated: false });
        } catch (error) {
            setOauthError(error instanceof Error ? error.message : "Failed to logout");
        } finally {
            setOauthLoading(false);
        }
    };

    const currentProviderInfo = providers[settings.provider];
    const currentEmbeddingProviderInfo = embeddingProviders[settings.embedding.provider];

    const getModelsForProvider = (provider: string): string[] => {
        if (provider === "custom") {
            return settings.customModels.map(m => m.model_name);
        }
        const userModels = settings.providerModels[provider as keyof typeof settings.providerModels];
        if (userModels && userModels.length > 0) {
            return userModels;
        }
        return providers[provider]?.models || [];
    };

    const availableModels = getModelsForProvider(settings.provider);

    const isUsingCustomModelList = settings.provider !== "custom" &&
        (settings.providerModels[settings.provider as keyof typeof settings.providerModels]?.length ?? 0) > 0;

    const apiKeyDetected = currentProviderInfo?.api_key_detected || false;

    const currentApiKey = settings.apiKeys[settings.provider as keyof typeof settings.apiKeys] || "";

    const getEmbeddingModelsForProvider = (provider: EmbeddingProvider): string[] => {
        const userModels = settings.embedding.providerModels[provider as keyof typeof settings.embedding.providerModels];
        if (userModels && userModels.length > 0) {
            return userModels;
        }
        return embeddingProviders[provider]?.models || [];
    };

    const embeddingAvailableModels = getEmbeddingModelsForProvider(settings.embedding.provider);

    const isUsingCustomEmbeddingList =
        (settings.embedding.providerModels[settings.embedding.provider as keyof typeof settings.embedding.providerModels]?.length ?? 0) > 0;

    const embeddingApiKeyDetected = currentEmbeddingProviderInfo?.api_key_detected || false;
    const currentEmbeddingApiKey =
        settings.embedding.apiKeys[settings.embedding.provider as keyof typeof settings.embedding.apiKeys] || "";

    const handleSave = () => {
        saveSettings(settings);
        setOpen(false);
    };

    const handleProviderChange = (value: ModelProvider) => {
        const models = getModelsForProvider(value);
        const defaultModel = models[0] || "";
        const providerInfo = providers[value];
        const defaultApiMode = providerInfo?.api_mode || "chat_completions";

        onSettingsChange({
            ...settings,
            provider: value,
            model: value === "custom"
                ? (settings.customModels[0]?.model_name || "")
                : defaultModel,
            apiMode: value === "openai" ? settings.apiMode : defaultApiMode,
        });

        setValidationResult(null);
        setNewModelName("");
    };

    const handleModelChange = (value: string) => {
        onSettingsChange({ ...settings, model: value });
    };

    const handleApiModeChange = (value: ApiMode) => {
        onSettingsChange({ ...settings, apiMode: value });
    };

    const handleApiKeyChange = (value: string) => {
        onSettingsChange({
            ...settings,
            apiKeys: {
                ...settings.apiKeys,
                [settings.provider]: value,
            },
        });
    };

    const handleEmbeddingProviderChange = (value: EmbeddingProvider) => {
        const models = getEmbeddingModelsForProvider(value);
        const defaultModel = models[0] || "";

        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                provider: value,
                model: defaultModel,
            },
        });

        setEmbeddingValidationResult(null);
        setNewEmbeddingModelName("");
    };

    const handleEmbeddingModelChange = (value: string) => {
        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                model: value,
            },
        });
    };

    const handleEmbeddingApiKeyChange = (value: string) => {
        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                apiKeys: {
                    ...settings.embedding.apiKeys,
                    [settings.embedding.provider]: value,
                },
            },
        });
    };

    const handleEmbeddingBaseUrlChange = (value: string) => {
        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                baseUrls: {
                    ...settings.embedding.baseUrls,
                    huggingface: value,
                },
            },
        });
    };

    const handleAddEmbeddingModelToProvider = async () => {
        if (!newEmbeddingModelName.trim()) return;

        const provider = settings.embedding.provider as keyof typeof settings.embedding.providerModels;
        const currentModels = settings.embedding.providerModels[provider] ||
            embeddingProviders[settings.embedding.provider]?.models || [];

        if (currentModels.includes(newEmbeddingModelName.trim())) {
            setNewEmbeddingModelName("");
            return;
        }

        if (settings.embedding.provider === "openai") {
            setEmbeddingValidatingModel(true);
            setEmbeddingValidationResult(null);
            try {
                const result = await validateModel({
                    provider: "openai",
                    model_name: newEmbeddingModelName.trim(),
                    api_key: settings.embedding.apiKeys.openai,
                });
                setEmbeddingValidationResult(result);
                if (!result.valid) {
                    return;
                }
            } catch (error) {
                setEmbeddingValidationResult({ valid: false, message: "Validation failed to run." });
                return;
            } finally {
                setEmbeddingValidatingModel(false);
            }
        }

        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                providerModels: {
                    ...settings.embedding.providerModels,
                    [provider]: [...currentModels, newEmbeddingModelName.trim()],
                },
                model: newEmbeddingModelName.trim(),
            },
        });
        setNewEmbeddingModelName("");
    };

    const handleRemoveEmbeddingModelFromProvider = (modelToRemove: string) => {
        const provider = settings.embedding.provider as keyof typeof settings.embedding.providerModels;
        const currentModels = settings.embedding.providerModels[provider] ||
            embeddingProviders[settings.embedding.provider]?.models || [];

        const newModels = currentModels.filter(m => m !== modelToRemove);

        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                providerModels: {
                    ...settings.embedding.providerModels,
                    [provider]: newModels.length > 0 ? newModels : undefined,
                },
                model: settings.embedding.model === modelToRemove ? (newModels[0] || "") : settings.embedding.model,
            },
        });
    };

    const handleResetEmbeddingProviderModels = () => {
        const provider = settings.embedding.provider as keyof typeof settings.embedding.providerModels;
        const defaultModels = embeddingProviders[settings.embedding.provider]?.models || [];

        onSettingsChange({
            ...settings,
            embedding: {
                ...settings.embedding,
                providerModels: {
                    ...settings.embedding.providerModels,
                    [provider]: undefined,
                },
                model: defaultModels[0] || "",
            },
        });
    };

    const handleValidateEmbeddingModel = async (modelName: string) => {
        if (!modelName.trim() || settings.embedding.provider !== "openai") return;

        setEmbeddingValidatingModel(true);
        setEmbeddingValidationResult(null);

        try {
            const result = await validateModel({
                provider: "openai",
                model_name: modelName,
                api_key: settings.embedding.apiKeys.openai,
            });
            setEmbeddingValidationResult(result);
        } catch (error) {
            setEmbeddingValidationResult({ valid: false, message: "Validation failed to run." });
        } finally {
            setEmbeddingValidatingModel(false);
        }
    };

    const handleAddModelToProvider = async () => {
        if (!newModelName.trim() || settings.provider === "custom") return;

        const provider = settings.provider as keyof typeof settings.providerModels;
        const currentModels = settings.providerModels[provider] ||
            providers[settings.provider]?.models || [];

        if (currentModels.includes(newModelName.trim())) {
            setNewModelName("");
            return;
        }

        if (settings.provider === "openai" || settings.provider === "anthropic" || settings.provider === "gemini") {
            setValidatingModel(true);
            setValidationResult(null);
            try {
                const result = await validateModel({
                    provider: settings.provider,
                    model_name: newModelName.trim(),
                    api_key: settings.apiKeys[settings.provider as keyof typeof settings.apiKeys],
                });
                setValidationResult(result);
                if (!result.valid) {
                    return;
                }
            } catch (error) {
                setValidationResult({ valid: false, message: "Validation failed to run." });
                return;
            } finally {
                setValidatingModel(false);
            }
        }

        onSettingsChange({
            ...settings,
            providerModels: {
                ...settings.providerModels,
                [provider]: [...currentModels, newModelName.trim()],
            },
            model: newModelName.trim(),
        });
        setNewModelName("");
    };

    const handleRemoveModelFromProvider = (modelToRemove: string) => {
        if (settings.provider === "custom") return;

        const provider = settings.provider as keyof typeof settings.providerModels;
        const currentModels = settings.providerModels[provider] ||
            providers[settings.provider]?.models || [];

        const newModels = currentModels.filter(m => m !== modelToRemove);

        onSettingsChange({
            ...settings,
            providerModels: {
                ...settings.providerModels,
                [provider]: newModels.length > 0 ? newModels : undefined,
            },
            model: settings.model === modelToRemove ? (newModels[0] || "") : settings.model,
        });
    };

    const handleValidateModel = async (modelName: string) => {
        if (!modelName.trim()) return;

        setValidatingModel(true);
        setValidationResult(null);

        try {
            const result = await validateModel({
                provider: settings.provider,
                model_name: modelName,
                api_key: settings.apiKeys[settings.provider as keyof typeof settings.apiKeys],
            });
            setValidationResult(result);
        } catch (error) {
            setValidationResult({ valid: false, message: "Validation failed to run." });
        } finally {
            setValidatingModel(false);
        }
    };

    const handleResetProviderModels = () => {
        if (settings.provider === "custom") return;

        const provider = settings.provider as keyof typeof settings.providerModels;
        const defaultModels = providers[settings.provider]?.models || [];

        onSettingsChange({
            ...settings,
            providerModels: {
                ...settings.providerModels,
                [provider]: undefined,
            },
            model: defaultModels[0] || "",
        });
    };

    const handleAddCustomEndpoint = () => {
        if (!newEndpointBaseUrl.trim() || !newEndpointModelName.trim()) return;

        const newModel: CustomModelConfig = {
            base_url: newEndpointBaseUrl.trim(),
            model_name: newEndpointModelName.trim(),
            api_key: newEndpointApiKey.trim() || undefined,
        };

        onSettingsChange({
            ...settings,
            customModels: [...settings.customModels, newModel],
            model: settings.provider === "custom" && !settings.model ? newModel.model_name : settings.model,
        });

        setNewEndpointBaseUrl("");
        setNewEndpointModelName("");
        setNewEndpointApiKey("");
    };

    const handleRemoveCustomEndpoint = (index: number) => {
        const newCustomModels = settings.customModels.filter((_, i) => i !== index);
        onSettingsChange({
            ...settings,
            customModels: newCustomModels,
            model: settings.model === settings.customModels[index]?.model_name
                ? (newCustomModels[0]?.model_name || "")
                : settings.model,
        });
    };

    const handleClearAll = () => {
        onSettingsChange(DEFAULT_SETTINGS);
        saveSettings(DEFAULT_SETTINGS);
    };

    return (
        <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild>
                <Button
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 ink-faded hover:ink-text"
                    title="Settings"
                >
                    <Settings className="h-4 w-4" />
                    <span className="sr-only">Settings</span>
                </Button>
            </DialogTrigger>
            <DialogContent className="parchment-bg border-sepia-light/50 max-w-lg max-h-[85vh] overflow-y-auto">
                <DialogHeader>
                    <DialogTitle
                        className="ink-text"
                        style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.05em" }}
                    >
                        Configuration
                    </DialogTitle>
                </DialogHeader>

                <div className="flex flex-col gap-4">
                    <div className="flex items-center gap-2">
                        <Button
                            variant="outline"
                            size="sm"
                            className={`btn-parchment text-xs ${activeTab === "model" ? "border-sepia-brown text-sepia-brown" : "border-sepia-light/50"}`}
                            onClick={() => setActiveTab("model")}
                        >
                            <span style={{ fontFamily: "'IM Fell English SC', serif" }}>Model Provider</span>
                        </Button>
                        <Button
                            variant="outline"
                            size="sm"
                            className={`btn-parchment text-xs ${activeTab === "embedding" ? "border-sepia-brown text-sepia-brown" : "border-sepia-light/50"}`}
                            onClick={() => setActiveTab("embedding")}
                        >
                            <span style={{ fontFamily: "'IM Fell English SC', serif" }}>Embeddings</span>
                        </Button>
                    </div>

                    {activeTab === "model" && (
                        <div className="flex flex-col gap-6">
                            <section className="flex flex-col gap-2">
                        <label
                            className="text-xs font-semibold uppercase tracking-wider ink-faded"
                            style={{ fontFamily: "'IM Fell English SC', serif" }}
                        >
                            Model Provider
                        </label>
                        <Select value={settings.provider} onValueChange={handleProviderChange}>
                            <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                <SelectValue placeholder="Select provider" />
                            </SelectTrigger>
                            <SelectContent className="parchment-bg border-sepia-light/50">
                                <SelectItem value="openai" style={{ fontFamily: "'Spectral', serif" }}>
                                    OpenAI
                                </SelectItem>
                                <SelectItem value="openai_oauth" style={{ fontFamily: "'Spectral', serif" }}>
                                    OpenAI (OAuth)
                                </SelectItem>
                                <SelectItem value="anthropic" style={{ fontFamily: "'Spectral', serif" }}>
                                    Anthropic
                                </SelectItem>
                                <SelectItem value="gemini" style={{ fontFamily: "'Spectral', serif" }}>
                                    Google Gemini
                                </SelectItem>
                                <SelectItem value="custom" style={{ fontFamily: "'Spectral', serif" }}>
                                    Custom Endpoint
                                </SelectItem>
                            </SelectContent>
                        </Select>
                    </section>

                    {settings.provider !== "custom" && settings.provider !== "openai_oauth" && (
                        <section className="flex flex-col gap-2">
                            <div className="flex items-center justify-between">
                                <label
                                    className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                    style={{ fontFamily: "'IM Fell English SC', serif" }}
                                >
                                    Model
                                </label>
                                {isUsingCustomModelList && (
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-6 text-xs ink-faded hover:ink-text"
                                        onClick={handleResetProviderModels}
                                    >
                                        Reset to defaults
                                    </Button>
                                )}
                            </div>

                            {availableModels.length > 0 ? (
                                <Select value={settings.model} onValueChange={handleModelChange}>
                                    <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                        <SelectValue placeholder="Select model" />
                                    </SelectTrigger>
                                    <SelectContent className="parchment-bg border-sepia-light/50">
                                        {availableModels.map((model) => (
                                            <SelectItem
                                                key={model}
                                                value={model}
                                                style={{ fontFamily: "'Spectral', serif" }}
                                            >
                                                {model}
                                            </SelectItem>
                                        ))}
                                    </SelectContent>
                                </Select>
                            ) : (
                                <p className="text-sm ink-faded italic">No models available</p>
                            )}

                            <div className="mt-2 p-3 rounded border border-sepia-light/30 bg-parchment-200/20">
                                <p
                                    className="text-xs ink-faded mb-2"
                                    style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                                >
                                    Add or remove models for this provider:
                                </p>

                                <div className="flex flex-wrap gap-1 mb-2">
                                    {availableModels.map((model) => (
                                        <span
                                            key={model}
                                            className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-parchment-200/50 border border-sepia-light/30"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        >
                                            {model}
                                            <button
                                                onClick={() => handleRemoveModelFromProvider(model)}
                                                className="p-0.5 hover:text-destructive"
                                                title="Remove model"
                                            >
                                                <X className="h-3 w-3" />
                                            </button>
                                        </span>
                                    ))}
                                </div>

                                <div className="flex gap-2">
                                    <Input
                                        type="text"
                                        value={newModelName}
                                        onChange={(e) => setNewModelName(e.target.value)}
                                        placeholder="Enter model name"
                                        className="flex-1 text-sm bg-parchment-200/50 border-sepia-light/50 ink-text"
                                        style={{ fontFamily: "'Spectral', serif" }}
                                        onKeyDown={(e) => e.key === "Enter" && handleAddModelToProvider()}
                                    />
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="btn-parchment"
                                        onClick={handleAddModelToProvider}
                                        disabled={!newModelName.trim() || validatingModel}
                                    >
                                        <Plus className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        variant="ghost"
                                        size="sm"
                                        className="h-9 px-2 text-xs ink-faded hover:ink-text"
                                        onClick={() => handleValidateModel(newModelName)}
                                        disabled={!newModelName.trim() || validatingModel}
                                        title="Check if model exists"
                                    >
                                        {validatingModel ? (
                                            <span className="animate-spin">⌛</span>
                                        ) : validationResult && newModelName ? (
                                            validationResult.valid ? <CheckCircle className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-destructive" />
                                        ) : (
                                            "Validate"
                                        )}
                                    </Button>
                                </div>
                                {validationResult && newModelName && (
                                    <p className={`text-xs mt-1 ${validationResult.valid ? "text-green-600" : "text-destructive"}`}>
                                        {validationResult.message}
                                    </p>
                                )}
                            </div>
                        </section>
                    )}

                    {settings.provider !== "custom" && settings.provider !== "openai_oauth" && (
                        <section className="flex flex-col gap-2">
                            <label
                                className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                style={{ fontFamily: "'IM Fell English SC', serif" }}
                            >
                                API Key
                            </label>

                            <div className="flex items-center gap-2">
                                {apiKeyDetected ? (
                                    <>
                                        <CheckCircle className="h-4 w-4 text-green-600" />
                                        <span
                                            className="text-sm text-green-700"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        >
                                            API key detected from environment
                                        </span>
                                    </>
                                ) : (
                                    <>
                                        <XCircle className="h-4 w-4 text-amber-600" />
                                        <span
                                            className="text-sm text-amber-700"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        >
                                            API key not detected
                                        </span>
                                    </>
                                )}
                            </div>

                            <p
                                className="text-xs ink-faded"
                                style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                            >
                                {apiKeyDetected
                                    ? "Enter a key below to override the environment key."
                                    : "Enter your API key to use this provider."}
                            </p>
                            <div className="flex gap-2">
                                <Input
                                    type={showApiKey ? "text" : "password"}
                                    value={currentApiKey}
                                    onChange={(e) => handleApiKeyChange(e.target.value)}
                                    placeholder={`${providers[settings.provider]?.display_name || settings.provider} API Key`}
                                    className="flex-1 bg-parchment-200/50 border-sepia-light/50 ink-text"
                                    style={{ fontFamily: "'Spectral', serif" }}
                                />
                                <Button
                                    variant="outline"
                                    size="icon"
                                    className="h-9 w-9 btn-parchment"
                                    onClick={() => setShowApiKey(!showApiKey)}
                                >
                                    {showApiKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                </Button>
                            </div>
                        </section>
                    )}

                    {settings.provider === "openai_oauth" && (
                        <section className="flex flex-col gap-4">
                            <label
                                className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                style={{ fontFamily: "'IM Fell English SC', serif" }}
                            >
                                OpenAI OAuth Authentication
                            </label>

                            <p
                                className="text-xs ink-faded"
                                style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                            >
                                Use your ChatGPT Plus/Pro subscription instead of API credits.
                            </p>

                            {oauthLoading ? (
                                <div className="flex items-center gap-2 p-3 rounded border border-sepia-light/30 bg-parchment-200/20">
                                    <RefreshCw className="h-4 w-4 animate-spin text-amber-600" />
                                    <span
                                        className="text-sm text-amber-700"
                                        style={{ fontFamily: "'Spectral', serif" }}
                                    >
                                        {oauthStatus?.authenticated ? "Loading..." : "Waiting for authentication..."}
                                    </span>
                                </div>
                            ) : oauthStatus?.authenticated ? (
                                <div className="flex flex-col gap-3 p-3 rounded border border-green-500/30 bg-green-50/20">
                                    <div className="flex items-center gap-2">
                                        <CheckCircle className="h-5 w-5 text-green-600" />
                                        <span
                                            className="text-sm font-medium text-green-700"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        >
                                            Authenticated
                                        </span>
                                    </div>
                                    {oauthStatus.account_email && (
                                        <p
                                            className="text-xs ink-faded"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        >
                                            Logged in as: <strong>{oauthStatus.account_email}</strong>
                                        </p>
                                    )}
                                    <div className="flex gap-2">
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="btn-parchment text-xs"
                                            onClick={fetchOAuthStatus}
                                        >
                                            <RefreshCw className="h-3.5 w-3.5 mr-1" />
                                            Refresh
                                        </Button>
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="text-xs text-red-600 border-red-300 hover:bg-red-50"
                                            onClick={handleLogoutOAuth}
                                        >
                                            <LogOut className="h-3.5 w-3.5 mr-1" />
                                            Logout
                                        </Button>
                                    </div>
                                </div>
                            ) : (
                                <div className="flex flex-col gap-3 p-3 rounded border border-sepia-light/30 bg-parchment-200/20">
                                    <div className="flex items-center gap-2">
                                        <XCircle className="h-5 w-5 text-amber-600" />
                                        <span
                                            className="text-sm text-amber-700"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        >
                                            Not authenticated
                                        </span>
                                    </div>
                                    <p
                                        className="text-xs ink-faded"
                                        style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                                    >
                                        Click below to authenticate with your OpenAI account. A new browser window will open for you to sign in.
                                    </p>
                                    <Button
                                        variant="outline"
                                        size="sm"
                                        className="btn-parchment self-start"
                                        onClick={handleStartOAuth}
                                    >
                                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                                        <span style={{ fontFamily: "'IM Fell English SC', serif" }}>
                                            Authenticate with OpenAI
                                        </span>
                                    </Button>
                                </div>
                            )}

                            {oauthError && (
                                <p className="text-xs text-red-600">
                                    {oauthError}
                                </p>
                            )}

                            {oauthStatus?.authenticated && (
                                <>
                                    <section className="flex flex-col gap-2 mt-2">
                                        <div className="flex items-center justify-between">
                                            <label
                                                className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                                style={{ fontFamily: "'IM Fell English SC', serif" }}
                                            >
                                                Model
                                            </label>
                                            {isUsingCustomModelList && (
                                                <Button
                                                    variant="ghost"
                                                    size="sm"
                                                    className="h-6 text-xs ink-faded hover:ink-text"
                                                    onClick={handleResetProviderModels}
                                                >
                                                    Reset to defaults
                                                </Button>
                                            )}
                                        </div>

                                        {availableModels.length > 0 ? (
                                            <Select value={settings.model} onValueChange={handleModelChange}>
                                                <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                                    <SelectValue placeholder="Select model" />
                                                </SelectTrigger>
                                                <SelectContent className="parchment-bg border-sepia-light/50">
                                                    {availableModels.map((model) => (
                                                        <SelectItem
                                                            key={model}
                                                            value={model}
                                                            style={{ fontFamily: "'Spectral', serif" }}
                                                        >
                                                            {model}
                                                        </SelectItem>
                                                    ))}
                                                </SelectContent>
                                            </Select>
                                        ) : (
                                            <p className="text-sm ink-faded italic">No models available</p>
                                        )}
                                    </section>

                                    <section className="flex flex-col gap-2">
                                        <label
                                            className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                            style={{ fontFamily: "'IM Fell English SC', serif" }}
                                        >
                                            API Mode
                                        </label>
                                        <p
                                            className="text-xs ink-faded"
                                            style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                                        >
                                            Responses API (newer, maintains conversation) or Chat Completions (standard).
                                        </p>
                                        <Select value={settings.apiMode} onValueChange={handleApiModeChange}>
                                            <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                                <SelectValue placeholder="Select API mode" />
                                            </SelectTrigger>
                                            <SelectContent className="parchment-bg border-sepia-light/50">
                                                <SelectItem value="responses" style={{ fontFamily: "'Spectral', serif" }}>
                                                    Responses API
                                                </SelectItem>
                                                <SelectItem value="chat_completions" style={{ fontFamily: "'Spectral', serif" }}>
                                                    Chat Completions
                                                </SelectItem>
                                            </SelectContent>
                                        </Select>
                                    </section>
                                </>
                            )}
                        </section>
                    )}

                    {settings.provider === "openai" && (
                        <section className="flex flex-col gap-2">
                            <label
                                className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                style={{ fontFamily: "'IM Fell English SC', serif" }}
                            >
                                API Mode
                            </label>
                            <p
                                className="text-xs ink-faded"
                                style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                            >
                                Responses API (newer, maintains conversation) or Chat Completions (standard).
                            </p>
                            <Select value={settings.apiMode} onValueChange={handleApiModeChange}>
                                <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                    <SelectValue placeholder="Select API mode" />
                                </SelectTrigger>
                                <SelectContent className="parchment-bg border-sepia-light/50">
                                    <SelectItem value="responses" style={{ fontFamily: "'Spectral', serif" }}>
                                        Responses API
                                    </SelectItem>
                                    <SelectItem value="chat_completions" style={{ fontFamily: "'Spectral', serif" }}>
                                        Chat Completions
                                    </SelectItem>
                                </SelectContent>
                            </Select>
                        </section>
                    )}

                    {settings.provider === "custom" && (
                        <section className="flex flex-col gap-2">
                            <label
                                className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                style={{ fontFamily: "'IM Fell English SC', serif" }}
                            >
                                Custom Endpoints
                            </label>
                            <p
                                className="text-xs ink-faded"
                                style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                            >
                                Add OpenAI-compatible endpoints (vLLM, Ollama, LM Studio, etc.)
                            </p>

                            {settings.customModels.length > 0 && (
                                <div className="flex flex-col gap-2 mb-2">
                                    {settings.customModels.map((model, index) => (
                                        <div
                                            key={index}
                                            className={`flex items-center gap-2 p-2 rounded border ${settings.model === model.model_name
                                                ? "bg-parchment-200/50 border-sepia-light"
                                                : "bg-parchment-200/30 border-sepia-light/30"
                                                }`}
                                        >
                                            <input
                                                type="radio"
                                                name="customModel"
                                                checked={settings.model === model.model_name}
                                                onChange={() => handleModelChange(model.model_name)}
                                                className="accent-amber-700"
                                            />
                                            <div className="flex-1 min-w-0">
                                                <p
                                                    className="text-sm font-medium ink-text truncate"
                                                    style={{ fontFamily: "'Spectral', serif" }}
                                                >
                                                    {model.model_name}
                                                </p>
                                                <p
                                                    className="text-xs ink-faded truncate"
                                                    style={{ fontFamily: "'IM Fell English', serif" }}
                                                >
                                                    {model.base_url}
                                                </p>
                                            </div>
                                            <Button
                                                variant="ghost"
                                                size="icon"
                                                className="h-7 w-7 text-destructive hover:bg-destructive/10"
                                                onClick={() => handleRemoveCustomEndpoint(index)}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </div>
                                    ))}
                                </div>
                            )}

                            <div className="flex flex-col gap-2 p-3 rounded border border-sepia-light/30 bg-parchment-200/20">
                                <Input
                                    type="text"
                                    value={newEndpointBaseUrl}
                                    onChange={(e) => setNewEndpointBaseUrl(e.target.value)}
                                    placeholder="Base URL (e.g., http://localhost:11434/v1)"
                                    className="bg-parchment-200/50 border-sepia-light/50 ink-text text-sm"
                                    style={{ fontFamily: "'Spectral', serif" }}
                                />
                                <Input
                                    type="text"
                                    value={newEndpointModelName}
                                    onChange={(e) => setNewEndpointModelName(e.target.value)}
                                    placeholder="Model name (e.g., llama3.2)"
                                    className="bg-parchment-200/50 border-sepia-light/50 ink-text text-sm"
                                    style={{ fontFamily: "'Spectral', serif" }}
                                />
                                <Input
                                    type="password"
                                    value={newEndpointApiKey}
                                    onChange={(e) => setNewEndpointApiKey(e.target.value)}
                                    placeholder="API Key (optional)"
                                    className="bg-parchment-200/50 border-sepia-light/50 ink-text text-sm"
                                    style={{ fontFamily: "'Spectral', serif" }}
                                />
                                <Button
                                    variant="outline"
                                    size="sm"
                                    className="btn-parchment self-start"
                                    onClick={handleAddCustomEndpoint}
                                    disabled={!newEndpointBaseUrl.trim() || !newEndpointModelName.trim()}
                                >
                                    <Plus className="h-3.5 w-3.5 mr-1" />
                                    <span style={{ fontFamily: "'IM Fell English SC', serif" }}>Add Endpoint</span>
                                </Button>
                            </div>
                        </section>
                    )}
                        </div>
                    )}

                    {activeTab === "embedding" && (
                        <div className="flex flex-col gap-6">
                            <section className="flex flex-col gap-2">
                                <label
                                    className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                    style={{ fontFamily: "'IM Fell English SC', serif" }}
                                >
                                    Embedding Provider
                                </label>
                                <Select
                                    value={settings.embedding.provider}
                                    onValueChange={handleEmbeddingProviderChange}
                                >
                                    <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                        <SelectValue placeholder="Select provider" />
                                    </SelectTrigger>
                                    <SelectContent className="parchment-bg border-sepia-light/50">
                                        <SelectItem value="local" style={{ fontFamily: "'Spectral', serif" }}>
                                            Local
                                        </SelectItem>
                                        <SelectItem value="openai" style={{ fontFamily: "'Spectral', serif" }}>
                                            OpenAI
                                        </SelectItem>
                                        <SelectItem value="huggingface" style={{ fontFamily: "'Spectral', serif" }}>
                                            Hugging Face
                                        </SelectItem>
                                    </SelectContent>
                                </Select>
                            </section>

                            <section className="flex flex-col gap-2">
                                <div className="flex items-center justify-between">
                                    <label
                                        className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                        style={{ fontFamily: "'IM Fell English SC', serif" }}
                                    >
                                        Embedding Model
                                    </label>
                                    {isUsingCustomEmbeddingList && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            className="h-6 text-xs ink-faded hover:ink-text"
                                            onClick={handleResetEmbeddingProviderModels}
                                        >
                                            Reset to defaults
                                        </Button>
                                    )}
                                </div>

                                {embeddingAvailableModels.length > 0 ? (
                                    <Select value={settings.embedding.model} onValueChange={handleEmbeddingModelChange}>
                                        <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                                            <SelectValue placeholder="Select embedding model" />
                                        </SelectTrigger>
                                        <SelectContent className="parchment-bg border-sepia-light/50">
                                            {embeddingAvailableModels.map((model) => (
                                                <SelectItem
                                                    key={model}
                                                    value={model}
                                                    style={{ fontFamily: "'Spectral', serif" }}
                                                >
                                                    {model}
                                                </SelectItem>
                                            ))}
                                        </SelectContent>
                                    </Select>
                                ) : (
                                    <p className="text-sm ink-faded italic">No embedding models available</p>
                                )}

                                <div className="mt-2 p-3 rounded border border-sepia-light/30 bg-parchment-200/20">
                                    <p
                                        className="text-xs ink-faded mb-2"
                                        style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                                    >
                                        Add or remove embedding models:
                                    </p>

                                    <div className="flex flex-wrap gap-1 mb-2">
                                        {embeddingAvailableModels.map((model) => (
                                            <span
                                                key={model}
                                                className="inline-flex items-center gap-1 px-2 py-1 text-xs rounded bg-parchment-200/50 border border-sepia-light/30"
                                                style={{ fontFamily: "'Spectral', serif" }}
                                            >
                                                {model}
                                                <button
                                                    onClick={() => handleRemoveEmbeddingModelFromProvider(model)}
                                                    className="p-0.5 hover:text-destructive"
                                                    title="Remove model"
                                                >
                                                    <X className="h-3 w-3" />
                                                </button>
                                            </span>
                                        ))}
                                    </div>

                                    <div className="flex gap-2">
                                        <Input
                                            type="text"
                                            value={newEmbeddingModelName}
                                            onChange={(e) => setNewEmbeddingModelName(e.target.value)}
                                            placeholder="Enter model name"
                                            className="flex-1 text-sm bg-parchment-200/50 border-sepia-light/50 ink-text"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                            onKeyDown={(e) => e.key === "Enter" && handleAddEmbeddingModelToProvider()}
                                        />
                                        <Button
                                            variant="outline"
                                            size="sm"
                                            className="btn-parchment"
                                            onClick={handleAddEmbeddingModelToProvider}
                                            disabled={!newEmbeddingModelName.trim() || embeddingValidatingModel}
                                        >
                                            <Plus className="h-3.5 w-3.5" />
                                        </Button>
                                        {settings.embedding.provider === "openai" && (
                                            <Button
                                                variant="ghost"
                                                size="sm"
                                                className="h-9 px-2 text-xs ink-faded hover:ink-text"
                                                onClick={() => handleValidateEmbeddingModel(newEmbeddingModelName)}
                                                disabled={!newEmbeddingModelName.trim() || embeddingValidatingModel}
                                                title="Check if model exists"
                                            >
                                                {embeddingValidatingModel ? (
                                                    <span className="animate-spin">⟳</span>
                                                ) : embeddingValidationResult && newEmbeddingModelName ? (
                                                    embeddingValidationResult.valid ? <CheckCircle className="h-4 w-4 text-green-600" /> : <XCircle className="h-4 w-4 text-destructive" />
                                                ) : (
                                                    "Validate"
                                                )}
                                            </Button>
                                        )}
                                    </div>
                                    {embeddingValidationResult && newEmbeddingModelName && (
                                        <p className={`text-xs mt-1 ${embeddingValidationResult.valid ? "text-green-600" : "text-destructive"}`}>
                                            {embeddingValidationResult.message}
                                        </p>
                                    )}
                                </div>
                            </section>

                            {settings.embedding.provider !== "local" && (
                                <section className="flex flex-col gap-2">
                                    <label
                                        className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                        style={{ fontFamily: "'IM Fell English SC', serif" }}
                                    >
                                        API Key
                                    </label>

                                    <div className="flex items-center gap-2">
                                        {embeddingApiKeyDetected ? (
                                            <>
                                                <CheckCircle className="h-4 w-4 text-green-600" />
                                                <span
                                                    className="text-sm text-green-700"
                                                    style={{ fontFamily: "'Spectral', serif" }}
                                                >
                                                    API key detected from environment
                                                </span>
                                            </>
                                        ) : (
                                            <>
                                                <XCircle className="h-4 w-4 text-amber-600" />
                                                <span
                                                    className="text-sm text-amber-700"
                                                    style={{ fontFamily: "'Spectral', serif" }}
                                                >
                                                    API key not detected
                                                </span>
                                            </>
                                        )}
                                    </div>

                                    <p
                                        className="text-xs ink-faded"
                                        style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                                    >
                                        {embeddingApiKeyDetected
                                            ? "Enter a key below to override the environment key."
                                            : "Enter your API key to use this provider."}
                                    </p>
                                    <div className="flex gap-2">
                                        <Input
                                            type={showEmbeddingKey ? "text" : "password"}
                                            value={currentEmbeddingApiKey}
                                            onChange={(e) => handleEmbeddingApiKeyChange(e.target.value)}
                                            placeholder={`${currentEmbeddingProviderInfo?.display_name || settings.embedding.provider} API Key`}
                                            className="flex-1 bg-parchment-200/50 border-sepia-light/50 ink-text"
                                            style={{ fontFamily: "'Spectral', serif" }}
                                        />
                                        <Button
                                            variant="outline"
                                            size="icon"
                                            className="h-9 w-9 btn-parchment"
                                            onClick={() => setShowEmbeddingKey(!showEmbeddingKey)}
                                        >
                                            {showEmbeddingKey ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                                        </Button>
                                    </div>
                                </section>
                            )}

                            {settings.embedding.provider === "huggingface" && (
                                <section className="flex flex-col gap-2">
                                    <label
                                        className="text-xs font-semibold uppercase tracking-wider ink-faded"
                                        style={{ fontFamily: "'IM Fell English SC', serif" }}
                                    >
                                        Inference Endpoint
                                    </label>
                                    <p
                                        className="text-xs ink-faded"
                                        style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
                                    >
                                        Optional base URL for custom Hugging Face endpoints.
                                    </p>
                                    <Input
                                        type="text"
                                        value={settings.embedding.baseUrls.huggingface || ""}
                                        onChange={(e) => handleEmbeddingBaseUrlChange(e.target.value)}
                                        placeholder={currentEmbeddingProviderInfo?.base_url || "https://api-inference.huggingface.co/pipeline/feature-extraction"}
                                        className="bg-parchment-200/50 border-sepia-light/50 ink-text text-sm"
                                        style={{ fontFamily: "'Spectral', serif" }}
                                    />
                                </section>
                            )}
                        </div>
                    )}
                </div>

                <DialogFooter className="flex flex-row justify-between items-center gap-2 pt-4 border-t border-sepia-light/30">
                    <Button
                        variant="ghost"
                        size="sm"
                        className="text-destructive hover:bg-destructive/10"
                        onClick={handleClearAll}
                    >
                        <span style={{ fontFamily: "'IM Fell English', serif" }}>Reset</span>
                    </Button>
                    <Button onClick={handleSave} className="btn-wax">
                        <span style={{ fontFamily: "'IM Fell English SC', serif" }}>Save</span>
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}

export { loadSettings, saveSettings };
