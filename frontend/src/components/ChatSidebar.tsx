import { useState } from "react";
import { Plus, Trash2, MessageSquare, Calendar, AlertTriangle, PanelLeftClose, PanelLeft } from "lucide-react";
import type { SessionInfo } from "../types";
import { Button } from "./ui/Button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogClose,
} from "./ui/Dialog";
import { cn } from "../lib/utils";

interface ChatSidebarProps {
  sessions: SessionInfo[];
  activeSessionId: string | null;
  isLoading: boolean;
  isBusy: boolean;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  onDeleteSession: (sessionId: string) => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
}

function formatTitle(session: SessionInfo): string {
  const title = session.title || session.last_message || "New chat";
  return title.length > 35 ? `${title.slice(0, 35)}...` : title;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "";
  const date = new Date(dateStr);
  const now = new Date();
  const diff = now.getTime() - date.getTime();
  const days = Math.floor(diff / (1000 * 60 * 60 * 24));

  if (days === 0) return "Today";
  if (days === 1) return "Yesterday";
  if (days < 7) return date.toLocaleDateString("en-US", { weekday: "short" });

  return date.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
  });
}

export function ChatSidebar({
  sessions,
  activeSessionId,
  isLoading,
  isBusy,
  onSelect,
  onNewChat,
  onDeleteSession,
  isCollapsed,
  onToggleCollapse,
}: ChatSidebarProps) {
  const [sessionToDelete, setSessionToDelete] = useState<string | null>(null);

  const handleDeleteClick = (e: React.MouseEvent, sessionId: string) => {
    e.stopPropagation();
    setSessionToDelete(sessionId);
  };

  const confirmDelete = () => {
    if (sessionToDelete) {
      onDeleteSession(sessionToDelete);
      setSessionToDelete(null);
    }
  };

  if (isCollapsed) {
    return (
      <>
        <aside className="bg-metal-glass flex flex-col items-center gap-2 overflow-hidden rounded-xl border border-zinc-800/50 text-card-foreground shadow-2xl py-3 transition-all duration-300">
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7"
            onClick={onToggleCollapse}
            aria-label="Expand sidebar"
          >
            <PanelLeft className="h-4 w-4" />
          </Button>
          <Button
            onClick={onNewChat}
            disabled={isBusy}
            variant="chrome"
            size="icon"
            className="h-8 w-8"
            aria-label="New Chat"
          >
            <Plus className="h-4 w-4" />
          </Button>
          <div className="mt-2 flex flex-col gap-1">
            {sessions.slice(0, 5).map((session) => {
              const isActive = session.session_id === activeSessionId;
              return (
                <Button
                  key={session.session_id}
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-8 w-8",
                    isActive && "bg-accent text-accent-foreground"
                  )}
                  onClick={() => onSelect(session.session_id)}
                  disabled={isBusy}
                  aria-label={formatTitle(session)}
                >
                  <MessageSquare className="h-4 w-4" />
                </Button>
              );
            })}
          </div>
        </aside>
      </>
    );
  }

  return (
    <>
      <aside className="bg-metal-glass flex flex-col gap-4 overflow-hidden rounded-xl border border-zinc-800/50 text-card-foreground shadow-2xl transition-all duration-300">
        <div className="flex flex-col gap-4 border-b border-white/5 p-4">
          <div className="flex items-center justify-between">
            <h3 className="text-embossed text-lg font-bold leading-none tracking-tight">
              Policy Radar
            </h3>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={onToggleCollapse}
              aria-label="Collapse sidebar"
            >
              <PanelLeftClose className="h-4 w-4" />
            </Button>
          </div>
          <Button
            onClick={onNewChat}
            disabled={isBusy}
            variant="chrome"
            className="w-full justify-start gap-2"
            size="sm"
          >
            <Plus className="h-4 w-4" />
            New Chat
          </Button>
        </div>

        <div className="flex-1 overflow-y-auto p-2">
          {isLoading ? (
            <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
              Loading...
            </div>
          ) : sessions.length === 0 ? (
            <div className="flex h-20 items-center justify-center text-sm text-muted-foreground">
              No recent chats
            </div>
          ) : (
            <div className="flex flex-col gap-1">
              <h3 className="px-2 py-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                Run History
              </h3>
              <ul className="flex flex-col gap-1">
                {sessions.map((session) => {
                  const isActive = session.session_id === activeSessionId;
                  return (
                    <li key={session.session_id} className="group relative">
                      <button
                        onClick={() => onSelect(session.session_id)}
                        disabled={isBusy}
                        className={cn(
                          "flex w-full flex-col gap-1 rounded-md px-3 py-2 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50",
                          isActive
                            ? "bg-accent text-accent-foreground"
                            : "text-muted-foreground"
                        )}
                      >
                        <div className="flex items-center gap-2">
                          <MessageSquare className="h-3 w-3 opacity-70" />
                          <span className="truncate font-medium">
                            {formatTitle(session)}
                          </span>
                        </div>
                        <div className="flex items-center gap-1 text-xs opacity-60">
                          <Calendar className="h-3 w-3" />
                          <span>
                            {formatDate(
                              session.last_message_at || session.created_at
                            )}
                          </span>
                        </div>
                      </button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="absolute right-1 top-1 h-6 w-6 opacity-0 transition-opacity group-hover:opacity-100 hover:bg-destructive hover:text-destructive-foreground focus:opacity-100"
                        onClick={(e) => handleDeleteClick(e, session.session_id)}
                        disabled={isBusy}
                        aria-label="Delete chat"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </div>
          )}
        </div>
      </aside>

      <Dialog open={!!sessionToDelete} onOpenChange={(open) => !open && setSessionToDelete(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-5 w-5 text-destructive" />
              Delete Chat
            </DialogTitle>
            <DialogDescription>
              Are you sure you want to delete this chat session? This action cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline">Cancel</Button>
            </DialogClose>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
