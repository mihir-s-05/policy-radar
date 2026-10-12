import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react";
import { ChevronDown, Check, Feather, Square, SlidersHorizontal } from "lucide-react";
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
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/Dialog";

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
  isMobile?: boolean;
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
  isMobile = false,
}: ChatInputProps) {
  const [message, setMessage] = useState("");
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [typing, setTyping] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const optionsFocusRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    if (!isMobile) { textarea.style.height = ""; return; }
    const resize = () => {
      textarea.style.height = "auto";
      const maximum = Math.min(144, (window.visualViewport?.height || window.innerHeight) * 0.25);
      textarea.style.height = `${Math.max(48, Math.min(textarea.scrollHeight, maximum))}px`;
    };
    resize();
    window.visualViewport?.addEventListener("resize", resize);
    return () => window.visualViewport?.removeEventListener("resize", resize);
  }, [message, isMobile]);

  const enabledCount = SOURCE_OPTIONS.filter((opt) => sources[opt.key]).length;
  const archivesLabel = sources.auto
    ? `Auto (${enabledCount} allowed)`
    : `${enabledCount} selected`;

  const submitMessage = () => {
    const trimmed = message.trim();
    if (!trimmed || isLoading || isBusy) return;
    onSend(trimmed, sources, days, model);
    setMessage("");
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    submitMessage();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey || (!isMobile && !e.shiftKey))) {
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
    <div data-typing={isMobile && typing} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setTyping(false); }} className="research-composer flex shrink-0 flex-col gap-4 border-t border-sepia-light/30 bg-card p-4">
      <div className="parchment-bg aged-edge flex flex-col gap-4 rounded-lg p-3">
        <form
          onSubmit={handleSubmit}
          className="flex items-center gap-3 p-1 relative">

          <Textarea
            ref={textareaRef}
            id="inquiry-input"
            aria-label="Inquiry"
            rows={isMobile ? 1 : 2}
            onFocus={() => setTyping(true)}
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

        {isMobile && <div className="mobile-composer-actions"><Button ref={optionsFocusRef} variant="ghost" type="button" disabled={isBusy} onClick={() => setOptionsOpen(true)}><SlidersHorizontal className="h-4 w-4" /><span>Research options</span><ChevronDown className="h-3 w-3" /></Button><span className="mobile-model-label" title={model}>{model}</span></div>}
        <Dialog open={isMobile && optionsOpen} onOpenChange={setOptionsOpen}>
          <DialogContent className="research-options-dialog parchment-bg" onCloseAutoFocus={event => { event.preventDefault(); optionsFocusRef.current?.focus(); }}>
            <DialogHeader><DialogTitle>Research options</DialogTitle><DialogDescription className="sr-only">Choose sources, a time period, and your chat model.</DialogDescription></DialogHeader>
            <div className="research-options-body">
              <label className="option-label">Period<Select value={String(days)} onValueChange={value => onDaysChange(Number(value))}><SelectTrigger aria-label="Research period"><SelectValue /></SelectTrigger><SelectContent>{[7,30,60,90].map(day => <SelectItem key={day} value={String(day)}>{day} days</SelectItem>)}</SelectContent></Select></label>
              <label className="option-label">Chat model<Select value={model} onValueChange={onModelChange}><SelectTrigger aria-label="Chat model"><SelectValue /></SelectTrigger><SelectContent>{availableModels.map(value => <SelectItem key={value} value={value}>{value}</SelectItem>)}</SelectContent></Select></label>
              <div className="option-label">Sources<Button variant="outline" aria-pressed={sources.auto} onClick={toggleAuto} className="justify-start gap-2 btn-parchment"><span className="source-check">{sources.auto && <Check className="h-4 w-4" />}</span>Auto-select sources</Button></div>
              <div className="source-options-grid">{SOURCE_OPTIONS.map(option => <Button key={option.key} variant="outline" className="btn-parchment" aria-pressed={sources[option.key]} onClick={() => toggleSource(option.key)}><span className="source-check">{sources[option.key] && <Check className="h-4 w-4" />}</span>{option.label}</Button>)}</div>
              {embeddingModal}
            </div>
          </DialogContent>
        </Dialog>
        <div className="research-controls desktop-research-controls flex flex-wrap items-center gap-4 px-3 pb-2">
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
        className="composer-note text-center text-xs ink-faded"
        style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
      >
        Nota bene: This correspondence is not legal counsel. Kindly verify all information with
        official sources.
      </p>
    </div>
  );
}

export { loadSourcesFromStorage, saveSourcesToStorage };
