import { useState, type FormEvent, type KeyboardEvent } from "react";
import { Send } from "lucide-react";
import type { SearchMode } from "../types";
import { Button } from "./ui/Button";
import { Textarea } from "./ui/Textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/Select";

interface ChatInputProps {
  onSend: (message: string, mode: SearchMode, days: number) => void;
  isLoading: boolean;
  mode: SearchMode;
  days: number;
  onModeChange: (mode: SearchMode) => void;
  onDaysChange: (days: number) => void;
}

export function ChatInput({
  onSend,
  isLoading,
  mode,
  days,
  onModeChange,
  onDaysChange,
}: ChatInputProps) {
  const [message, setMessage] = useState("");

  const submitMessage = () => {
    const trimmed = message.trim();
    if (!trimmed || isLoading) return;
    onSend(trimmed, mode, days);
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

  return (
    <div className="flex flex-col gap-4 border-t bg-card p-4">
      <div className="flex flex-col gap-4 rounded-xl border bg-background p-2">
        <form
          onSubmit={handleSubmit}
          className="flex items-end gap-2 p-1 relative"
        >
          <Textarea
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask a policy question..."
            disabled={isLoading}
            className="min-h-[56px] w-full resize-none border-0 bg-transparent px-2 py-3 text-base shadow-none focus-visible:ring-0 md:text-sm"
          />
          <Button
            type="submit"
            size="icon"
            disabled={!message.trim() || isLoading}
            className="mb-1 h-8 w-8 shrink-0 rounded-lg"
          >
            {isLoading ? (
              <div className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className="sr-only">Send message</span>
          </Button>
        </form>

        <div className="flex items-center gap-4 px-3 pb-2">
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Source
            </span>
            <Select
              value={mode}
              onValueChange={(value) => onModeChange(value as SearchMode)}
              disabled={isLoading}
            >
              <SelectTrigger className="h-8 w-[140px] text-xs">
                <SelectValue placeholder="Select Source" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="both">All Sources</SelectItem>
                <SelectItem value="regulations">Regulations.gov</SelectItem>
                <SelectItem value="govinfo">GovInfo</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="h-4 w-px bg-border" />
          <div className="flex items-center gap-2">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Time
            </span>
            <Select
              value={String(days)}
              onValueChange={(value) => onDaysChange(Number(value))}
              disabled={isLoading}
            >
              <SelectTrigger className="h-8 w-[80px] text-xs">
                <SelectValue placeholder="Select Time" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="7">7d</SelectItem>
                <SelectItem value="30">30d</SelectItem>
                <SelectItem value="60">60d</SelectItem>
                <SelectItem value="90">90d</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
      <p className="text-center text-xs text-muted-foreground">
        Disclaimer: This is not legal advice. Please verify all information with
        official sources.
      </p>
    </div>
  );
}
