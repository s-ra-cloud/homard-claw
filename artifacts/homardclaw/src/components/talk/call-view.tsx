/**
 * The call surface for one agent: transcript, live captions, record / stop /
 * interrupt, the text composer, and any task the agent proposes.
 *
 * The component is mounted with `key={agent.id}`, so switching contacts (or
 * hanging up) unmounts it and its cleanup tears down the in-flight recording,
 * playback and stream exactly as the old agent switch did. The recorder and
 * playback hooks live in the page above so a contact switch cannot leak an
 * extra AudioContext.
 */
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type {
  Agent,
  AgentDelegationProposal,
  AgentDelegationTarget,
  InputAttachment,
} from "@workspace/api-client-react";
import {
  useDelegateFromTalk,
  getGetTalkHistoryQueryKey,
  transcribeAudio,
  useClearTalkHistory,
  useConverseWithAgent,
  useCreateTask,
  useGetTalkHistory,
} from "@workspace/api-client-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type {
  useAudioPlayback,
  useVoiceRecorder,
} from "@workspace/integrations-openai-ai-react/audio";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { MarlowLobster } from "@/components/ui/marlow-lobster";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  ChevronLeft,
  Loader2,
  Mic,
  MicOff,
  Network,
  Paperclip,
  FileText,
  RotateCcw,
  Send,
  Square,
  Trash2,
  Volume2,
  X,
} from "lucide-react";
import { presenceForStatus } from "./agent-presence";
import {
  ATTACHMENT_ACCEPT,
  MAX_ATTACHMENTS,
  attachmentLabel,
  readAttachment,
} from "@/lib/attachments";

export type Turn = {
  role: "user" | "agent";
  text: string;
  /** Stable key for this session; stored history rows reuse their server id. */
  key: string;
  /** Set when this outgoing message never got a reply; shows a resend button. */
  failed?: boolean;
  attachments?: InputAttachment[];
};
type Phase = "idle" | "recording" | "thinking" | "speaking";

/**
 * A pending task proposal is only settled by an utterance that IS a
 * confirmation or cancellation — never one that merely contains the word
 * ("can you confirm the task?" goes to the agent like any other message).
 */
const CONFIRM_PHRASES = new Set([
  "confirm",
  "confirmed",
  "confirm it",
  "confirm that",
  "confirm the task",
  "yes",
  "yep",
  "yes please",
  "yes confirm",
  "yes do it",
  "yes go ahead",
  "do it",
  "go ahead",
  "queue it",
  "queue the task",
  "approve",
  "approve it",
]);
const CANCEL_PHRASES = new Set([
  "cancel",
  "cancel it",
  "cancel that",
  "cancel the task",
  "no",
  "nope",
  "no thanks",
  "never mind",
  "nevermind",
  "dismiss",
  "dismiss it",
  "forget it",
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
  // API errors carry the server's sanitized guidance in `data.error`.
  // Prefer it over the Error message, which is prefixed with
  // "HTTP 503 Service Unavailable:" noise that reads like a raw failure.
  if (error && typeof error === "object" && "data" in error) {
    const data = (error as { data?: unknown }).data;
    if (data && typeof data === "object" && "error" in data) {
      const detail = (data as { error?: unknown }).error;
      if (typeof detail === "string" && detail.trim()) return detail;
    }
  }
  // A network-level failure never reached the server: the browser reports it
  // as an opaque TypeError ("Failed to fetch" / "Load failed"). Translate it
  // — the raw text explains nothing and looks like a bug.
  if (
    error instanceof TypeError ||
    (error instanceof Error &&
      /failed to fetch|load failed|networkerror/i.test(error.message))
  ) {
    return "The message could not reach the server — the connection dropped or the network is offline. Check your connection, then press Resend.";
  }
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface CallViewProps {
  agent: Agent;
  recorder: ReturnType<typeof useVoiceRecorder>;
  playback: ReturnType<typeof useAudioPlayback>;
  voiceOn: boolean;
  speechAvailable: boolean;
  recorderSupported: boolean;
  /** Current setting; the server snapshots it when a Talk task is queued. */
  autoApproveTalkTasks: boolean;
  /** Back to the contacts list; omitted when both panes are on screen. */
  onHangUp?: () => void;
  /** Settings gear, so the call screen is never a dead end on a phone. */
  headerAction?: ReactNode;
}

export function CallView({
  agent,
  recorder,
  playback,
  voiceOn,
  speechAvailable,
  recorderSupported,
  autoApproveTalkTasks,
  onHangUp,
  headerAction,
}: CallViewProps) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const agentId = agent.id;

  const [turns, setTurns] = useState<Turn[]>([]);
  const [phase, setPhase] = useState<Phase>("idle");
  const [micError, setMicError] = useState<string | null>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [textDraft, setTextDraft] = useState("");
  const [attachments, setAttachments] = useState<InputAttachment[]>([]);
  const [proposedTask, setProposedTask] = useState<string | null>(null);
  const [proposedDelegation, setProposedDelegation] =
    useState<AgentDelegationProposal | null>(null);
  const [pendingDelegation, setPendingDelegation] =
    useState<AgentDelegationTarget | null>(null);
  const [liveTranscript, setLiveTranscript] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const attachmentInputRef = useRef<HTMLInputElement>(null);
  const turnsRef = useRef<Turn[]>([]);
  turnsRef.current = turns;
  const proposedRef = useRef<string | null>(null);
  proposedRef.current = proposedTask;
  const proposedDelegationRef = useRef<AgentDelegationProposal | null>(null);
  proposedDelegationRef.current = proposedDelegation;
  const pendingDelegationRef = useRef<AgentDelegationTarget | null>(null);
  pendingDelegationRef.current = pendingDelegation;
  // Bumped on unmount (i.e. contact switch / hang up) so late replies from a
  // previous conversation can never leak into the current one.
  const epochRef = useRef(0);
  // Live-caption polling while recording: session id guards late responses.
  const liveSessionRef = useRef(0);
  const liveBusyRef = useRef(false);
  const liveTimerRef = useRef<number | null>(null);

  // Interrupt everything and release the microphone when the call ends.
  const recorderRef = useRef(recorder);
  recorderRef.current = recorder;
  const playbackRef = useRef(playback);
  playbackRef.current = playback;
  useEffect(() => {
    return () => {
      epochRef.current += 1;
      liveSessionRef.current += 1;
      if (liveTimerRef.current !== null)
        window.clearInterval(liveTimerRef.current);
      abortRef.current?.abort();
      recorderRef.current.cancelRecording();
      playbackRef.current.clear();
    };
  }, []);

  useEffect(() => {
    transcriptRef.current?.scrollTo({
      top: transcriptRef.current.scrollHeight,
    });
  }, [
    turns,
    proposedTask,
    proposedDelegation,
    pendingDelegation,
    liveTranscript,
    phase,
  ]);

  // Keys for optimistic turns; hydrated turns use server ids. User turns'
  // keys double as the converse idempotency id, so they must be unique
  // across sessions, not just within one.
  const makeKey = useCallback(
    () =>
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `local-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [],
  );

  const appendTurn = useCallback(
    (turn: Omit<Turn, "key"> & { key?: string }): string => {
      const key = turn.key ?? makeKey();
      setTurns((prev) => [...prev, { ...turn, key }]);
      return key;
    },
    [makeKey],
  );

  const setTurnFailed = useCallback((key: string, failed: boolean) => {
    setTurns((prev) =>
      prev.map((t) =>
        t.key === key ? { ...t, failed: failed || undefined } : t,
      ),
    );
  }, []);

  // Stored history: hydrate once per mount (the component is keyed by agent
  // id, so a contact switch remounts and re-hydrates for the new agent).
  // Later live refetches append only task-linked recaps. Regular Talk turns
  // are already optimistic in this component and have different server ids,
  // so appending all refetched rows would duplicate the active conversation.
  const talkHistory = useGetTalkHistory(agentId, {
    query: {
      queryKey: getGetTalkHistoryQueryKey(agentId),
      refetchOnMount: "always",
      // SSE makes this immediate in the normal case; polling covers a task
      // finishing while the tab was hidden or the live stream reconnected.
      refetchInterval: 5_000,
    },
  });
  const historyReady =
    talkHistory.isError || (talkHistory.isFetched && !talkHistory.isFetching);
  const hydratedRef = useRef(false);
  const storedTurnIdsRef = useRef(new Set<string>());
  useEffect(() => {
    if (!historyReady || !talkHistory.data) return;
    if (!hydratedRef.current) {
      hydratedRef.current = true;
      const stored: Turn[] = talkHistory.data.turns.map((t) => {
        storedTurnIdsRef.current.add(t.id);
        return { role: t.role, text: t.text, key: t.id };
      });
      if (stored.length > 0) setTurns((prev) => [...stored, ...prev]);
      return;
    }
    const recaps: Turn[] = talkHistory.data.turns
      .filter(
        (turn) =>
          turn.taskId !== null && !storedTurnIdsRef.current.has(turn.id),
      )
      .map((turn) => {
        storedTurnIdsRef.current.add(turn.id);
        return { role: turn.role, text: turn.text, key: turn.id };
      });
    if (recaps.length > 0) setTurns((prev) => [...prev, ...recaps]);
  }, [historyReady, talkHistory.data]);

  /** Context sent to the agent: recent settled turns, without failed sends. */
  const contextTurns = useCallback(
    () =>
      turnsRef.current
        .filter((t) => !t.failed)
        .slice(-10)
        .map(({ role, text }) => ({ role, text })),
    [],
  );

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
          const { text } = await transcribeAudio({
            audio: await blobToBase64(partial),
          });
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

  // Turning voice mode off mid-call drops the mic and any spoken reply.
  const wasVoiceOn = useRef(voiceOn);
  useEffect(() => {
    if (wasVoiceOn.current && !voiceOn) {
      cancelRecordingSession();
      interrupt();
    }
    wasVoiceOn.current = voiceOn;
  }, [voiceOn, cancelRecordingSession, interrupt]);

  const createTask = useCreateTask({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        queryClient.invalidateQueries({ queryKey: ["/api/office/overview"] });
        appendTurn({
          role: "agent",
          text: autoApproveTalkTasks
            ? "Task queued. Talk auto-approval will handle its initial approval if one is required. I'll report back here when it finishes."
            : "Task queued. It follows the office's normal approval policy before work starts. I'll report back here when it finishes.",
        });
        toast({
          title: "Task queued",
          description: autoApproveTalkTasks
            ? "Initial Talk approval is automatic; safety limits still apply."
            : "Approval policy applies as usual.",
        });
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
      setProposedTask(null);
      createTask.mutate({ data: { agentId, objective, talkMode: true } });
    },
    [agentId, createTask],
  );

  const delegateTask = useDelegateFromTalk({
    mutation: {
      onSuccess: () => {
        const proposal = proposedDelegationRef.current;
        setProposedDelegation(null);
        setPendingDelegation(null);
        void queryClient.invalidateQueries({ queryKey: ["/api/tasks"] });
        void queryClient.invalidateQueries({ queryKey: ["/api/messages"] });
        appendTurn({
          role: "agent",
          text: `I sent the task to ${proposal?.targetAgentName ?? "my teammate"}. You'll see our hand-off and their result in Inbox.`,
        });
        toast({
          title: "Task handed off",
          description: `${proposal?.targetAgentName ?? "The teammate"} received it.`,
        });
      },
      onError: (err) =>
        toast({
          title: "Could not hand off the task",
          description: errorText(err, "The office refused that delegation."),
          variant: "destructive",
        }),
    },
  });

  const queueProposedDelegation = useCallback(
    (proposal: AgentDelegationProposal) => {
      delegateTask.mutate({
        agentId,
        data: {
          targetAgentId: proposal.targetAgentId,
          objective: proposal.objective,
          note: proposal.note,
        },
      });
    },
    [agentId, delegateTask],
  );

  /**
   * A pending proposal is resolved by the owner's next words — spoken or
   * typed. Returns true when the utterance was consumed as a confirmation.
   */
  const resolveProposal = useCallback(
    (utterance: string): boolean => {
      const objective = proposedRef.current;
      const delegation = proposedDelegationRef.current;
      const pending = pendingDelegationRef.current;
      if (!objective && !delegation && !pending) return false;
      const intent = confirmationIntent(utterance);
      if (intent === "confirm") {
        if (delegation) queueProposedDelegation(delegation);
        else if (objective) queueProposedTask(objective);
        else if (pending) {
          appendTurn({
            role: "agent",
            text: `Tell me what task ${pending.targetAgentName} should handle first.`,
          });
        }
        return true;
      }
      if (intent === "cancel") {
        setProposedTask(null);
        setProposedDelegation(null);
        setPendingDelegation(null);
        appendTurn({
          role: "agent",
          text: pending
            ? `Okay, I cancelled the hand-off to ${pending.targetAgentName}.`
            : "Okay, I won't queue that task.",
        });
        return true;
      }
      return false;
    },
    [appendTurn, queueProposedDelegation, queueProposedTask],
  );

  const textConverse = useConverseWithAgent();

  const clearHistory = useClearTalkHistory({
    mutation: {
      onSuccess: () => {
        // Invalidate the conversation epoch and abort anything still in
        // flight, so a late reply handler can never repopulate the
        // transcript we are about to wipe.
        epochRef.current += 1;
        abortRef.current?.abort();
        abortRef.current = null;
        playbackRef.current.clear();
        setPhase("idle");
        // Wipe the on-screen transcript (stored and optimistic turns alike)
        // and any in-progress proposal, then refresh the cached history so a
        // remount hydrates empty.
        setTurns([]);
        setProposedTask(null);
        setProposedDelegation(null);
        setPendingDelegation(null);
        setFlowError(null);
        queryClient.invalidateQueries({
          queryKey: getGetTalkHistoryQueryKey(agentId),
        });
        toast({
          title: "History cleared",
          description: `Your conversation with ${agent.name} was deleted.`,
        });
      },
      onError: (err) =>
        toast({
          title: "Could not clear history",
          description: errorText(err, "Try again in a moment."),
          variant: "destructive",
        }),
    },
  });

  /**
   * Deliver one user turn (already in the transcript, identified by its key)
   * as a text message. Used for both fresh sends and resends of failed turns
   * — a resend retries only this message and never duplicates the turn.
   */
  const deliverText = useCallback(
    (
      text: string,
      turnKey: string,
      turnAttachments: InputAttachment[] = [],
    ) => {
      setFlowError(null);
      setTurnFailed(turnKey, false);
      setPhase("thinking");
      const epoch = epochRef.current;
      textConverse
        .mutateAsync({
          agentId,
          // The turn key is the idempotency id: a resend of this exact turn
          // returns the already-generated reply instead of a duplicate.
          data: {
            text,
            history: contextTurns(),
            clientMessageId: turnKey,
            ...(pendingDelegationRef.current
              ? {
                  pendingDelegationTargetId:
                    pendingDelegationRef.current.targetAgentId,
                }
              : {}),
            ...(turnAttachments.length ? { attachments: turnAttachments } : {}),
          },
        })
        .then((data) => {
          if (epochRef.current !== epoch) return; // the call was ended
          appendTurn({ role: "agent", text: data.reply });
          setProposedTask(data.proposedTaskObjective ?? null);
          setProposedDelegation(data.proposedDelegation ?? null);
          setPendingDelegation(data.pendingDelegation ?? null);
          setPhase("idle");
        })
        .catch((err) => {
          if (epochRef.current !== epoch) return;
          setTurnFailed(turnKey, true);
          setFlowError(errorText(err, "The agent could not answer just now."));
          setPhase("idle");
        });
    },
    [agentId, appendTurn, contextTurns, setTurnFailed, textConverse],
  );

  const addAttachments = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const selected = Array.from(event.target.files ?? []);
    event.target.value = "";
    const available = MAX_ATTACHMENTS - attachments.length;
    if (selected.length > available) {
      toast({
        title: `You can attach up to ${MAX_ATTACHMENTS} files`,
        variant: "destructive",
      });
    }
    for (const file of selected.slice(0, available)) {
      try {
        const attachment = await readAttachment(file);
        setAttachments((current) => [...current, attachment]);
      } catch (error) {
        toast({
          title: "Attachment rejected",
          description:
            error instanceof Error
              ? error.message
              : "The file could not be read.",
          variant: "destructive",
        });
      }
    }
  };

  const sendText = (event: React.FormEvent) => {
    event.preventDefault();
    const text =
      textDraft.trim() ||
      (attachments.length ? "Please review the attached file(s)." : "");
    if (!text || phase !== "idle" || !historyReady) return;
    setTextDraft("");
    const sentAttachments = attachments;
    setAttachments([]);
    setFlowError(null);
    const key = appendTurn({
      role: "user",
      text,
      attachments: sentAttachments,
    });
    if (resolveProposal(text)) return;
    deliverText(text, key, sentAttachments);
  };

  const resendTurn = useCallback(
    (turn: Turn) => {
      if (phase !== "idle") return;
      deliverText(turn.text, turn.key, turn.attachments);
    },
    [deliverText, phase],
  );

  const startRecording = async () => {
    if ((phase !== "idle" && phase !== "speaking") || !historyReady) return;
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
      setFlowError(
        "The recording failed. Try again, or type your message instead.",
      );
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
    // Key of the spoken turn once transcribed; if the reply then fails, the
    // turn is marked failed so the owner can resend it as text.
    let spokenTurnKey: string | null = null;
    let gotReply = false;
    try {
      const audio = await blobToBase64(blob);
      const response = await fetch(
        `${import.meta.env.BASE_URL}api/agents/${agentId}/voice-converse`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audio,
            history: contextTurns(),
            ...(pendingDelegationRef.current
              ? {
                  pendingDelegationTargetId:
                    pendingDelegationRef.current.targetAgentId,
                }
              : {}),
          }),
          signal: controller.signal,
        },
      );
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
              spokenTurnKey = appendTurn({ role: "user", text });
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
              gotReply = true;
              appendTurn({ role: "agent", text: String(event.text ?? "") });
              setProposedTask(
                typeof event.proposedTaskObjective === "string"
                  ? event.proposedTaskObjective
                  : null,
              );
              setProposedDelegation(
                event.proposedDelegation &&
                  typeof event.proposedDelegation === "object"
                  ? (event.proposedDelegation as AgentDelegationProposal)
                  : null,
              );
              setPendingDelegation(
                event.pendingDelegation &&
                  typeof event.pendingDelegation === "object"
                  ? (event.pendingDelegation as AgentDelegationTarget)
                  : null,
              );
              expectAudio = event.voice != null;
              // Stay in "thinking" until audio actually arrives, so a failed
              // TTS stream cannot strand the UI in a speaking state.
              setPhase(expectAudio ? "thinking" : "idle");
              break;
            }
            case "audio":
              playback.pushSequencedAudio(
                Number(event.seq ?? 0),
                String(event.data ?? ""),
              );
              setPhase("speaking");
              break;
            case "error":
              setFlowError(String(event.message ?? "Something went wrong."));
              // Fatal errors end the turn server-side; returning here keeps
              // the real message instead of a "connection dropped" fallback.
              if (event.fatal === true) {
                if (spokenTurnKey && !gotReply)
                  setTurnFailed(spokenTurnKey, true);
                return;
              }
              break;
            case "done":
              sawDone = true;
              if (expectAudio) playback.signalComplete();
              break;
          }
        }
      }
      if (
        !sawDone &&
        !controller.signal.aborted &&
        epochRef.current === epoch
      ) {
        setFlowError("The connection dropped mid-reply. Try again.");
        if (spokenTurnKey && !gotReply) setTurnFailed(spokenTurnKey, true);
      }
    } catch (err) {
      if (!controller.signal.aborted && epochRef.current === epoch) {
        setFlowError(
          errorText(
            err,
            "The voice request failed. Check your connection and try again.",
          ),
        );
        if (spokenTurnKey && !gotReply) setTurnFailed(spokenTurnKey, true);
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

  const presence = presenceForStatus(agent.status);
  const canRecord = voiceOn && speechAvailable && recorderSupported;
  const phaseLabel =
    phase === "recording"
      ? "Recording…"
      : phase === "thinking"
        ? "Thinking…"
        : phase === "speaking"
          ? "Speaking…"
          : presence.label;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      <header className="shrink-0 flex items-center gap-3 border-b-4 border-border bg-card p-3">
        {onHangUp && (
          <button
            type="button"
            onClick={onHangUp}
            className="flex items-center justify-center w-9 h-9 shrink-0 border-2 border-border bg-muted/40 text-foreground pixel-shadow"
            aria-label="Back to contacts"
            data-testid="button-hang-up"
          >
            <ChevronLeft className="w-5 h-5" aria-hidden="true" />
          </button>
        )}
        <span className="shrink-0 flex items-center justify-center w-12 h-12 border-2 border-border bg-background/40 overflow-hidden">
          <MarlowLobster
            size={44}
            status={agent.status}
            shellColor={agent.avatar.shellColor}
            seed={agent.id}
          />
        </span>
        <div className="min-w-0">
          <h2 className="font-bold text-sm uppercase truncate">{agent.name}</h2>
          <p className="text-[10px] font-mono uppercase text-muted-foreground truncate flex items-center gap-2">
            <span
              className={`w-2 h-2 shrink-0 ${presence.dotClass} ${
                phase === "idle" ? "" : "animate-pulse"
              }`}
              aria-hidden="true"
            />
            {agent.title} · {phaseLabel}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                disabled={
                  clearHistory.isPending ||
                  turns.length === 0 ||
                  phase !== "idle" ||
                  !historyReady
                }
                className="flex items-center justify-center w-9 h-9 shrink-0 border-2 border-border bg-muted/40 text-foreground pixel-shadow disabled:opacity-50"
                aria-label={`Clear conversation history with ${agent.name}`}
                data-testid="button-clear-history"
              >
                {clearHistory.isPending ? (
                  <Loader2
                    className="w-4 h-4 animate-spin"
                    aria-hidden="true"
                  />
                ) : (
                  <Trash2 className="w-4 h-4" aria-hidden="true" />
                )}
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Clear this conversation?</AlertDialogTitle>
                <AlertDialogDescription>
                  Your entire Talk history with {agent.name} will be deleted,
                  including saved voice transcripts. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel data-testid="button-clear-history-cancel">
                  Keep history
                </AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => clearHistory.mutate({ agentId })}
                  data-testid="button-clear-history-confirm"
                >
                  Clear history
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          {headerAction}
        </div>
      </header>

      <div
        ref={transcriptRef}
        aria-live="polite"
        aria-label={`Conversation with ${agent.name}`}
        className={`flex-1 min-h-0 overflow-y-auto p-4 space-y-3 bg-background/60 ${
          turns.length === 0 ? "flex items-center justify-center" : ""
        }`}
      >
        {turns.length === 0 && (
          <p className="text-xs text-muted-foreground font-mono uppercase text-center">
            {talkHistory.isLoading
              ? "Loading history…"
              : `Say hello to ${agent.name}`}
          </p>
        )}
        {turns.map((turn) => (
          <div
            key={turn.key}
            className={`max-w-[85%] px-3 py-2 text-sm border-2 pixel-shadow ${
              turn.role === "user"
                ? `ml-auto ${
                    turn.failed
                      ? "border-destructive bg-primary/60 text-primary-foreground"
                      : "border-border bg-primary text-primary-foreground"
                  }`
                : "mr-auto border-border bg-card"
            }`}
          >
            <span className="block text-[9px] font-mono uppercase opacity-70">
              {turn.role === "user" ? "You" : agent.name}
            </span>
            {turn.text}
            {turn.attachments && turn.attachments.length > 0 && (
              <span className="mt-2 flex flex-wrap gap-1.5">
                {turn.attachments.map((attachment, index) => (
                  <span
                    key={`${attachment.name}-${index}`}
                    className="inline-flex items-center gap-1 border border-current/30 px-1.5 py-0.5 text-[9px] font-mono"
                  >
                    <FileText className="w-3 h-3" aria-hidden="true" />{" "}
                    {attachmentLabel(attachment)}
                  </span>
                ))}
              </span>
            )}
            {turn.failed && (
              <span className="mt-2 flex items-center gap-2 text-[10px] font-mono uppercase">
                <span className="text-destructive-foreground/90">
                  Not delivered
                </span>
                <button
                  type="button"
                  onClick={() => resendTurn(turn)}
                  disabled={phase !== "idle"}
                  className="flex items-center gap-1 border-2 border-border bg-background px-2 py-0.5 text-foreground disabled:opacity-50"
                  data-testid={`button-resend-${turn.key}`}
                >
                  {phase === "thinking" ? (
                    <Loader2
                      className="w-3 h-3 animate-spin"
                      aria-hidden="true"
                    />
                  ) : (
                    <RotateCcw className="w-3 h-3" aria-hidden="true" />
                  )}
                  Resend
                </button>
              </span>
            )}
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
          <div
            className="mr-auto flex items-center gap-2 text-xs text-muted-foreground"
            role="status"
          >
            <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" />
            {agent.name} is thinking…
          </div>
        )}
      </div>

      {pendingDelegation && !proposedDelegation && (
        <div className="shrink-0 border-t-4 border-border p-3 bg-accent/10 flex items-center gap-3">
          <Network
            className="w-4 h-4 shrink-0 text-accent"
            aria-hidden="true"
          />
          <div className="min-w-0 flex-1">
            <p className="text-xs font-mono uppercase text-accent">
              Hand-off locked to {pendingDelegation.targetAgentName}
            </p>
            <p className="text-[10px] text-muted-foreground mt-1">
              Describe the task. It cannot be reassigned to {agent.name}; say
              “cancel” to stop this hand-off.
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setPendingDelegation(null)}
          >
            Cancel
          </Button>
        </div>
      )}

      {proposedTask && (
        <div className="shrink-0 border-t-4 border-border p-4 bg-accent/10 space-y-2">
          <p className="text-xs font-mono uppercase text-accent flex items-center gap-2">
            <CheckCircle2 className="w-4 h-4" aria-hidden="true" /> Proposed
            task
          </p>
          <p className="text-sm">{proposedTask}</p>
          <p className="text-[10px] text-muted-foreground">
            Say “confirm” (or tap Queue) to create it. Approval policy still
            applies.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={createTask.isPending}
              onClick={() => queueProposedTask(proposedTask)}
            >
              Queue task
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setProposedTask(null)}
            >
              <X className="w-3 h-3 mr-1" aria-hidden="true" /> Dismiss
            </Button>
          </div>
        </div>
      )}

      {proposedDelegation && (
        <div className="shrink-0 border-t-4 border-border p-4 bg-accent/10 space-y-2">
          <p className="text-xs font-mono uppercase text-accent flex items-center gap-2">
            <Network className="w-4 h-4" aria-hidden="true" /> Proposed hand-off
            to {proposedDelegation.targetAgentName}
          </p>
          <p className="text-sm">{proposedDelegation.objective}</p>
          <p className="text-[10px] text-muted-foreground">
            Say “confirm” (or tap Send task) to queue it. Team permissions,
            sandbox isolation, and approval policy are checked again by the
            server.
          </p>
          <div className="flex gap-2">
            <Button
              size="sm"
              disabled={delegateTask.isPending}
              onClick={() => queueProposedDelegation(proposedDelegation)}
            >
              Send task
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => {
                setProposedDelegation(null);
                setPendingDelegation(null);
              }}
            >
              <X className="w-3 h-3 mr-1" aria-hidden="true" /> Dismiss
            </Button>
          </div>
        </div>
      )}

      {(micError || flowError) && (
        <div
          className="shrink-0 border-t-4 border-border p-3 bg-destructive/10 text-destructive text-xs"
          role="alert"
        >
          <div className="space-y-1">
            <strong className="block font-mono uppercase">
              {micError ? "Talk audio error" : "Talk delivery error"}
            </strong>
            <span className="block">{micError ?? flowError}</span>
          </div>
        </div>
      )}

      <div className="shrink-0 border-t-4 border-border bg-card p-4 space-y-3">
        {canRecord ? (
          <div className="flex items-center gap-3 flex-wrap">
            {phase === "recording" ? (
              <Button
                onClick={finishRecording}
                className="bg-destructive text-destructive-foreground"
              >
                <Square className="w-4 h-4 mr-2" aria-hidden="true" /> Stop
                &amp; send
              </Button>
            ) : (
              <Button
                onClick={startRecording}
                disabled={
                  (phase !== "idle" && phase !== "speaking") || !historyReady
                }
                aria-label={`Record a message for ${agent.name}`}
              >
                <Mic className="w-4 h-4 mr-2" aria-hidden="true" /> Record
              </Button>
            )}
            {phase === "recording" && (
              <span
                className="flex items-center gap-2 text-xs text-destructive font-mono uppercase"
                role="status"
              >
                <span
                  className="w-2 h-2 bg-destructive animate-pulse"
                  aria-hidden="true"
                />
                Recording…
              </span>
            )}
            {phase === "speaking" && (
              <>
                <span
                  className="flex items-center gap-2 text-xs text-accent font-mono uppercase"
                  role="status"
                >
                  <Volume2 className="w-4 h-4" aria-hidden="true" />
                  {agent.name} is speaking
                </span>
                <Button size="sm" variant="outline" onClick={interrupt}>
                  <MicOff className="w-3 h-3 mr-1" aria-hidden="true" />{" "}
                  Interrupt
                </Button>
              </>
            )}
          </div>
        ) : (
          <p className="text-[10px] font-mono uppercase text-muted-foreground">
            {!speechAvailable
              ? "Voice is unavailable — this call is text only"
              : !recorderSupported
                ? "This browser cannot record audio — type instead"
                : "Voice mode is off — turn it on in call settings"}
          </p>
        )}

        <input
          ref={attachmentInputRef}
          type="file"
          multiple
          accept={ATTACHMENT_ACCEPT}
          onChange={addAttachments}
          className="hidden"
          data-testid="input-talk-attachments"
        />
        {attachments.length > 0 && (
          <div className="flex flex-wrap gap-2">
            {attachments.map((attachment, index) => (
              <span
                key={`${attachment.name}-${index}`}
                className="inline-flex items-center gap-1.5 border-2 border-border bg-muted px-2 py-1 text-[10px] font-mono"
              >
                <FileText className="w-3 h-3 text-accent" />
                <span className="max-w-40 truncate">
                  {attachmentLabel(attachment)}
                </span>
                <button
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  onClick={() =>
                    setAttachments((current) =>
                      current.filter((_, itemIndex) => itemIndex !== index),
                    )
                  }
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
        <form onSubmit={sendText} className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="icon"
            onClick={() => attachmentInputRef.current?.click()}
            disabled={
              phase === "recording" || attachments.length >= MAX_ATTACHMENTS
            }
            aria-label="Attach images or documents"
            title="Attach images, PDF, or text files (2 MB each)"
          >
            <Paperclip className="w-4 h-4" aria-hidden="true" />
          </Button>
          <Input
            value={textDraft}
            onChange={(e) => setTextDraft(e.target.value)}
            placeholder={`Type to ${agent.name}…`}
            disabled={phase === "recording"}
            aria-label="Type a message"
            className="bg-background border-4 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary"
          />
          <Button
            type="submit"
            disabled={
              (!textDraft.trim() && attachments.length === 0) ||
              phase !== "idle" ||
              !historyReady
            }
            aria-label="Send message"
          >
            <Send className="w-4 h-4" aria-hidden="true" />
          </Button>
        </form>
      </div>
    </div>
  );
}
