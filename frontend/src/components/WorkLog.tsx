import { useState } from "react";
import { BookOpen, ChevronDown, ChevronRight, Check, AlertTriangle, Loader2, Activity } from "lucide-react";
import type { Step } from "../types";
import { cn } from "../lib/utils";

interface WorkLogProps {
  steps: Step[];
  reasoningSummary: string | null;
}

function StepItem({ step }: { step: Step }) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <div className="flex gap-3">
      <div className="flex flex-col items-center">
        <div className={cn(
          "flex h-6 w-6 items-center justify-center rounded-full border text-[10px]",
          step.status === "running" && "bg-parchment-200 border-sepia-light text-sepia-brown animate-pulse",
          step.status === "done" && "bg-leather text-parchment-100 border-leather-dark",
          step.status === "error" && "bg-destructive/20 border-destructive/50 text-destructive"
        )}>
          {step.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
          {step.status === "done" && <Check className="h-3 w-3" />}
          {step.status === "error" && <AlertTriangle className="h-3 w-3" />}
        </div>
        <div className="w-px flex-1 bg-sepia-light/30 my-1" />
      </div>

      <div className="flex-1 pb-4">
        <div
          className="flex cursor-pointer items-center gap-2 py-0.5"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span
            className="text-xs font-semibold leading-none ink-text"
            style={{ fontFamily: "'IM Fell English', serif" }}
          >
            {step.label}
          </span>
          <span className="ink-faded hover:ink-text">
            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        </div>

        {isExpanded && (
          <div className="mt-2 rounded-md border border-sepia-light/30 parchment-bg p-3 text-xs">
            <div className="mb-2 grid grid-cols-[auto_1fr] gap-2">
              <span
                className="font-semibold ink-faded"
                style={{ fontFamily: "'IM Fell English SC', serif" }}
              >
                Tool:
              </span>
              <code
                className="rounded bg-parchment-200/50 px-1 py-0.5 ink-text"
                style={{ fontFamily: "'Spectral', serif", fontStyle: "italic" }}
              >
                {step.tool_name}
              </code>
            </div>

            {Object.keys(step.args).length > 0 && (
              <div className="mb-2">
                <span
                  className="mb-1 block font-semibold ink-faded"
                  style={{ fontFamily: "'IM Fell English SC', serif" }}
                >
                  Arguments:
                </span>
                <pre
                  className="overflow-x-auto rounded-md bg-parchment-200/50 p-2 ink-text"
                  style={{ fontFamily: "'Spectral', serif", fontSize: "0.75rem" }}
                >
                  {JSON.stringify(step.args, null, 2)}
                </pre>
              </div>
            )}

            {step.result_preview && (
              <div>
                <span
                  className="mb-1 block font-semibold ink-faded"
                  style={{ fontFamily: "'IM Fell English SC', serif" }}
                >
                  Result:
                </span>
                <pre
                  className="overflow-x-auto rounded-md bg-parchment-200/50 p-2 ink-text"
                  style={{ fontFamily: "'Spectral', serif", fontSize: "0.75rem" }}
                >
                  {JSON.stringify(step.result_preview, null, 2)}
                </pre>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export function WorkLog({ steps, reasoningSummary }: WorkLogProps) {
  const [isReasoningExpanded, setIsReasoningExpanded] = useState(true);

  if (steps.length === 0 && !reasoningSummary) {
    return (
      <div className="flex flex-col items-center justify-center p-8 text-center">
        <div className="mb-2 rounded-full parchment-bg p-3 border border-sepia-light/30">
          <Activity className="h-5 w-5 ink-faded opacity-50" />
        </div>
        <p
          className="text-sm ink-faded"
          style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
        >
          Scribe activity will appear here.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b border-sepia-light/30 bg-card px-4 py-3">
        <h3
          className="text-sm font-semibold ink-text"
          style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.05em" }}
        >
          Scribe's Ledger
        </h3>
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-4">
        {reasoningSummary && (
          <div className="mb-6 rounded-lg border border-sepia-light/30 parchment-bg">
            <button
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => setIsReasoningExpanded(!isReasoningExpanded)}
            >
              <div className="flex items-center gap-2 text-sm font-medium ink-text">
                <BookOpen className="h-4 w-4" />
                <span style={{ fontFamily: "'IM Fell English SC', serif" }}>Deliberation</span>
              </div>
              {isReasoningExpanded ? (
                <ChevronDown className="h-4 w-4 ink-faded" />
              ) : (
                <ChevronRight className="h-4 w-4 ink-faded" />
              )}
            </button>

            {isReasoningExpanded && (
              <div
                className="border-t border-sepia-light/30 px-3 py-2 text-sm ink-faded"
                style={{ fontFamily: "'IM Fell English', serif" }}
              >
                {reasoningSummary}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col">
          {steps.map((step) => (
            <StepItem key={step.step_id} step={step} />
          ))}
        </div>
      </div>
    </div>
  );
}
