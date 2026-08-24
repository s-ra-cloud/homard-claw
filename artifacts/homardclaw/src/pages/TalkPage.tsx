/**
 * Talk — voice (and text) conversations with an agent.
 *
 * Voice is strictly opt-in: the microphone permission is only requested the
 * moment the owner starts their first recording, never on page load.
 * Spoken replies stream back as PCM16 audio and can be interrupted instantly.
 * Text chat is always available as a fallback, including when the managed
 * speech service is unavailable.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  transcribeAudio,
  useConverseWithAgent,
  useCreateTask,
  useGetVoiceStatus,
  useListAgents,
  useUpdateVoiceSettings,
} from "@workspace/api-client-react";
import {
  useAudioPlayback,
  useVoiceRecorder,
} from "@workspace/integrations-openai-ai-react/audio";
import { Shell } from "@/components/layout/Shell";
import { PixelCard } from "@/components/ui/pixel-card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Mic,
  MicOff,
  Phone,
  Send,
  Square,
  Volume2,
  X,
} from "lucide-react";

const selectTriggerClass =
  "bg-background border-4 border-border rounded-none focus:ring-0 focus:border-primary font-mono text-sm uppercase";
const selectContentClass = "border-4 border-border rounded-none bg-card max-h-72";
const selectItemClass =
  "font-mono text-xs uppercase focus:bg-primary focus:text-primary-foreground";

type Turn = { role: "user" | "agent"; text: string };
type Phase = "idle" | "recording" | "thinking" | "speaking";

/**
 * A pending task proposal is only settled by an utterance that IS a
 * confirmation or cancellation — never one that merely contains the word
 * ("can you confirm the task?" goes to the agent like any other message).
 */
const CONFIRM_PHRASES = new Set([
  "confirm", "confirmed", "confirm it", "confirm that", "confirm the task",
  "yes", "yep", "yes please", "yes confirm", "yes do it", "yes go ahead",
  "do it", "go ahead", "queue it", "queue the task", "approve", "approve it",
]);
const CANCEL_PHRASES = new Set([
  "cancel", "cancel it", "cancel that", "cancel the task",
  "no", "nope", "no thanks", "never mind", "nevermind",
  "dismiss", "dismiss it", "forget it",
]);

function confirmationIntent(utterance: string): "confirm" | "cancel" | null {
  const normalized = utterance
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (CONFIRM_PHRASES.has(normalized)) return "confirm";
  if (CANCEL_PHRASES.has(normalized)) return "cancel";
  return null;
}

function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(blob);
  });
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function TalkPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { data: agents } = useListAgents();
  const { data: voiceStatus } = useGetVoiceStatus();

  const [agentId, setAgentId] = useState("");
  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [voiceOn, setVoiceOn] = useState(false);
  const [micError, setMicError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [proposedTask, setProposedTask] = useState<string | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<string | null>(null);

  const recorder = useVoiceRecorder();
  const playback = useAudioPlayback(
    `${import.meta.env.BASE_URL}audio-playback-worklet.js`,
  );
  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const proposedRef = useRef<string | null>(null);
  proposedRef.current = proposedTask;
  // Bumped on agent switch / unmount so late replies from a previous
  // conversation can never leak into the current one.
  const epochRef = useRef(0);
  // Live-caption polling while recording: session id guards late responses.
  const liveSessionRef = useRef(0);
  const liveBusyRef = useRef(false);
  const liveTimerRef = useRef<number | null>(null);

  // listAgents already excludes retired and archived agents.
  const conversableAgents = agents ?? [];
  const agent = conversableAgents.find((a) => a.id === agentId);
  const speechAvailable = voiceStatus?.available ?? false;
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  // Interrupt everything and release the microphone when leaving the page.
  useEffect(() => {
    return () => {
      epochRef.current += 1;
      liveSessionRef.current += 1;
      if (liveTimerRef.current !== null) window.clearInterval(liveTimerRef.current);
      abortRef.current?.abort();
      recorder.cancelRecording();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({ top: transcriptRef.current.scrollHeight });
  }, [turns, proposedTask, liveTranscript, phase]);

  const appendTurn = useCallback((turn: Turn) => {
    setTurns((prev) => [...prev, turn]);
  }, []);

  const stopLiveCaptions = useCallback(() => {
    liveSessionRef.current += 1;
    if (liveTimerRef.current !== null) {
      window.clearInterval(liveTimerRef.current);
      liveTimerRef.current = null;
    }
    liveBusyRef.current = false;
    setLiveTranscript(null);
  }, []);

  /**
   * While recording, periodically transcribe the audio captured so far and
   * show it as a live caption. Best-effort: failures are silent, and the
   * server's final transcript of the full recording stays authoritative.
   */
  const startLiveCaptions = useCallback(() => {
    stopLiveCaptions();
    const session = liveSessionRef.current;
    liveTimerRef.current = window.setInterval(() => {
      if (liveBusyRef.current) return;
      const partial = recorder.getPartialBlob();
      if (!partial || partial.size < 2048) return;
      liveBusyRef.current = true;
      void (async () => {
        try {
          const { text } = await transcribeAudio({ audio: await blobToBase64(partial) });
          if (liveSessionRef.current === session && text.trim()) {
            setLiveTranscript(text.trim());
          }
        } catch {
          // Live captions are cosmetic; never surface their failures.
        } finally {
          liveBusyRef.current = false;
        }
      })();
    }, 2500);
  }, [recorder, stopLiveCaptions]);

  /** Abandon any in-progress recording and its live captions. */
  const cancelRecordingSession = useCallback(() => {
    stopLiveCaptions();
    recorder.cancelRecording();
    setPhase((p) => (p === "recording" ? "idle" : p));
  }, [recorder, stopLiveCaptions]);

  const interrupt = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    playback.clear();
    setPhase("idle");
  }, [playback]);

  const switchAgent = (id: string) => {
    epochRef.current += 1; // orphan any in-flight replies
    interrupt();
    cancelRecordingSession();
    setAgentId(id);
    setTurns([]);
    setProposedTask(null);
    setFlowError(null);
    setMicError(null);
  };

  const updateSettings = useUpdateVoiceSettings({
    mutation: {
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: ["/api/voice/status"] }),
      onError: (err) =>
        toast({
          title: "Could not update transcript storage",
          description: errorText(err, "Try again."),
          variant: "destructive",
        }),
    },
  });

  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        appendTurn({
          role: "agent",
          text: "Task queued. It follows the office's normal approval policy before any work starts.",
        });
        toast({ title: "Task queued", description: "Approval policy applies as usual." });
      },
      onError: (err) =>
        toast({
          title: "Could not queue the task",
          description: errorText(err, "Try again from the Tasks page."),
          variant: "destructive",
        }),
    },
  });

  const queueProposedTask = useCallback(
    (objective: string) => {
      if (!agentId) return;
      setProposedTask(null);
      createTask.mutate({ data: { agentId, objective } });
    },
    [agentId, createTask],
  );

  /**
   * A pending proposal is resolved by the owner's next words — spoken or
   * typed. Returns true when the utterance was consumed as a confirmation.
   */
  const resolveProposal = useCallback(
    (utterance: string): boolean => {
      const objective = proposedRef.current;
      if (!objective) return false;
      const intent = confirmationIntent(utterance);
      if (intent === "confirm") {
        queueProposedTask(objective);
        return true;
      }
      if (intent === "cancel") {
        setProposedTask(null);
        appendTurn({ role: "agent", text: "Okay, I won't queue that task." });
        return true;
      }
      return false;
    },
    [appendTurn, queueProposedTask],
  );

  const textConverse = useConverseWithAgent();

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    const text = textDraft.trim();
    if (!text || !agentId || phase !== "idle") return;
    setTextDraft("");
    setFlowError(null);
    appendTurn({ role: "user", text });
    if (resolveProposal(text)) return;
    setPhase("thinking");
    const epoch = epochRef.current;
    textConverse
      .mutateAsync({ agentId, data: { text, history: turnsRef.current.slice(-10) } })
      .then((data) => {
        if (epochRef.current !== epoch) return; // conversation was switched away
        appendTurn({ role: "agent", text: data.reply });
        setProposedTask(data.proposedTaskObjective ?? null);
        setPhase("idle");
      })
      .catch((err) => {
        if (epochRef.current !== epoch) return;
        setFlowError(errorText(err, "The agent could not answer just now."));
        setPhase("idle");
      });
  };

  const startRecording = async () => {
    if (!agentId || (phase !== "idle" && phase !== "speaking")) return;
    // Recording over a speaking agent interrupts it immediately.
    if (phase === "speaking") interrupt();
    setMicError(null);
    setFlowError(null);
    try {
      // First user gesture: unlock audio output, then ask for the mic.
      await playback.init();
      await recorder.startRecording();
      setPhase("recording");
      startLiveCaptions();
    } catch {
      setMicError(
        "Microphone access was denied or unavailable. Allow the microphone in your browser settings, or keep chatting by text below.",
      );
      setPhase("idle");
    }
  };

  const finishRecording = async () => {
    if (phase !== "recording") return;
    setPhase("thinking");
    let blob: Blob;
    try {
      blob = await recorder.stopRecording();
      if (blob.size === 0) throw new Error("empty recording");
    } catch {
      stopLiveCaptions();
      setFlowError("The recording failed. Try again, or type your message instead.");
      setPhase("idle");
      return;
    }
    stopLiveCaptions();
    await streamVoiceTurn(blob);
  };

  const streamVoiceTurn = async (blob: Blob) => {
    const controller = new AbortController();
    abortRef.current = controller;
    const epoch = epochRef.current;
    // Reset the chunk sequencer: every turn's audio starts again at seq 0.
    playback.clear();
    let sawDone = false;
    try {
      const audio = await blobToBase64(blob);
      const response = await fetch(`${import.meta.env.BASE_URL}api/agents/${agentId}/voice-converse`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ audio, history: turnsRef.current.slice(-10) }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const detail = await response
          .json()
          .then((d: { error?: string }) => d.error)
          .catch(() => null);
        throw new Error(detail ?? "Voice services are unavailable right now.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let expectAudio = false;

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const frames = buffer.split("\n\n");
        buffer = frames.pop() ?? "";
        for (const frame of frames) {
          if (epochRef.current !== epoch) return; // switched away mid-stream
          const line = frame.split("\n").find((l) => l.startsWith("data: "));
          if (!line) continue;
          const event = JSON.parse(line.slice(6)) as Record<string, unknown>;
          switch (event.type) {
            case "user_transcript": {
              const text = String(event.text ?? "");
              appendTurn({ role: "user", text });
              // A spoken "confirm"/"cancel" settles a pending proposal
              // immediately; the rest of the stream is irrelevant then.
              if (resolveProposal(text)) {
                controller.abort();
                setPhase("idle");
                return;
              }
              break;
            }
            case "reply": {
              appendTurn({ role: "agent", text: String(event.text ?? "") });
              setProposedTask(
                typeof event.proposedTaskObjective === "string"
                  ? event.proposedTaskObjective
                  : null,
              );
              expectAudio = event.voice != null;
              // Stay in "thinking" until audio actually arrives, so a failed
              // TTS stream cannot strand the UI in a speaking state.
              setPhase(expectAudio ? "thinking" : "idle");
              break;
            }
            case "audio":
              playback.pushSequencedAudio(Number(event.seq ?? 0), String(event.data ?? ""));
              setPhase("speaking");
              break;
            case "error":
              setFlowError(String(event.message ?? "Something went wrong."));
              // Fatal errors end the turn server-side; returning here keeps
              // the real message instead of a "connection dropped" fallback.
              if (event.fatal === true) return;
              break;
            case "done":
              sawDone = true;
              if (expectAudio) playback.signalComplete();
              break;
          }
        }
      }
      if (!sawDone && !controller.signal.aborted && epochRef.current === epoch) {
        setFlowError("The connection dropped mid-reply. Try again.");
      }
    } catch (err) {
      if (!controller.signal.aborted && epochRef.current === epoch) {
        setFlowError(
          errorText(err, "The voice request failed. Check your connection and try again."),
        );
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (epochRef.current === epoch) {
        setPhase((current) => (current === "speaking" ? current : "idle"));
      }
    }
  };

  // "speaking" ends when the playback worklet drains.
  useEffect(() => {
    if (phase === "speaking" && playback.state === "idle") setPhase("idle");
  }, [phase, playback.state]);

  return (
    <Shell>
      <div className="p-4 sm:p-8 max-w-3xl mx-auto space-y-6">
        <div>
          <h2 className="font-display text-xl text-primary uppercase flex items-center gap-3">
            <Phone className="w-5 h-5" aria-hidden="true" /> Talk
          </h2>
          <p className="text-xs text-muted-foreground mt-2 font-mono uppercase">
            Call an agent — speak or type
          </p>
        </div>

        {voiceStatus && !voiceStatus.available && (
          <PixelCard className="p-4 border-accent">
            <div className="flex items-start gap-3 text-sm">
              <AlertTriangle className="w-4 h-4 mt-0.5 shrink-0 text-accent" aria-hidden="true" />
              <p>{voiceStatus.reason ?? "Voice is unavailable; text chat still works."}</p>
            </div>
          </PixelCard>
        )}

        <PixelCard className="p-4 space-y-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div>
              <label
                htmlFor="talk-agent"
                className="block text-[10px] font-mono uppercase text-muted-foreground mb-1"
              >
                Agent on the line
              </label>
              <Select value={agentId} onValueChange={switchAgent}>
                <SelectTrigger id="talk-agent" className={selectTriggerClass}>
                  <SelectValue placeholder="Pick an agent" />
                </SelectTrigger>
                <SelectContent className={selectContentClass}>
                  {conversableAgents.map((a) => (
                    <SelectItem key={a.id} value={a.id} className={selectItemClass}>
                      {a.name} — {a.title}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="flex items-end justify-between gap-4">
              <label
                htmlFor="voice-mode"
                className="text-[10px] font-mono uppercase text-muted-foreground"
              >
                Voice mode
                <span className="block normal-case text-muted-foreground/80">
                  Mic is only requested when you record
                </span>
              </label>
              <Switch
                id="voice-mode"
                checked={voiceOn}
                disabled={!speechAvailable || !recorderSupported}
                onCheckedChange={(on) => {
                  setVoiceOn(on);
                  if (!on) {
                    cancelRecordingSession();
                    interrupt();
                  }
                }}
              />
            </div>
          </div>
          <div className="flex items-center justify-between gap-4 border-t-2 border-border pt-3">
            <label
              htmlFor="transcripts"
              className="text-[10px] font-mono uppercase text-muted-foreground"
            >
              Save transcripts
              <span className="block normal-case text-muted-foreground/80">
                Off by default; saved chats appear under agent messages
              </span>
            </label>
            <Switch
              id="transcripts"
              checked={voiceStatus?.transcriptsEnabled ?? false}
              disabled={!voiceStatus || updateSettings.isPending}
              onCheckedChange={(on) =>
                updateSettings.mutate({ data: { transcriptsEnabled: on } })
              }
            />
          </div>
          {!recorderSupported && (
            <p className="text-xs text-muted-foreground">
              This browser cannot record audio; use the text box below.
            </p>
          )}
        </PixelCard>

        <PixelCard className="p-0 overflow-hidden">
          <div
            ref={transcriptRef}
            aria-live="polite"
            aria-label="Conversation transcript"
            className="h-[40vh] overflow-y-auto p-4 space-y-3 bg-background/60"
          >
            {turns.length === 0 && (
              <p className="text-xs text-muted-foreground font-mono uppercase text-center pt-12">
                {agent
                  ? `Say hello to ${agent.name}`
                  : "Pick an agent to start the call"}
              </p>
            )}
            {turns.map((turn, i) => (
              <div
                key={i}
                className={`max-w-[85%] px-3 py-2 text-sm border-2 border-border pixel-shadow ${
                  turn.role === "user"
                    ? "ml-auto bg-primary text-primary-foreground"
                    : "mr-auto bg-card"
                }`}
              >
                <span className="block text-[9px] font-mono uppercase opacity-70">
                  {turn.role === "user" ? "You" : agent?.name ?? "Agent"}
                </span>
                {turn.text}
              </div>
            ))}
            {phase === "recording" && (
              <div
                className="ml-auto max-w-[85%] px-3 py-2 text-sm border-2 border-dashed border-border bg-primary/20"
                role="status"
                aria-label="Live transcription of your recording"
              >
                <span className="block text-[9px] font-mono uppercase opacity-70">
                  You (live)
                </span>
                {liveTranscript ?? "Listening…"}
              </div>
            )}
            {phase === "thinking" && (
              <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground" role="status">
                <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
                {agent?.name ?? "The agent"} is thinking…
              </div>
            )}
          </div>

          {proposedTask && (
            <div className="border-t-4 border-border p-4 bg-accent/10 space-y-2">
              <p className="text-xs font-mono uppercase text-accent flex items-center gap-2">
                <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Proposed task
              </p>
              <p className="text-sm">{proposedTask}</p>
              <p className="text-[10px] text-muted-foreground">
                Say “confirm” (or tap Queue) to create it. Approval policy still applies.
              </p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  disabled={createTask.isPending}
                  onClick={() => queueProposedTask(proposedTask)}
                >
                  Queue task
                </Button>
                <Button size="sm" variant="outline" onClick={() => setProposedTask(null)}>
                  <X className="w-3 h-3 mr-1" aria-hidden="true" /> Dismiss
                </Button>
              </div>
            </div>
          )}

          {(micError || flowError) && (
            <div className="border-t-4 border-border p-3 bg-destructive/10 text-destructive text-xs" role="alert">
              {micError ?? flowError}
            </div>
          )}

          <div className="border-t-4 border-border p-4 space-y-3">
            {voiceOn && speechAvailable && recorderSupported && (
              <div className="flex items-center gap-3">
                {phase === "recording" ? (
                  <Button onClick={finishRecording} className="bg-destructive text-destructive-foreground">
                    <Square className="w-4 h-4 mr-2" aria-hidden="true" /> Stop &amp; send
                  </Button>
                ) : (
                  <Button
                    onClick={startRecording}
                    disabled={!agentId || (phase !== "idle" && phase !== "speaking")}
                    aria-label={`Record a message${agent ? ` for ${agent.name}` : ""}`}
                  >
                    <Mic className="w-4 h-4 mr-2" aria-hidden="true" /> Record
                  </Button>
                )}
                {phase === "recording" && (
                  <span className="flex items-center gap-2 text-xs text-destructive font-mono uppercase" role="status">
                    <span className="w-2 h-2 bg-destructive animate-pulse" aria-hidden="true" />
                    Recording…
                  </span>
                )}
                {phase === "speaking" && (
                  <>
                    <span className="flex items-center gap-2 text-xs text-accent font-mono uppercase" role="status">
                      <Volume2 className="w-4 h-4" aria-hidden="true" />
                      {agent?.name ?? "Agent"} is speaking
                    </span>
                    <Button size="sm" variant="outline" onClick={interrupt}>
                      <MicOff className="w-3 h-3 mr-1" aria-hidden="true" /> Interrupt
                    </Button>
                  </>
                )}
              </div>
            )}

            <form onSubmit={sendText} className="flex gap-2">
              <Input
                value={textDraft}
                onChange={(e) => setTextDraft(e.target.value)}
                placeholder={agent ? `Type to ${agent.name}…` : "Pick an agent first"}
                disabled={!agentId || phase === "recording"}
                aria-label="Type a message"
                className="bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary"
              />
              <Button
                type="submit"
                disabled={!agentId || !textDraft.trim() || phase !== "idle"}
                aria-label="Send message"
              >
                <Send className="w-4 h-4" aria-hidden="true" />
              </Button>
            </form>
          </div>
        </PixelCard>
      </div>
    </Shell>
  );
}
