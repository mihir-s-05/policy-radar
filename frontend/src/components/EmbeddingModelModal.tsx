import { Database } from "lucide-react";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/Dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/Select";

interface EmbeddingModelModalProps {
  provider: string;
  model: string;
  availableModels: string[];
  onModelChange: (model: string) => void;
  disabled?: boolean;
}

export function EmbeddingModelModal({
  provider,
  model,
  availableModels,
  onModelChange,
  disabled = false,
}: EmbeddingModelModalProps) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="embedding-control h-8 min-w-0 btn-parchment border-sepia-light/50 text-xs"
          disabled={disabled}
        >
          <Database className="mr-1 h-3.5 w-3.5 shrink-0" />
          <span className="truncate" style={{ fontFamily: "'Spectral', serif" }}>
            Embeddings: {model || "Select"}
          </span>
        </Button>
      </DialogTrigger>
      <DialogContent className="parchment-bg border-sepia-light/50 max-w-md">
        <DialogHeader>
          <DialogTitle
            className="ink-text"
            style={{ fontFamily: "'IM Fell English SC', serif", letterSpacing: "0.05em" }}
          >
            Embedding Model
          </DialogTitle>
          <DialogDescription className="sr-only">Select the model used to search PDF content.</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p
            className="text-xs ink-faded"
            style={{ fontFamily: "'IM Fell English', serif", fontStyle: "italic" }}
          >
            Provider: {provider}
          </p>

          {availableModels.length > 0 ? (
            <Select value={model} onValueChange={onModelChange}>
              <SelectTrigger className="w-full btn-parchment border-sepia-light/50">
                <SelectValue placeholder="Select embedding model" />
              </SelectTrigger>
              <SelectContent className="parchment-bg border-sepia-light/50">
                {availableModels.map((m) => (
                  <SelectItem key={m} value={m} style={{ fontFamily: "'Spectral', serif" }}>
                    {m}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : (
            <p className="text-sm ink-faded italic">No embedding models available</p>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
