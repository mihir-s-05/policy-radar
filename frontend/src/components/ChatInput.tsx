import { useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Check, Feather, Square } from "lucide-react";
import type { SourceSelection } from "../types";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/Select";
import { Popover, PopoverContent, PopoverTrigger } from "./ui/Popover";
import { cn } from "../lib/utils";

interface ChatInputProps {
  onSend: (message: string, sources: SourceSelection, days: number, model: string) => void;
  isLoading: boolean;
  isBusy?: boolean;
  onStop?: () => void;
  sources: SourceSelection;
  days: number;
  model: string;
  availableModels: string[];
  onSourcesChange: (sources: SourceSelection) => void;
  onDaysChange: (days: number) => void;
  onModelChange: (model: string) => void;
  settingsModal?: ReactNode;
  embeddingModal?: ReactNode;
}

const SOURCE_OPTIONS: { key: keyof SourceSelection; label: string }[] = [
  { key: "regulations", label: "Regulations.gov" },
  { key: "govinfo", label: "GovInfo" },
  { key: "congress", label: "Congress.gov" },
  { key: "federal_register", label: "Federal Register" },
  { key: "usaspending", label: "USAspending" },
  { key: "fiscal_data", label: "Treasury Fiscal" },
  { key: "datagov", label: "data.gov" },
  { key: "doj", label: "DOJ" },
  { key: "searchgov", label: "Search.gov" },
];

const STORAGE_KEY = "policy-radar-sources";

function loadSourcesFromStorage(): SourceSelection {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Partial<SourceSelection>;
      const isMigrationFromManual = typeof parsed.auto !== "boolean";
      if (isMigrationFromManual) {
        return {
          auto: true,
          govinfo: true,
          regulations: true,
          congress: true,
          federal_register: true,
          usaspending: true,
          fiscal_data: true,
          datagov: true,
          doj: true,
          searchgov: true,
        };
      }
      return {
        auto: parsed.auto ?? true,
        govinfo: parsed.govinfo ?? true,
        regulations: parsed.regulations ?? true,
        congress: parsed.congress ?? true,
        federal_register: parsed.federal_register ?? true,
        usaspending: parsed.usaspending ?? true,
        fiscal_data: parsed.fiscal_data ?? true,
        datagov: parsed.datagov ?? true,
        doj: parsed.doj ?? true,
        searchgov: parsed.searchgov ?? true,
      };
    }
  } catch {
  }
  return {
    auto: true,
    govinfo: true,
    regulations: true,
    congress: true,
    federal_register: true,
    usaspending: true,
    fiscal_data: true,
    datagov: true,
    doj: true,
    searchgov: true,
  };
}

function saveSourcesToStorage(sources: SourceSelection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sources));
  } catch {
  }
}

export function ChatInput({
  onSend,
  isLoading,
  isBusy = false,
  onStop,
  sources,
  days,
  model,
  availableModels,
  onSourcesChange,
  onDaysChange,
  onModelChange,
  settingsModal,
  embeddingModal,
}: ChatInputProps) {
  const [message, setMessage] = useState("");

  const enabledCount = SOURCE_OPTIONS.filter((opt) => sources[opt.key]).length;
  const archivesLabel = sources.auto
    ? `Auto (${enabledCount} allowed)`
    : `${enabledCount} selected`;

  const submitMessage = () => {
    const trimmed = message.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed, sources, days, model);
    setMessage("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitMessage();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submitMessage();
    }
  };

  const toggleSource = (key: keyof SourceSelection) => {
    const newSources = { ...sources, [key]: !sources[key] };
    onSourcesChange(newSources);
    saveSourcesToStorage(newSources);
  };

  const toggleAuto = () => {
    const newSources = { ...sources, auto: !sources.auto };
    onSourcesChange(newSources);
    saveSourcesToStorage(newSources);
  };

  return (
    <div className="flex flex-col gap-4 border-t border-sepia-light/30 bg-card p-4">
      <div className="parchment-bg aged-edge flex flex-col gap-4 rounded-lg p-3">
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-3 p-1 relative">

          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Compose your inquiry..."
            disabled={isBusy}
            className="min-h-[56px] w-full resize-none border-0 bg-transparent px-3 py-3 text-base shadow-none focus-visible:ring-0 md:text-sm ink-text"
            style={{ fontFamily: "'IM Fell English', serif" }}
          />
          <Button
            type={isLoading ? "button" : "submit"}
            size="icon"
            onClick={isLoading ? onStop : undefined}
            disabled={isLoading ? !onStop : !message.trim() || isBusy}
            className="h-10 w-10 shrink-0 rounded-full btn-wax self-center">

            {isLoading ? (
              <Square className="h-4 w-4" />
            ) : (
              <Feather className="h-4 w-4" />
            )}
            <span className="sr-only">{isLoading ? "Stop response" : "Send message"}</span>
          </Button>
        </form>

        <div className="flex items-center gap-4 px-3 pb-2">
          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider ink-faded"
              style={{ fontFamily: "'IM Fell English SC', serif" }}
            >
              Archives
            </span>
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-8 w-[140px] justify-between text-xs btn-parchment"
                  disabled={isBusy}
                >
                  <span style={{ fontFamily: "'Spectral', serif" }}>{archivesLabel}</span>
                  <ChevronDown className="ml-2 h-3 w-3 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-48 p-0 parchment-bg border-sepia-light/50" align="start">
                <div className="max-h-64 overflow-y-auto p-1">
                  <button
                    type="button"
                    onClick={toggleAuto}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-parchment-300/50 ink-text",
                      sources.auto && "font-medium"
                    )}
                    style={{ fontFamily: "'IM Fell English', serif" }}
                  >
                    <div className={cn(
                      "flex h-4 w-4 items-center justify-center rounded-sm border",
                      sources.auto
                        ? "border-sepia-brown bg-sepia-brown text-parchment-100"
                        : "border-sepia-light/50"
                    )}>
                      {sources.auto && <Check className="h-3 w-3" />}
                    </div>
                    Auto (model chooses)
                  </button>

                  <div className="my-1 h-px bg-sepia-light/30" />

                  {SOURCE_OPTIONS.map((opt) => (
                    <button
                      key={opt.key}
                      type="button"
                      onClick={() => toggleSource(opt.key)}
                      className={cn(
                        "flex w-full items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none hover:bg-parchment-300/50 ink-text",
                        sources[opt.key] && "font-medium"
                      )}
                      style={{ fontFamily: "'IM Fell English', serif" }}
                    >
                      <div className={cn(
                        "flex h-4 w-4 items-center justify-center rounded-sm border",
                        sources[opt.key]
                          ? "border-sepia-brown bg-sepia-brown text-parchment-100"
                          : "border-sepia-light/50"
                      )}>
                        {sources[opt.key] && <Check className="h-3 w-3" />}
                      </div>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </PopoverContent>
            </Popover>
          </div>

          <div className="h-4 w-px bg-sepia-light/30" />

          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider ink-faded"
              style={{ fontFamily: "'IM Fell English SC', serif" }}
            >
              Period
            </span>
            <Select
              value={String(days)}
              onValueChange={(value) => onDaysChange(Number(value))}
              disabled={isBusy}
            >
              <SelectTrigger className="h-8 w-[80px] text-xs btn-parchment border-sepia-light/50">
                <SelectValue placeholder="Select Time" />
              </SelectTrigger>
              <SelectContent className="parchment-bg border-sepia-light/50">
                <SelectItem value="7" style={{ fontFamily: "'Spectral', serif" }}>7 days</SelectItem>
                <SelectItem value="30" style={{ fontFamily: "'Spectral', serif" }}>30 days</SelectItem>
                <SelectItem value="60" style={{ fontFamily: "'Spectral', serif" }}>60 days</SelectItem>
                <SelectItem value="90" style={{ fontFamily: "'Spectral', serif" }}>90 days</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="h-4 w-px bg-sepia-light/30" />

          <div className="flex items-center gap-2">
            <span
              className="text-[10px] font-semibold uppercase tracking-wider ink-faded"
              style={{ fontFamily: "'IM Fell English SC', serif" }}
            >
              Scribe
            </span>
            <Select
              value={model}
              onValueChange={onModelChange}
              disabled={isBusy}
            >
              <SelectTrigger className="h-8 w-[120px] text-xs btn-parchment border-sepia-light/50">
                <SelectValue placeholder="Select Model" />
              </SelectTrigger>
              <SelectContent className="parchment-bg border-sepia-light/50">
                {availableModels.map((m) => (
                  <SelectItem key={m} value={m} style={{ fontFamily: "'Spectral', serif" }}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {embeddingModal && (
            <>
              <div className="h-4 w-px bg-sepia-light/30" />
              {embeddingModal}
            </>
          )}

          {settingsModal && (
            <>
              <div className="h-4 w-px bg-sepia-light/30" />
              {settingsModal}
            </>
          )}
        </div>
      </div>
      <p
        className="text-center text-xs ink-faded"
        style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
      >
        Nota bene: This correspondence is not legal counsel. Kindly verify all information with
        official sources.
      </p>
    </div>
  );
}

export { loadSourcesFromStorage, saveSourcesToStorage };
