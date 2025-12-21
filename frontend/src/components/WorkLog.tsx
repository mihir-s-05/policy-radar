import { useState } from "react";
import { Brain, ChevronDown, ChevronRight, Check, AlertTriangle, Loader2, Activity } from "lucide-react";
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
          step.status === "running" && "bg-zinc-100 border-zinc-100 text-zinc-950 animate-pulse",
          step.status === "done" && "bg-zinc-800 border-zinc-700 text-zinc-300",
          step.status === "error" && "bg-red-950/20 border-red-900/50 text-red-500"
        )}>
          {step.status === "running" && <Loader2 className="h-3 w-3 animate-spin" />}
          {step.status === "done" && <Check className="h-3 w-3" />}
          {step.status === "error" && <AlertTriangle className="h-3 w-3" />}
        </div>
        <div className="w-px flex-1 bg-border my-1" />
      </div>

      <div className="flex-1 pb-4">
        <div
          className="flex cursor-pointer items-center gap-2 py-0.5"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <span className="text-xs font-semibold leading-none">{step.label}</span>
          <span className="text-muted-foreground hover:text-foreground">
            {isExpanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
          </span>
        </div>

        {isExpanded && (
          <div className="mt-2 rounded-md border bg-zinc-900/50 p-3 text-xs">
            <div className="mb-2 grid grid-cols-[auto_1fr] gap-2">
              <span className="font-semibold text-muted-foreground">Tool:</span>
              <code className="rounded bg-background px-1 py-0.5 font-mono text-muted-foreground">
                {step.tool_name}
              </code>
            </div>

            {Object.keys(step.args).length > 0 && (
              <div className="mb-2">
                <span className="mb-1 block font-semibold text-muted-foreground">Arguments:</span>
                <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-muted-foreground">
                  {JSON.stringify(step.args, null, 2)}
                </pre>
              </div>
            )}

            {step.result_preview && (
              <div>
                <span className="mb-1 block font-semibold text-muted-foreground">Result:</span>
                <pre className="overflow-x-auto rounded-md bg-background p-2 font-mono text-muted-foreground">
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
      <div className="flex flex-col items-center justify-center p-8 text-center text-muted-foreground">
        <div className="mb-2 rounded-full bg-muted p-3">
          <Activity className="h-5 w-5 opacity-50" />
        </div>
        <p className="text-sm">Agent activity will appear here.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="border-b bg-card px-4 py-3">
        <h3 className="text-sm font-semibold">Work Log</h3>
      </div>

      <div className="custom-scrollbar flex-1 overflow-y-auto p-4">
        {reasoningSummary && (
          <div className="mb-6 rounded-lg border border-zinc-800 bg-zinc-900/30">
            <button
              className="flex w-full items-center justify-between px-3 py-2 text-left"
              onClick={() => setIsReasoningExpanded(!isReasoningExpanded)}
            >
              <div className="flex items-center gap-2 text-sm font-medium text-zinc-300">
                <Brain className="h-4 w-4" />
                <span>Reasoning</span>
              </div>
              {isReasoningExpanded ? <ChevronDown className="h-4 w-4 text-zinc-500" /> : <ChevronRight className="h-4 w-4 text-zinc-500" />}
            </button>

            {isReasoningExpanded && (
              <div className="border-t border-zinc-800 px-3 py-2 text-sm text-zinc-400">
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
