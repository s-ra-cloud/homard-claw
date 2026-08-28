import { Settings2 } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";

/**
 * Talk preferences, tucked behind one gear so the phone call view stays a
 * call view. Rendered in both the contacts header and the call header, so the
 * settings are reachable from whichever screen is on top.
 */
export interface TalkSettingsProps {
  voiceOn: boolean;
  onVoiceOnChange: (on: boolean) => void;
  speechAvailable: boolean;
  recorderSupported: boolean;
  transcriptsEnabled: boolean;
  transcriptsPending: boolean;
  onTranscriptsChange: (on: boolean) => void;
  autoApproveTalkTasks: boolean;
  autoApprovePending: boolean;
  onAutoApproveTalkTasksChange: (on: boolean) => void;
  /** Distinguishes the two mounted copies for the switch ids. */
  idPrefix: string;
}

export function TalkSettings({
  voiceOn,
  onVoiceOnChange,
  speechAvailable,
  recorderSupported,
  transcriptsEnabled,
  transcriptsPending,
  onTranscriptsChange,
  autoApproveTalkTasks,
  autoApprovePending,
  onAutoApproveTalkTasksChange,
  idPrefix,
}: TalkSettingsProps) {
  return (
    <Popover>
      <PopoverTrigger
        className="flex items-center justify-center w-9 h-9 shrink-0 border-2 border-border bg-muted/40 text-foreground pixel-shadow hover:bg-muted"
        aria-label="Call settings"
        title="Call settings"
      >
        <Settings2 className="w-4 h-4" aria-hidden="true" />
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-72 rounded-none border-4 border-border bg-card p-0 pixel-shadow"
      >
        <div className="border-b-4 border-border bg-muted/30 p-3">
          <p className="font-display text-[10px] uppercase tracking-tight">
            Call settings
          </p>
        </div>
        <div className="p-3 space-y-4">
          <div className="flex items-start justify-between gap-3">
            <label
              htmlFor={`${idPrefix}-voice-mode`}
              className="text-[10px] font-mono uppercase text-muted-foreground"
            >
              Voice mode
              <span className="block normal-case text-muted-foreground/80">
                Mic is only requested when you record
              </span>
            </label>
            <Switch
              id={`${idPrefix}-voice-mode`}
              checked={voiceOn}
              disabled={!speechAvailable || !recorderSupported}
              onCheckedChange={onVoiceOnChange}
            />
          </div>
          <div className="flex items-start justify-between gap-3 border-t-2 border-border pt-3">
            <label
              htmlFor={`${idPrefix}-transcripts`}
              className="text-[10px] font-mono uppercase text-muted-foreground"
            >
              Save transcripts
              <span className="block normal-case text-muted-foreground/80">
                Off by default; saved chats appear under Crustabot messages
              </span>
            </label>
            <Switch
              id={`${idPrefix}-transcripts`}
              checked={transcriptsEnabled}
              disabled={transcriptsPending}
              onCheckedChange={onTranscriptsChange}
            />
          </div>
          <div className="flex items-start justify-between gap-3 border-t-2 border-border pt-3">
            <label
              htmlFor={`${idPrefix}-auto-approve-talk`}
              className="text-[10px] font-mono uppercase text-muted-foreground"
            >
              Auto-approve Talk tasks
              <span className="block normal-case text-muted-foreground/80">
                Signs off on the initial run for tasks confirmed here. Hard
                safety limits and connected-app actions still apply.
              </span>
            </label>
            <Switch
              id={`${idPrefix}-auto-approve-talk`}
              checked={autoApproveTalkTasks}
              disabled={autoApprovePending}
              onCheckedChange={onAutoApproveTalkTasksChange}
            />
          </div>
          {!recorderSupported && (
            <p className="text-[10px] text-muted-foreground border-t-2 border-border pt-3">
              This browser cannot record audio; type your messages instead.
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
