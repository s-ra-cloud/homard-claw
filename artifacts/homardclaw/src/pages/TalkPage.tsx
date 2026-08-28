/**
 * Talk — a phone contact list of agents, and the call you place from it.
 *
 * On a phone one screen shows at a time (contacts, then the call); from `lg`
 * up the contacts list sits beside the live call. Voice is strictly opt-in:
 * the microphone permission is only requested the moment the owner starts
 * their first recording, never on page load. Text chat is always available as
 * a fallback, including when the managed speech service is unavailable.
 */
import { useEffect, useState } from "react";
import { useLocation, useRoute } from "wouter";
import {
  useGetVoiceStatus,
  useListAgents,
  useUpdateVoiceSettings,
} from "@workspace/api-client-react";
import {
  useAudioPlayback,
  useVoiceRecorder,
} from "@workspace/integrations-openai-ai-react/audio";
import { Shell } from "@/components/layout/Shell";
import { CallView } from "@/components/talk/call-view";
import { ContactList } from "@/components/talk/contact-list";
import { TalkSettings } from "@/components/talk/talk-settings";
import { useIsDesktop } from "@/hooks/use-mobile";
import { useToast } from "@/hooks/use-toast";
import { useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Phone } from "lucide-react";

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export default function TalkPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [, setLocation] = useLocation();
  const [, routeParams] = useRoute("/talk/:agentId");
  const isDesktop = useIsDesktop();

  const { data: agents, isLoading } = useListAgents();
  const { data: voiceStatus } = useGetVoiceStatus();
  const [voiceOn, setVoiceOn] = useState(false);

  // One recorder and one playback context for the whole page, so switching
  // contacts can never leave a second AudioContext behind.
  const recorder = useVoiceRecorder();
  const playback = useAudioPlayback(
    `${import.meta.env.BASE_URL}audio-playback-worklet.js`,
  );

  // listAgents already excludes retired and archived agents.
  const conversableAgents = agents ?? [];
  const routedId = routeParams?.agentId ?? null;
  const agent = conversableAgents.find((a) => a.id === routedId) ?? null;
  const speechAvailable = voiceStatus?.available ?? false;
  const recorderSupported =
    typeof window !== "undefined" &&
    typeof MediaRecorder !== "undefined" &&
    !!navigator.mediaDevices?.getUserMedia;

  // A stale or hand-typed agent id falls back to the contacts list.
  useEffect(() => {
    if (routedId && !isLoading && agents && !agent) {
      setLocation("/talk", { replace: true });
    }
  }, [routedId, isLoading, agents, agent, setLocation]);

  const updateSettings = useUpdateVoiceSettings({
    mutation: {
      onSuccess: () =>
        void queryClient.invalidateQueries({ queryKey: ["/api/voice/status"] }),
      onError: (err) =>
        toast({
          title: "Could not update Talk settings",
          description: errorText(err, "Try again."),
          variant: "destructive",
        }),
    },
  });

  const settingsFor = (idPrefix: string) => (
    <TalkSettings
      idPrefix={idPrefix}
      voiceOn={voiceOn}
      onVoiceOnChange={setVoiceOn}
      speechAvailable={speechAvailable}
      recorderSupported={recorderSupported}
      transcriptsEnabled={voiceStatus?.transcriptsEnabled ?? false}
      transcriptsPending={!voiceStatus || updateSettings.isPending}
      onTranscriptsChange={(on) =>
        updateSettings.mutate({ data: { transcriptsEnabled: on } })
      }
      autoApproveTalkTasks={voiceStatus?.autoApproveTalkTasks ?? false}
      autoApprovePending={!voiceStatus || updateSettings.isPending}
      onAutoApproveTalkTasksChange={(on) =>
        updateSettings.mutate({ data: { autoApproveTalkTasks: on } })
      }
    />
  );

  const inCall = agent !== null;

  return (
    <Shell>
      <div className="flex h-full min-h-0 flex-col lg:flex-row">
        {/* Contacts — the phone's home screen, a column on desktop. */}
        <section
          aria-label="Crustabot contacts"
          className={`min-h-0 flex-1 lg:flex-none lg:w-80 xl:w-96 lg:border-r-4 lg:border-border ${
            inCall ? "hidden lg:block" : "block"
          }`}
        >
          <ContactList
            agents={conversableAgents}
            isLoading={isLoading}
            selectedId={routedId}
            onSelect={(id) => setLocation(`/talk/${id}`)}
            headerAction={settingsFor("contacts")}
            notice={
              voiceStatus && !voiceStatus.available ? (
                <div className="flex items-start gap-2 p-3 bg-accent/10 text-xs">
                  <AlertTriangle
                    className="w-4 h-4 mt-0.5 shrink-0 text-accent"
                    aria-hidden="true"
                  />
                  <p>
                    {voiceStatus.reason ??
                      "Voice is unavailable; text chat still works."}
                  </p>
                </div>
              ) : null
            }
          />
        </section>

        {/* Call — the only screen on a phone once a contact is tapped. */}
        <section
          aria-label="Call"
          className={`min-h-0 flex-1 ${inCall ? "block" : "hidden lg:block"}`}
        >
          {agent ? (
            <CallView
              key={agent.id}
              agent={agent}
              recorder={recorder}
              playback={playback}
              voiceOn={voiceOn}
              speechAvailable={speechAvailable}
              recorderSupported={recorderSupported}
              autoApproveTalkTasks={voiceStatus?.autoApproveTalkTasks ?? false}
              onHangUp={isDesktop ? undefined : () => setLocation("/talk")}
              onOpenAgent={() => setLocation(`/agents/${agent.id}/edit`)}
            />
          ) : (
            <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
              <Phone className="w-8 h-8 text-primary" aria-hidden="true" />
              <p className="font-display text-xs uppercase text-primary">
                No call in progress
              </p>
              <p className="text-xs font-mono uppercase text-muted-foreground">
                Pick a contact to start talking
              </p>
            </div>
          )}
        </section>
      </div>
    </Shell>
  );
}
