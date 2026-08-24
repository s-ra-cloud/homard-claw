/**
 * The only channel through which a model may request an external app action:
 * an explicit, fenced JSON block. Free prose is never interpreted as an
 * action, and a malformed block is surfaced back to the model as an error
 * rather than guessed at.
 */

export type ParsedActionRequest =
  | { ok: true; operation: string; params: unknown; raw: string }
  | { ok: false; error: string; raw: string };

const BLOCK_RE = /<app_action>\s*([\s\S]*?)\s*<\/app_action>/g;

export function parseAppActions(text: string): {
  requests: ParsedActionRequest[];
  /** The output with every action block removed, for use as final prose. */
  cleaned: string;
} {
  const requests: ParsedActionRequest[] = [];
  const cleaned = text
    .replace(BLOCK_RE, (raw, inner: string) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(inner);
      } catch {
        requests.push({ ok: false, error: "The action block is not valid JSON.", raw });
        return "";
      }
      const operation =
        typeof parsed === "object" && parsed !== null
          ? (parsed as { operation?: unknown }).operation
          : undefined;
      if (typeof operation !== "string" || operation.length === 0) {
        requests.push({
          ok: false,
          error: 'The action block must contain an "operation" string.',
          raw,
        });
        return "";
      }
      requests.push({
        ok: true,
        operation,
        params: (parsed as { params?: unknown }).params,
        raw,
      });
      return "";
    })
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return { requests, cleaned };
}
