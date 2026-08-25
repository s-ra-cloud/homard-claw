import { useState } from "react";
import { Settings2 } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Voice mode and transcript storage, tucked behind one gear so the phone call
 * view stays a call view. Rendered in both the contacts header and the call
 * header, so the settings are reachable from whichever screen is on top.
 */
export interface TalkSettingsProps {
  voiceOn: boolean;
  onVoiceOnChange: (on: boolean) => void;
  speechAvailable: boolean;
  recorderSupported: boolean;
  transcriptsEnabled: boolean;
  transcriptsPending: boolean;
  onTranscriptsChange: (on: boolean) => void;
  /** Whether this workspace has stored its own OpenAI voice key. */
  voiceKeyConfigured: boolean;
  voiceKeyPending: boolean;
  onSaveVoiceKey: (key: string) => void;
  onRemoveVoiceKey: () => void;
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
  voiceKeyConfigured,
  voiceKeyPending,
  onSaveVoiceKey,
  onRemoveVoiceKey,
  idPrefix,
}: TalkSettingsProps) {
  const [keyDraft, setKeyDraft] = useState("");
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
          <p className="font-display text-[10px] uppercase tracking-tight">Call settings</p>
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
                Off by default; saved chats appear under agent messages
              </span>
            </label>
            <Switch
              id={`${idPrefix}-transcripts`}
              checked={transcriptsEnabled}
              disabled={transcriptsPending}
              onCheckedChange={onTranscriptsChange}
            />
          </div>
          <div className="space-y-2 border-t-2 border-border pt-3">
            <label
              htmlFor={`${idPrefix}-voice-key`}
              className="text-[10px] font-mono uppercase text-muted-foreground"
            >
              OpenAI voice key
              <span className="block normal-case text-muted-foreground/80">
                {voiceKeyConfigured
                  ? "A key is stored (encrypted, never shown). Paste to replace it."
                  : "Voice calls use your own OpenAI API key."}
              </span>
            </label>
            <Input
              id={`${idPrefix}-voice-key`}
              type="password"
              value={keyDraft}
              onChange={(event) => setKeyDraft(event.target.value)}
              placeholder="sk-..."
              spellCheck={false}
              autoComplete="off"
              className="font-mono text-[11px] h-8 bg-background border-2 border-border rounded-none focus-visible:ring-0 focus-visible:border-primary"
              data-testid={`input-${idPrefix}-voice-key`}
            />
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={voiceKeyPending || keyDraft.trim().length < 8}
                onClick={() => {
                  const pasted = keyDraft.trim();
                  // Cleared as it leaves the browser — a key has no business
                  // sitting in a text box.
                  setKeyDraft("");
                  onSaveVoiceKey(pasted);
                }}
                data-testid={`button-${idPrefix}-save-voice-key`}
              >
                {voiceKeyPending ? "SAVING..." : "SAVE KEY"}
              </Button>
              {voiceKeyConfigured && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={voiceKeyPending}
                  onClick={onRemoveVoiceKey}
                  data-testid={`button-${idPrefix}-remove-voice-key`}
                >
                  REMOVE
                </Button>
              )}
            </div>
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
