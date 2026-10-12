
import { ExternalLink, Scroll } from "lucide-react";
import type { SourceItem } from "../types";
import { Button } from "./ui/Button";
import { cn } from "../lib/utils";

interface SourceCardsProps {
  sources: SourceItem[];
  onOpenDocument: (source: SourceItem) => void;
}

function getSourceTypeLabel(type: string): string {
  const labels: Record<string, string> = {
    regulations_document: "Regulations.gov",
    regulations_docket: "Regulations.gov Docket",
    govinfo_result: "GovInfo",
    govinfo_package: "GovInfo Package",
    congress_bill: "Congress Bill",
    congress_vote: "Congress Vote",
    federal_register: "Federal Register",
    usaspending: "USAspending",
    fiscal_data: "Treasury Fiscal Data",
    datagov: "data.gov",
    doj_press_release: "DOJ Press Release",
    searchgov: "Search.gov",
  };
  return labels[type] || type;
}

function getSourceTypeColorClass(type: string): string {
  const colors: Record<string, string> = {
    regulations_document: "bg-parchment-300/50 text-leather border-sepia-light/40",
    regulations_docket: "bg-parchment-300/50 text-leather border-sepia-light/40",
    govinfo_result: "bg-parchment-200/50 text-leather-light border-sepia-light/30",
    govinfo_package: "bg-parchment-200/50 text-leather-light border-sepia-light/30",
    congress_bill: "bg-parchment-300/60 text-sepia-brown border-sepia-accent/40",
    congress_vote: "bg-parchment-300/60 text-sepia-brown border-sepia-accent/40",
    federal_register: "bg-parchment-400/30 text-leather border-leather-light/40",
    usaspending: "bg-parchment-300/40 text-sepia-brown border-sepia-light/30",
    fiscal_data: "bg-parchment-300/40 text-sepia-brown border-sepia-light/30",
    datagov: "bg-parchment-200/40 text-leather-light border-sepia-light/25",
    doj_press_release: "bg-parchment-300/50 text-leather border-leather-light/30",
    searchgov: "bg-parchment-200/40 text-leather-light border-sepia-light/25",
  };
  return colors[type] || "bg-parchment-200/30 text-leather-light border-sepia-light/20";
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

function isPdfSource(source: SourceItem): boolean {
  if (source.pdf_url) return true;
  if (source.content_type?.toLowerCase().includes("pdf")) return true;
  if (source.url?.toLowerCase().endsWith(".pdf")) return true;
  return false;
}

function SourceCard({
  source,
  onViewDocument,
}: {
  source: SourceItem;
  onViewDocument: () => void;
}) {
  const handlePrimaryAction = onViewDocument;

  return (
    <div className="source-card parchment-bg aged-edge flex min-w-0 flex-col gap-3 rounded-lg border border-sepia-light/40 p-4 shadow-parchment transition-all hover:scale-[1.01] hover:shadow-lg">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span
          className={cn(
            "rounded-md border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
            getSourceTypeColorClass(source.source_type)
          )}
          style={{ fontFamily: "'IM Fell English SC', serif" }}
        >
          {getSourceTypeLabel(source.source_type)}
        </span>
        {source.date && (
          <span
            className="text-xs ink-faded"
            style={{ fontFamily: "'Spectral', serif" }}
          >
            {formatDate(source.date)}
          </span>
        )}
      </div>

      <h4
        className="line-clamp-2 text-sm font-semibold leading-tight tracking-tight ink-text"
        title={source.title}
        style={{ fontFamily: "'IM Fell English', serif" }}
      >
        {source.title}
      </h4>

      <div className="flex items-center gap-2 text-xs ink-faded">
        {source.agency && (
          <span
            className="font-medium"
            style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.03em" }}
          >
            {source.agency}
          </span>
        )}
      </div>

      {source.excerpt && (
        <p
          className="line-clamp-2 text-xs ink-faded"
          style={{ fontFamily: "'Spectral', serif", fontStyle: "italic" }}
        >
          {source.excerpt}
        </p>
      )}

      <div className="mt-auto flex items-center justify-between gap-2 pt-2">
        <Button
          variant="secondary"
          size="sm"
          className="h-7 w-full text-xs btn-parchment"
          onClick={handlePrimaryAction}
        >
          <span style={{ fontFamily: "'IM Fell English SC', serif" }}>
            Read document
          </span>
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 ink-faded hover:ink-text"
          asChild
        >
          <a
            href={source.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open original URL" aria-label="Open original URL"
          >
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Button>
      </div>
    </div>
  );
}

export function SourceCards({ sources, onOpenDocument }: SourceCardsProps) {
  const sortedSources = [...sources].sort((a,b) => Number(isPdfSource(b)) - Number(isPdfSource(a)));
  if (!sources.length) return <div className="source-empty flex flex-col items-center justify-center p-8 text-center"><Scroll className="mb-3 h-5 w-5 ink-faded" /><p className="text-sm ink-faded" style={{fontFamily:"'IM Fell English', serif",fontStyle:"italic"}}>Referenced documents will appear here.</p></div>;
  return <section className="source-list">
    <div className="border-b border-sepia-light/30 bg-card px-4 py-3"><h3 className="flex items-center gap-2 text-sm font-semibold ink-text" style={{fontFamily:"'IM Fell English SC', serif",letterSpacing:"0.05em"}}>Referenced Documents<span className="rounded-full parchment-bg px-2 py-0.5 text-[10px] ink-faded border border-sepia-light/30" style={{fontFamily:"'Spectral', serif"}}>{sources.length}</span></h3></div>
    <div className="source-list-content flex flex-col gap-3 p-4">{sortedSources.map((source,index) => <SourceCard key={`${source.id}-${index}`} source={source} onViewDocument={() => onOpenDocument(source)} />)}</div>
  </section>;
}
