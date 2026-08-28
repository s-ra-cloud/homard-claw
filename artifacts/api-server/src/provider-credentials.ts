/**
 * Per-workspace AI provider credentials.
 *
 * Claude Code tokens, OpenRouter API keys, and the OpenAI key that pays
 * for voice speech services are entered in the app by each workspace's own
 * user and stored here encrypted. Every execution path resolves the
 * credential from a workspace id — never from server environment
 * variables — so one workspace can never spend another workspace's (or
 * the operator's) allowance. A workspace without a stored credential
 * fails closed with a clear, non-sensitive configuration error.
 *
 * Only the AES-256-GCM ciphertext is durable; plaintext is decrypted per
 * call and never logged, returned, or audited.
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { db, providerCredentialsTable } from "@workspace/db";
import { and, eq } from "drizzle-orm";

/**
 * Credentials stored per workspace. "openai_voice" is not a task-routing
 * provider: it is the OpenAI API key that pays for speech-to-text and
 * text-to-speech in voice conversations.
 */
export type CredentialedProvider = "claude_max" | "openrouter" | "openai_voice";

export const CREDENTIALED_PROVIDERS: CredentialedProvider[] = [
  "claude_max",
  "openrouter",
  "openai_voice",
];

/**
 * Claude Code subscription OAuth tokens require both beta capabilities.
 * Sending only oauth-2025-04-20 makes Anthropic reject an otherwise valid
 * setup-token credential with HTTP 401.
 */
export const CLAUDE_CODE_OAUTH_BETAS =
  "oauth-2025-04-20,claude-code-20250219";

export function isCredentialedProvider(
  value: string,
): value is CredentialedProvider {
  return (CREDENTIALED_PROVIDERS as string[]).includes(value);
}

export class ProviderCredentialError extends Error {
  constructor(
    /**
     * "reenter_required" — a credential exists but cannot be decrypted
     * (usually a rotated SESSION_SECRET); the user must enter it again.
     * "unavailable" — a server configuration problem unrelated to the
     * stored credential (e.g. SESSION_SECRET missing entirely).
     */
    readonly kind: "reenter_required" | "unavailable",
    message: string,
  ) {
    super(message);
    this.name = "ProviderCredentialError";
  }
}

const FORMAT = "v1";

/**
 * Key derived from SESSION_SECRET with its own label (never shared with
 * the Google, GitHub, or Codex stores). Rotating SESSION_SECRET makes
 * stored credentials undecryptable, which surfaces as "re-enter the key" —
 * never as silence and never as someone else's credential.
 */
function encryptionKey(): Buffer {
  const secret = process.env.SESSION_SECRET?.trim();
  if (!secret || secret.length < 8) {
    throw new ProviderCredentialError(
      "unavailable",
      "SESSION_SECRET is not set on this server, so provider credentials cannot be stored securely.",
    );
  }
  return createHash("sha256").update(`provider-credential:${secret}`).digest();
}

export function encryptProviderCredential(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const sealed = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  return [
    FORMAT,
    iv.toString("base64"),
    cipher.getAuthTag().toString("base64"),
    sealed.toString("base64"),
  ].join(".");
}

function decryptProviderCredential(payload: string): string {
  const [format, iv, tag, sealed] = payload.split(".");
  if (format !== FORMAT || !iv || !tag || !sealed) {
    throw new ProviderCredentialError(
      "reenter_required",
      "The stored credential is not in a format this server understands. Enter the key again.",
    );
  }
  try {
    const decipher = createDecipheriv(
      "aes-256-gcm",
      encryptionKey(),
      Buffer.from(iv, "base64"),
    );
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([
      decipher.update(Buffer.from(sealed, "base64")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof ProviderCredentialError) throw error;
    throw new ProviderCredentialError(
      "reenter_required",
      "The stored credential could not be decrypted, usually because SESSION_SECRET changed. Enter the key again.",
    );
  }
}

/** Store (or replace) a workspace's credential for one provider. */
export async function saveProviderCredential(
  workspaceId: string,
  provider: CredentialedProvider,
  plaintext: string,
): Promise<void> {
  const credentialEnc = encryptProviderCredential(plaintext.trim());
  await db
    .insert(providerCredentialsTable)
    .values({ workspaceId, provider, credentialEnc })
    .onConflictDoUpdate({
      target: [
        providerCredentialsTable.workspaceId,
        providerCredentialsTable.provider,
      ],
      set: { credentialEnc, updatedAt: new Date() },
    });
}

/** Remove a workspace's credential. Returns whether one existed. */
export async function deleteProviderCredential(
  workspaceId: string,
  provider: CredentialedProvider,
): Promise<boolean> {
  const removed = await db
    .delete(providerCredentialsTable)
    .where(
      and(
        eq(providerCredentialsTable.workspaceId, workspaceId),
        eq(providerCredentialsTable.provider, provider),
      ),
    )
    .returning({ provider: providerCredentialsTable.provider });
  return removed.length > 0;
}

/**
 * Decrypt and return the workspace's credential, or null when none is
 * stored. Throws ProviderCredentialError("reenter_required") when a row
 * exists but cannot be decrypted — callers surface that as "enter the key
 * again", never fall back to anything shared.
 */
export async function getProviderCredential(
  workspaceId: string,
  provider: CredentialedProvider,
): Promise<string | null> {
  if (!workspaceId) return null;
  const [row] = await db
    .select({ credentialEnc: providerCredentialsTable.credentialEnc })
    .from(providerCredentialsTable)
    .where(
      and(
        eq(providerCredentialsTable.workspaceId, workspaceId),
        eq(providerCredentialsTable.provider, provider),
      ),
    )
    .limit(1);
  if (!row) return null;
  const plaintext = decryptProviderCredential(row.credentialEnc).trim();
  return plaintext === "" ? null : plaintext;
}

/**
 * Cheap existence check for dispatch/health paths. A stored-but-corrupt
 * credential still reads as configured here; execution surfaces the
 * precise re-enter error when it actually tries to use it.
 */
export async function hasProviderCredential(
  workspaceId: string,
  provider: CredentialedProvider,
): Promise<boolean> {
  if (!workspaceId) return false;
  const [row] = await db
    .select({ provider: providerCredentialsTable.provider })
    .from(providerCredentialsTable)
    .where(
      and(
        eq(providerCredentialsTable.workspaceId, workspaceId),
        eq(providerCredentialsTable.provider, provider),
      ),
    )
    .limit(1);
  return Boolean(row);
}
