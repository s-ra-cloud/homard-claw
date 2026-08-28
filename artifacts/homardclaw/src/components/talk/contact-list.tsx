import { useMemo, useState, type ReactNode } from "react";
import type { Agent } from "@workspace/api-client-react";
import { Phone, Search, X } from "lucide-react";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import { Input } from "@/components/ui/input";
import { presenceForStatus } from "./agent-presence";

/** Below this many contacts the roster fits on a phone without filtering. */
const SEARCH_THRESHOLD = 6;

export interface ContactListProps {
  agents: Agent[];
  isLoading: boolean;
  selectedId: string | null;
  onSelect: (agentId: string) => void;
  /** Settings gear, rendered into the header beside the title. */
  headerAction?: ReactNode;
  /** Voice-unavailable notice, shown under the header when present. */
  notice?: ReactNode;
}

export function ContactList({
  agents,
  isLoading,
  selectedId,
  onSelect,
  headerAction,
  notice,
}: ContactListProps) {
  const [query, setQuery] = useState("");
  const showSearch = agents.length >= SEARCH_THRESHOLD;

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle || !showSearch) return agents;
    return agents.filter((agent) =>
      `${agent.name} ${agent.title} ${agent.specialization ?? ""}`
        .toLowerCase()
        .includes(needle),
    );
  }, [agents, query, showSearch]);

  return (
    <div className="flex h-full min-h-0 flex-col bg-card">
      <div className="shrink-0 border-b-4 border-border bg-muted/30 p-4">
        <div className="flex items-center gap-3">
          <div>
            <h2 className="font-display text-sm text-primary uppercase flex items-center gap-2">
              <Phone className="w-4 h-4" aria-hidden="true" /> Contacts
            </h2>
            <p className="text-[10px] text-muted-foreground mt-1 font-mono uppercase">
              Tap a Crustabot to call — speak or type
            </p>
          </div>
          {headerAction && <div className="ml-auto">{headerAction}</div>}
        </div>

        {showSearch && (
          <div className="relative mt-3">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 w-4 h-4 -translate-y-1/2 text-muted-foreground"
              aria-hidden="true"
            />
            <Input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search contacts"
              aria-label="Search contacts"
              className="bg-background border-4 border-border rounded-none pl-9 pr-9 focus-visible:ring-0 focus-visible:border-primary font-mono text-xs uppercase"
            />
            {query && (
              <button
                type="button"
                onClick={() => setQuery("")}
                aria-label="Clear search"
                className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground"
              >
                <X className="w-4 h-4" aria-hidden="true" />
              </button>
            )}
          </div>
        )}
      </div>

      {notice && (
        <div className="shrink-0 border-b-4 border-border">{notice}</div>
      )}

      <div className="flex-1 min-h-0 overflow-y-auto">
        {isLoading ? (
          <ul className="divide-y-2 divide-border" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => (
              <li key={i} className="flex items-center gap-3 p-3 animate-pulse">
                <div className="w-12 h-12 bg-muted/60 shrink-0" />
                <div className="flex-1 space-y-2">
                  <div className="h-3 w-1/2 bg-muted/60" />
                  <div className="h-2 w-1/3 bg-muted/40" />
                </div>
              </li>
            ))}
          </ul>
        ) : visible.length === 0 ? (
          <div className="p-8 text-center space-y-3">
            <div className="flex justify-center opacity-50">
              <MarlowLobster size={88} status="idle" preset="marlow" />
            </div>
            <p className="text-xs font-mono uppercase text-muted-foreground">
              {agents.length === 0
                ? "No Crustabots to call yet — recruit one from the roster"
                : "No contact matches that search"}
            </p>
          </div>
        ) : (
          <ul className="divide-y-2 divide-border">
            {visible.map((agent) => {
              const presence = presenceForStatus(agent.status);
              const isSelected = agent.id === selectedId;
              return (
                <li key={agent.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(agent.id)}
                    aria-current={isSelected ? "true" : undefined}
                    data-testid={`contact-${agent.id}`}
                    className={`w-full flex items-center gap-3 p-3 text-left transition-colors ${
                      isSelected
                        ? "bg-primary text-primary-foreground"
                        : "hover:bg-muted/60"
                    }`}
                  >
                    <span
                      className={`shrink-0 flex items-center justify-center w-12 h-12 border-2 ${
                        isSelected
                          ? "border-primary-foreground/40"
                          : "border-border"
                      } bg-background/40 overflow-hidden`}
                    >
                      <MarlowLobster
                        size={44}
                        status={agent.status}
                        shellColor={agent.avatar.shellColor}
                        seed={agent.id}
                      />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block font-bold text-sm uppercase truncate">
                        {agent.name}
                      </span>
                      <span
                        className={`block text-[10px] font-mono uppercase truncate ${
                          isSelected
                            ? "text-primary-foreground/80"
                            : "text-muted-foreground"
                        }`}
                      >
                        {agent.title}
                      </span>
                    </span>
                    <span className="shrink-0 flex items-center gap-2 text-[10px] font-mono uppercase">
                      <span
                        className={`w-2 h-2 ${presence.dotClass} ${
                          presence.pulse ? "animate-pulse" : ""
                        }`}
                        aria-hidden="true"
                      />
                      <span
                        className={
                          isSelected
                            ? "text-primary-foreground/80"
                            : "text-muted-foreground"
                        }
                      >
                        {presence.label}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
