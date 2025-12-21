import { useState, useEffect } from "react";
import { Settings, Eye, EyeOff, CheckCircle, XCircle, Plus, Trash2, X } from "lucide-react";
import type { ApiMode, ModelProvider, CustomModelConfig, ProviderInfo } from "../types";
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
import { validateModel } from "../api/client";

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
}

const DEFAULT_SETTINGS: UserSettings = {
    provider: "openai",
    model: "gpt-5.2",
    apiMode: "responses",
    apiKeys: {},
    providerModels: {},
    customModels: [],
};

function loadSettings(): UserSettings {
    try {
        const stored = localStorage.getItem(SETTINGS_KEY);
        if (stored) {
            const parsed = JSON.parse(stored);
            return { ...DEFAULT_SETTINGS, ...parsed };
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
    defaultApiMode?: ApiMode;
}

export function SettingsModal({
    settings,
    onSettingsChange,
    providers = {},
    defaultApiMode = "responses"
}: SettingsModalProps) {
    const [open, setOpen] = useState(false);
    const [showApiKey, setShowApiKey] = useState(false);

    const [newModelName, setNewModelName] = useState("");
    const [validatingModel, setValidatingModel] = useState(false);
    const [validationResult, setValidationResult] = useState<{ valid: boolean; message: string } | null>(null);

    const [newEndpointBaseUrl, setNewEndpointBaseUrl] = useState("");
    const [newEndpointModelName, setNewEndpointModelName] = useState("");
    const [newEndpointApiKey, setNewEndpointApiKey] = useState("");

    useEffect(() => {
        if (!settings.apiMode) {
            onSettingsChange({ ...settings, apiMode: defaultApiMode });
        }
    }, [settings, defaultApiMode, onSettingsChange]);

    const currentProviderInfo = providers[settings.provider];

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

                    {settings.provider !== "custom" && (
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

                    {settings.provider !== "custom" && (
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
