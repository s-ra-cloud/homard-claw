import { useMemo, useState } from "react";
import {
  getGetDocumentationQueryKey,
  useChatWithDocumentation,
  useGetDocumentation,
  useListAgents,
  useUpdateDocumentationSettings,
  type DocumentationChatTurn,
} from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "wouter";
import { BookOpen, Bot, MessageCircle, Send, Settings2 } from "lucide-react";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";

type Tab = "read" | "ask";

function apiErrorMessage(error: unknown, fallback: string): string {
  const data = (error as { response?: { data?: { error?: string } } })?.response
    ?.data;
  return data?.error ?? fallback;
}

export default function DocumentationPage() {
  const { data: documentation, isLoading } = useGetDocumentation();
  const { data: agents } = useListAgents();
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const [tab, setTab] = useState<Tab>("read");
  const [question, setQuestion] = useState("");
  const [history, setHistory] = useState<DocumentationChatTurn[]>([]);

  const activeCrustabots = useMemo(
    // listAgents already excludes retired Crustabots.
    () => (agents ?? []).filter((agent) => !agent.archived),
    [agents],
  );

  const updateSettings = useUpdateDocumentationSettings({
    mutation: {
      onSuccess: async (nextDocumentation) => {
        queryClient.setQueryData(
          getGetDocumentationQueryKey(),
          nextDocumentation,
        );
        setHistory([]);
        toast({
          title: "Documentation guide updated",
          description: `${nextDocumentation.assistantName} now answers Documentation questions.`,
        });
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "Could not change the guide",
          description: apiErrorMessage(error, "Try again."),
        });
      },
    },
  });

  const chat = useChatWithDocumentation({
    mutation: {
      onSuccess: (response) => {
        setHistory((current) => [
          ...current,
          { role: "assistant", text: response.reply },
        ]);
      },
      onError: (error) => {
        toast({
          variant: "destructive",
          title: "The Documentation Crustabot could not answer",
          description: apiErrorMessage(error, "Try again."),
        });
      },
    },
  });

  const ask = () => {
    const text = question.trim();
    if (!text || chat.isPending) return;
    const priorHistory = history.slice(-12);
    setQuestion("");
    setHistory((current) => [...current, { role: "user", text }]);
    chat.mutate({ data: { text, history: priorHistory } });
  };

  return (
    <Shell>
      <div className="mx-auto max-w-6xl space-y-6 p-4 sm:p-6 lg:p-8">
        <header className="flex flex-col gap-4 border-b-4 border-border pb-6 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-3">
              <BookOpen className="h-6 w-6 text-primary" />
              <h1 className="font-display text-lg uppercase text-foreground sm:text-2xl">
                Crustabox Documentation
              </h1>
            </div>
            <p className="max-w-2xl text-sm text-muted-foreground">
              Read what Crustabox can do, or ask a selected Crustabot to explain
              the official documentation.
            </p>
          </div>
          <div
            className="flex gap-2"
            role="tablist"
            aria-label="Documentation mode"
          >
            <Button
              type="button"
              variant={tab === "read" ? "primary" : "outline"}
              onClick={() => setTab("read")}
              role="tab"
              aria-selected={tab === "read"}
            >
              <BookOpen className="mr-2 h-4 w-4" /> Read
            </Button>
            <Button
              type="button"
              variant={tab === "ask" ? "primary" : "outline"}
              onClick={() => setTab("ask")}
              role="tab"
              aria-selected={tab === "ask"}
            >
              <MessageCircle className="mr-2 h-4 w-4" /> Ask
            </Button>
          </div>
        </header>

        {isLoading ? (
          <PixelCard className="h-72 animate-pulse bg-muted/40">
            <span className="sr-only">Loading documentation</span>
          </PixelCard>
        ) : tab === "read" ? (
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            {(documentation?.sections ?? []).map((section) => (
              <PixelCard key={section.id} className="h-full">
                <h2 className="mb-3 font-display text-sm uppercase text-primary">
                  {section.title}
                </h2>
                <p className="mb-4 text-sm leading-6 text-foreground/80">
                  {section.summary}
                </p>
                <ul className="space-y-3 text-xs leading-5 text-muted-foreground">
                  {section.items.map((item) => (
                    <li key={item} className="flex gap-3">
                      <span className="mt-2 h-2 w-2 shrink-0 bg-accent" />
                      <span>{item}</span>
                    </li>
                  ))}
                </ul>
              </PixelCard>
            ))}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[19rem_minmax(0,1fr)]">
            <PixelCard className="h-fit">
              <div className="mb-4 flex items-center gap-2">
                <Bot className="h-5 w-5 text-accent" />
                <h2 className="font-display text-xs uppercase">
                  Documentation Crustabot
                </h2>
              </div>
              {activeCrustabots.length > 0 ? (
                <Select
                  value={documentation?.assistantAgentId ?? undefined}
                  onValueChange={(agentId) =>
                    updateSettings.mutate({ data: { agentId } })
                  }
                  disabled={updateSettings.isPending}
                >
                  <SelectTrigger
                    className="rounded-none border-4 border-border bg-background font-mono text-xs uppercase focus:ring-0"
                    aria-label="Choose the Documentation Crustabot"
                  >
                    <SelectValue placeholder="Choose a Crustabot" />
                  </SelectTrigger>
                  <SelectContent className="rounded-none border-4 border-border bg-card">
                    {activeCrustabots.map((agent) => (
                      <SelectItem
                        key={agent.id}
                        value={agent.id}
                        className="font-mono text-xs uppercase"
                      >
                        {agent.name} — {agent.title}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <p className="text-xs leading-5 text-muted-foreground">
                  Recruit a Crustabot before using Documentation chat.
                </p>
              )}
              <p className="mt-4 text-xs leading-5 text-muted-foreground">
                The guide uses that Crustabot&apos;s configured provider, model,
                and reasoning settings. Documentation mode cannot create tasks,
                contact coworkers, or use connected apps.
              </p>
              {documentation?.assistantAgentId && (
                <Link href={`/agents/${documentation.assistantAgentId}/edit`}>
                  <Button variant="outline" className="mt-4 w-full">
                    <Settings2 className="mr-2 h-4 w-4" /> Edit guide model
                  </Button>
                </Link>
              )}
            </PixelCard>

            <PixelCard className="flex min-h-[34rem] flex-col">
              <div
                className="flex-1 space-y-4 overflow-y-auto border-4 border-border bg-background/50 p-4"
                aria-live="polite"
              >
                {history.length === 0 ? (
                  <div className="flex h-full min-h-56 flex-col items-center justify-center gap-3 text-center text-muted-foreground">
                    <MessageCircle className="h-10 w-10 opacity-50" />
                    <p className="max-w-md text-sm">
                      Ask how Talk, tasks, approvals, providers, memory, apps,
                      permissions, or retirement work in Crustabox.
                    </p>
                  </div>
                ) : (
                  history.map((turn, index) => (
                    <div
                      key={`${index}-${turn.role}`}
                      className={`max-w-[90%] border-2 border-border p-3 text-sm leading-6 ${
                        turn.role === "user"
                          ? "ml-auto bg-primary text-primary-foreground"
                          : "bg-card text-foreground"
                      }`}
                    >
                      <div className="mb-1 text-[10px] font-bold uppercase opacity-70">
                        {turn.role === "user"
                          ? "You"
                          : (documentation?.assistantName ?? "Documentation")}
                      </div>
                      <div className="whitespace-pre-wrap">{turn.text}</div>
                    </div>
                  ))
                )}
                {chat.isPending && (
                  <div className="max-w-[90%] border-2 border-border bg-card p-3 text-xs uppercase text-muted-foreground">
                    {documentation?.assistantName ?? "Documentation"} is
                    reading…
                  </div>
                )}
              </div>
              <div className="mt-4 flex items-end gap-3">
                <Textarea
                  value={question}
                  onChange={(event) => setQuestion(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" && !event.shiftKey) {
                      event.preventDefault();
                      ask();
                    }
                  }}
                  rows={3}
                  maxLength={4000}
                  placeholder="Ask what Crustabox can do…"
                  className="min-h-20 flex-1 rounded-none border-4 border-border bg-background font-mono text-sm focus-visible:border-primary focus-visible:ring-0"
                  disabled={!documentation?.assistantAgentId || chat.isPending}
                  aria-label="Documentation question"
                />
                <Button
                  type="button"
                  variant="primary"
                  size="icon"
                  className="h-20 w-16"
                  onClick={ask}
                  disabled={
                    !documentation?.assistantAgentId ||
                    !question.trim() ||
                    chat.isPending
                  }
                  aria-label="Send documentation question"
                >
                  <Send className="h-5 w-5" />
                </Button>
              </div>
            </PixelCard>
          </div>
        )}
      </div>
    </Shell>
  );
}
