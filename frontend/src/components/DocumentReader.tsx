import { useEffect, useMemo, useRef, useState } from "react";
import { ExternalLink, Minus, Plus } from "lucide-react";
import { fetchContent } from "../api/client";
import type { SourceItem } from "../types";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "./ui/Dialog";
import { Button } from "./ui/Button";
import { Input } from "./ui/Input";

export function DocumentReader({ source, onClose, onCloseFocus }: { source: SourceItem | null; onClose: () => void; onCloseFocus: () => void }) {
  return <Dialog open={source !== null} onOpenChange={open => { if (!open) onClose(); }}>
    <DialogContent className="document-reader parchment-bg" onCloseAutoFocus={event => { event.preventDefault(); onCloseFocus(); }}>
      {source && <ReaderContents key={source.pdf_url || source.url} source={source} />}
    </DialogContent>
  </Dialog>;
}

function ReaderContents({ source }: { source: SourceItem }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const pdfUrl = source.pdf_url || (source.content_type?.toLowerCase().includes("pdf") || source.url.endsWith(".pdf") ? source.url : null);
  const [mode, setMode] = useState<"text" | "pdf">(() => pdfUrl && !window.matchMedia("(max-width: 1023px)").matches ? "pdf" : "text");
  const [fontSize, setFontSize] = useState(16);
  const [query, setQuery] = useState("");
  const [match, setMatch] = useState(0);
  const matchRef = useRef<HTMLElement>(null);
  const url = source.pdf_url || source.url;

  useEffect(() => {
    if (!url || mode !== "text") return;
    let cancelled = false;
    fetchContent({ url, full_text: true, max_length: 500_000 }).then(document => {
      if (!cancelled) {
        if (document.error || !document.full_text) setError(document.error || "No readable text. Open the original document.");
        else setText(document.full_text);
      }
    }).catch(reason => { if (!cancelled) setError(reason instanceof Error ? reason.message : "Document could not be loaded."); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [url, mode]);

  const lower = useMemo(() => text.toLowerCase(), [text]);
  const matches = useMemo(() => {
    const term = query.trim().toLowerCase();
    if (!term) return [];
    const result: number[] = [];
    let offset = 0;
    while (result.length < 200 && (offset = lower.indexOf(term, offset)) !== -1) { result.push(offset); offset += term.length; }
    return result;
  }, [lower, query]);
  const position = matches[match % Math.max(1, matches.length)];
  const findNext = () => { setMatch(value => value + 1); requestAnimationFrame(() => matchRef.current?.scrollIntoView({ block: "center" })); };

  return <>
      <DialogHeader className="reader-header">
        <DialogTitle className="line-clamp-2 pr-10 ink-text">{source?.title || "Document"}</DialogTitle>
        <DialogDescription className="break-all text-xs"><a href={source?.url} target="_blank" rel="noopener noreferrer">{source ? new URL(source.url).hostname : ""}</a></DialogDescription>
      </DialogHeader>
      <div className="reader-toolbar">
        <Button variant="outline" aria-pressed={mode === "text"} onClick={() => { if (mode !== "text") { setLoading(true); setError(null); setMode("text"); } }}>Text</Button>
        {pdfUrl && <Button variant="outline" aria-pressed={mode === "pdf"} onClick={() => setMode("pdf")}>PDF</Button>}
        {mode === "text" && <><Button variant="ghost" size="icon" aria-label="Smaller text" disabled={fontSize <= 14} onClick={() => setFontSize(size => size - 2)}><Minus className="h-4 w-4" /></Button><Button variant="ghost" size="icon" aria-label="Larger text" disabled={fontSize >= 24} onClick={() => setFontSize(size => size + 2)}><Plus className="h-4 w-4" /></Button></>}
        <Button variant="ghost" size="icon" asChild><a href={source?.url} target="_blank" rel="noopener noreferrer" aria-label="Open original document"><ExternalLink className="h-4 w-4" /></a></Button>
      </div>
      {mode === "text" && <div className="reader-search"><Input aria-label="Find in document" placeholder="Find in document" value={query} onChange={event => { setQuery(event.target.value); setMatch(0); }} onKeyDown={event => { if (event.key === "Enter") findNext(); }} /><Button variant="outline" disabled={!matches.length} onClick={findNext}>Find</Button><span role="status">{query ? matches.length ? `${match % matches.length + 1}/${matches.length}${matches.length === 200 ? "+" : ""}` : "No match" : ""}</span></div>}
      <div className="reader-content" tabIndex={0} aria-label="Document text">
        {mode === "pdf" ? <iframe src={pdfUrl || undefined} title={source?.title || "PDF document"} className="h-full w-full border-0" /> : loading ? <p role="status">Loading document…</p> : error ? <p role="alert">{error}</p> : <div className="document-text" style={{ fontSize }}>{position === undefined ? text : <>{text.slice(0, position)}<mark ref={matchRef}>{text.slice(position, position + query.trim().length)}</mark>{text.slice(position + query.trim().length)}</>}</div>}
      </div>
  </>;
}
