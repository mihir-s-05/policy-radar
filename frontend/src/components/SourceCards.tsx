import { useState } from "react";
import { ExternalLink, FileText, AlertTriangle, Loader2 } from "lucide-react";
import { fetchContent } from "../api/client";
import type { SourceItem } from "../types";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "./ui/Dialog";
import { cn } from "../lib/utils";

interface SourceCardsProps {
  sources: SourceItem[];
}

function getSourceTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    regulations_document: "Regulations.gov",
    regulations_docket: "Regulations.gov Docket",
    govinfo_result: "GovInfo",
    govinfo_package: "GovInfo Package",
  };
  return labels[type] || type;
}

function getSourceTypeColorClass(type: string): string {
  const colors: Record<string, string> = {
    regulations_document: "bg-zinc-500/10 text-zinc-100 border-zinc-500/20",
    regulations_docket: "bg-zinc-500/10 text-zinc-300 border-zinc-500/20",
    govinfo_result: "bg-zinc-500/10 text-zinc-200 border-zinc-500/20",
    govinfo_package: "bg-zinc-500/10 text-zinc-400 border-zinc-500/20",
  };
  return colors[type] || "bg-zinc-800/50 text-zinc-500 border-zinc-800";
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  return date.toLocaleDateString("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function SourceCard({
  source,
  onView,
}: {
  source: SourceItem;
  onView: () => void;
}) {
  return (
    <div className="bg-metal-brushed flex flex-col gap-3 rounded-lg border border-black/20 p-4 shadow-lg transition-all hover:scale-[1.01] hover:shadow-xl">
      <div className="flex items-center justify-between">
        <span
          className={cn(
            "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            getSourceTypeColorClass(source.source_type)
          )}
        >
          {getSourceTypeLabel(source.source_type)}
        </span>
        {source.date && (
          <span className="text-xs text-muted-foreground">
            {formatDate(source.date)}
          </span>
        )}
      </div>

      <h4
        className="line-clamp-2 text-sm font-semibold leading-tight tracking-tight"
        title={source.title}
      >
        {source.title}
      </h4>

      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {source.agency && <span className="font-medium">{source.agency}</span>}
      </div>

      {source.excerpt && (
        <p className="line-clamp-2 text-xs text-muted-foreground/80">
          {source.excerpt}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 w-full text-xs"
          onClick={onView}
        >
          View Content
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 text-muted-foreground"
          asChild
        >
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open original URL"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

export function SourceCards({ sources }: SourceCardsProps) {
  const [contentState, setContentState] = useState<{
    isOpen: boolean;
    isLoading: boolean;
    url: string;
    title?: string | null;
    text?: string | null;
    error?: string | null;
  } | null>(null);

  const handleViewContent = async (source: SourceItem) => {
    setContentState({
      isOpen: true,
      isLoading: true,
      url: source.url,
      title: source.title,
      text: null,
      error: null,
    });

    try {
      const response = await fetchContent({
        url: source.url,
        full_text: true,
      });

      setContentState((prev) => {
        if (!prev || prev.url !== source.url) {
          return prev;
        }
        return {
          ...prev,
          isLoading: false,
          title: response.title || source.title,
          text: response.full_text,
          error: response.error,
        };
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to fetch content";
      setContentState((prev) => {
        if (!prev || prev.url !== source.url) {
          return prev;
        }
        return {
          ...prev,
          isLoading: false,
          error: message,
        };
      });
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open) {
      setContentState(null);
    }
  };

  if (sources.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <div className="mb-2 rounded-full bg-muted p-3">
          <FileText className="h-5 w-5 opacity-50" />
        </div>
        <p className="text-sm">Relevant documents will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b bg-card px-4 py-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          Sources
          <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
            {sources.length}
          </span>
        </h3>
      </div>
      <div className="custom-scrollbar flex-1 overflow-y-auto p-4">
        <div className="flex flex-col gap-3">
          {sources.map((source, index) => (
            <SourceCard
              key={`${source.id}-${index}`}
              source={source}
              onView={() => handleViewContent(source)}
            />
          ))}
        </div>
      </div>

      <Dialog
        open={!!contentState?.isOpen}
        onOpenChange={handleOpenChange}
      >
        <DialogContent className="max-h-[85vh] max-w-2xl overflow-hidden p-0 sm:max-w-3xl">
          <DialogHeader className="border-b p-6">
            <div className="flex items-start justify-between gap-4">
              <div className="space-y-1 pr-8">
                <DialogTitle className="line-clamp-2 text-lg">
                  {contentState?.title || "Document Content"}
                </DialogTitle>
                {contentState?.url && (
                  <DialogDescription className="line-clamp-1 w-full max-w-md break-all">
                    <a
                      href={contentState.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="hover:text-primary hover:underline"
                    >
                      {contentState.url}
                    </a>
                  </DialogDescription>
                )}
              </div>
            </div>
          </DialogHeader>

          <div className="custom-scrollbar flex-1 overflow-y-auto p-6">
            {contentState?.isLoading ? (
              <div className="flex h-60 flex-col items-center justify-center gap-4 text-muted-foreground">
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
                <p>Extracting content from source...</p>
              </div>
            ) : contentState?.error ? (
              <div className="flex h-60 flex-col items-center justify-center gap-4 text-destructive">
                <AlertTriangle className="h-8 w-8" />
                <p className="text-center">{contentState.error}</p>
              </div>
            ) : contentState?.text ? (
              <div className="prose prose-sm prose-invert max-w-none">
                <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed text-muted-foreground">
                  {contentState.text}
                </pre>
              </div>
            ) : (
              <div className="flex h-60 items-center justify-center text-muted-foreground">
                No extracted text available.
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  );
}
