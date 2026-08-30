import {
  capabilityPackagesTable,
  db,
  type CapabilityPackageRecord,
} from "@workspace/db";
import { and, eq } from "drizzle-orm";
import { recordAudit } from "../audit";
import type { AppOperation } from "../connected-apps/catalog";
import { findOperation } from "../connected-apps/catalog";
import { listActiveCustomApiManifests } from "../connected-apps/custom-apis";
import {
  computePermissionDiff,
  isCapabilityManifest,
  manifestFingerprint,
  renderTargetTemplate,
  signInstallRow,
  verifyInstallSignature,
  type CapabilityManifest,
  type CapabilityPermissionDiff,
  type CapabilityRecoveryClass,
  type CapabilityToolDef,
} from "./manifest";
import {
  findRegistryEntry,
  isBuiltinPackageId,
  listRegistryEntries,
} from "./registry";

/**
 * Workspace-facing capability resolution. Built-in packages (gmail, drive,
 * github) are implicitly installed for every workspace — that is exactly the
 * pre-package behavior, preserved. Optional packages resolve only from a
 * pinned, active install row belonging to THIS workspace; nothing installed
 * elsewhere ever leaks across the tenancy boundary.
 */

/** A tool an agent could be granted, resolved against the pinned manifest. */
export type ResolvedCapabilityTool = {
  name: string;
  packageId: string;
  packageDisplayName: string;
  description: string;
  level: "read" | "draft" | "write";
  def: CapabilityToolDef;
  /** Built-in tools keep their original programmatic target/params. */
  builtinOp: AppOperation | null;
  manifest: CapabilityManifest;
  recovery: CapabilityRecoveryClass;
};

export type WorkspaceCapabilities = {
  /** packageId → pinned manifest, for every usable package. */
  packages: Map<string, CapabilityManifest>;
  /** fully-qualified tool name → resolved tool. */
  tools: Map<string, ResolvedCapabilityTool>;
};

function resolveTools(
  manifest: CapabilityManifest,
  tools: Map<string, ResolvedCapabilityTool>,
): void {
  for (const def of manifest.tools) {
    // A manifest tool must live under its package's namespace: a package can
    // never shadow another package's (or a built-in's) operation name.
    if (!def.name.startsWith(`${manifest.id}.`)) continue;
    tools.set(def.name, {
      name: def.name,
      packageId: manifest.id,
      packageDisplayName: manifest.displayName,
      description: def.description,
      level: def.level,
      def,
      builtinOp:
        def.executor.kind === "builtin" ? findOperation(def.name) : null,
      manifest,
      recovery: def.recovery,
    });
  }
}

/**
 * Is a pinned install row still trustworthy? Quarantine rules:
 * - the snapshot must still hash to its recorded fingerprint;
 * - the registry must still carry the package;
 * - if the registry serves the SAME version with a DIFFERENT fingerprint,
 *   the vetted content changed under our feet — never silently serve it.
 * A newer registry version does not disable the pinned one; it only offers
 * an update for review.
 */
export function assessInstallRow(row: CapabilityPackageRecord):
  | { usable: true; manifest: CapabilityManifest }
  | { usable: false; reason: string } {
  const manifest = row.manifest as unknown;
  if (!isCapabilityManifest(manifest)) {
    return { usable: false, reason: "The pinned manifest snapshot is malformed." };
  }
  if (manifestFingerprint(manifest) !== row.fingerprint) {
    return {
      usable: false,
      reason: "The pinned manifest no longer matches its recorded fingerprint.",
    };
  }
  if (manifest.id !== row.packageId || manifest.version !== row.installedVersion) {
    return {
      usable: false,
      reason: "The pinned manifest does not match the row's package identity.",
    };
  }
  // The fingerprint alone is recomputable by anyone who can edit the row, so
  // the row also carries a server-keyed HMAC. Without the server's signing
  // key a tampered/copied/version-swapped row fails here and quarantines.
  if (
    !verifyInstallSignature(
      {
        workspaceId: row.workspaceId,
        packageId: row.packageId,
        version: row.installedVersion,
        fingerprint: row.fingerprint,
      },
      row.installSignature,
    )
  ) {
    return {
      usable: false,
      reason:
        "The install record failed server signature verification — it was not written by this server.",
    };
  }
  const entry = findRegistryEntry(row.packageId);
  if (!entry) {
    return {
      usable: false,
      reason: "This package was removed from the vetted registry.",
    };
  }
  if (
    entry.manifest.version === row.installedVersion &&
    manifestFingerprint(entry.manifest) !== row.fingerprint
  ) {
    return {
      usable: false,
      reason:
        "The registry's content changed for the installed version — the package is quarantined until re-reviewed.",
    };
  }
  return { usable: true, manifest };
}

/** The built-in packages alone, workspace-independent (fallback catalog). */
export function builtinCapabilities(): WorkspaceCapabilities {
  const packages = new Map<string, CapabilityManifest>();
  const tools = new Map<string, ResolvedCapabilityTool>();
  for (const entry of listRegistryEntries()) {
    if (entry.manifest.builtin) {
      packages.set(entry.manifest.id, entry.manifest);
      resolveTools(entry.manifest, tools);
    }
  }
  return { packages, tools };
}

/** Load every usable capability for a workspace (built-ins + active installs). */
export async function loadWorkspaceCapabilities(
  workspaceId: string | null,
): Promise<WorkspaceCapabilities> {
  const packages = new Map<string, CapabilityManifest>();
  const tools = new Map<string, ResolvedCapabilityTool>();
  for (const entry of listRegistryEntries()) {
    if (entry.manifest.builtin) {
      packages.set(entry.manifest.id, entry.manifest);
      resolveTools(entry.manifest, tools);
    }
  }
  if (!workspaceId) return { packages, tools };
  // Owner-whitelisted custom APIs resolve as workspace-pinned packages:
  // the manifest is synthesized from the current row, its version is the
  // definition revision, and disabled/malformed rows contribute nothing.
  for (const manifest of await listActiveCustomApiManifests(workspaceId)) {
    packages.set(manifest.id, manifest);
    resolveTools(manifest, tools);
  }
  const rows = await db
    .select()
    .from(capabilityPackagesTable)
    .where(eq(capabilityPackagesTable.workspaceId, workspaceId));
  for (const row of rows) {
    // Quarantined rows never serve. A row parked in update_review keeps
    // serving its PINNED manifest — the pending version's tools stay
    // invisible until the owner accepts the permission diff.
    if (row.status === "quarantined") continue;
    if (isBuiltinPackageId(row.packageId)) continue;
    const assessed = assessInstallRow(row);
    if (!assessed.usable) continue;
    packages.set(row.packageId, assessed.manifest);
    resolveTools(assessed.manifest, tools);
  }
  return { packages, tools };
}

/** The update state a GET should surface for one installed row. */
export type InstallUpdateState = {
  status: "active" | "update_review" | "quarantined";
  quarantineReason: string | null;
  availableVersion: string | null;
  permissionDiff: CapabilityPermissionDiff | null;
};

/**
 * Reconcile one install row against the current registry, persisting status
 * transitions (quarantine, update_review) so the worker path — which only
 * trusts status === "active" — always fails closed on drift. Non-expanding
 * updates apply immediately: nothing about them needs an owner decision.
 */
export async function refreshInstallRow(
  row: CapabilityPackageRecord,
): Promise<CapabilityPackageRecord> {
  const assessed = assessInstallRow(row);
  if (!assessed.usable) {
    if (row.status === "quarantined" && row.quarantineReason === assessed.reason) {
      return row;
    }
    const [updated] = await db
      .update(capabilityPackagesTable)
      .set({
        status: "quarantined",
        quarantineReason: assessed.reason,
        updatedAt: new Date(),
      })
      .where(eq(capabilityPackagesTable.id, row.id))
      .returning();
    await recordAudit(
      row.workspaceId,
      "capability.quarantined",
      `The "${row.packageId}" capability package was quarantined: ${assessed.reason}`,
    );
    return updated ?? row;
  }
  const entry = findRegistryEntry(row.packageId);
  if (!entry) return row;
  if (entry.manifest.version === row.installedVersion) {
    // Up to date; clear any stale pending/quarantine state.
    if (row.status === "active" && !row.pendingVersion) return row;
    const [updated] = await db
      .update(capabilityPackagesTable)
      .set({
        status: "active",
        quarantineReason: null,
        pendingVersion: null,
        pendingFingerprint: null,
        pendingManifest: null,
        pendingDiff: null,
        updatedAt: new Date(),
      })
      .where(eq(capabilityPackagesTable.id, row.id))
      .returning();
    return updated ?? row;
  }
  const diff = computePermissionDiff(assessed.manifest, entry.manifest);
  const newFingerprint = manifestFingerprint(entry.manifest);
  if (!diff.expandsPermissions) {
    const autoSignature = signInstallRow({
      workspaceId: row.workspaceId,
      packageId: row.packageId,
      version: entry.manifest.version,
      fingerprint: newFingerprint,
    });
    if (!autoSignature) return row; // no key: keep the pinned version serving
    const [updated] = await db
      .update(capabilityPackagesTable)
      .set({
        installedVersion: entry.manifest.version,
        fingerprint: newFingerprint,
        installSignature: autoSignature,
        manifest: entry.manifest as unknown as Record<string, unknown>,
        status: "active",
        pendingVersion: null,
        pendingFingerprint: null,
        pendingManifest: null,
        pendingDiff: null,
        quarantineReason: null,
        updatedAt: new Date(),
      })
      .where(eq(capabilityPackagesTable.id, row.id))
      .returning();
    await recordAudit(
      row.workspaceId,
      "capability.updated",
      `The "${row.packageId}" capability package was updated to ${entry.manifest.version} (no permission changes).`,
    );
    return updated ?? row;
  }
  // Permission-expanding: park for review. The pinned version keeps serving.
  if (
    row.status === "update_review" &&
    row.pendingVersion === entry.manifest.version &&
    row.pendingFingerprint === newFingerprint
  ) {
    return row;
  }
  const [updated] = await db
    .update(capabilityPackagesTable)
    .set({
      status: "update_review",
      pendingVersion: entry.manifest.version,
      pendingFingerprint: newFingerprint,
      pendingManifest: entry.manifest as unknown as Record<string, unknown>,
      pendingDiff: diff as unknown as Record<string, unknown>,
      updatedAt: new Date(),
    })
    .where(eq(capabilityPackagesTable.id, row.id))
    .returning();
  return updated ?? row;
}

/** Install an optional package for a workspace, pinned at the registry version. */
export async function installPackage(
  workspaceId: string,
  packageId: string,
): Promise<
  | { ok: true; row: CapabilityPackageRecord }
  | { ok: false; error: "unknown_package" | "builtin" | "already_installed" }
> {
  const entry = findRegistryEntry(packageId);
  if (!entry) return { ok: false, error: "unknown_package" };
  if (entry.manifest.builtin) return { ok: false, error: "builtin" };
  const existing = await db
    .select()
    .from(capabilityPackagesTable)
    .where(
      and(
        eq(capabilityPackagesTable.workspaceId, workspaceId),
        eq(capabilityPackagesTable.packageId, packageId),
      ),
    )
    .limit(1);
  if (existing.length > 0) return { ok: false, error: "already_installed" };
  const fingerprint = manifestFingerprint(entry.manifest);
  const signature = signInstallRow({
    workspaceId,
    packageId,
    version: entry.manifest.version,
    fingerprint,
  });
  if (!signature) {
    // Fail closed: without the signing key an install could never resolve.
    throw new Error("Capability install signing key is not configured.");
  }
  const row = await db.transaction(async (tx) => {
    const [inserted] = await tx
      .insert(capabilityPackagesTable)
      .values({
        workspaceId,
        packageId,
        installedVersion: entry.manifest.version,
        fingerprint,
        manifest: entry.manifest as unknown as Record<string, unknown>,
        installSignature: signature,
        status: "active",
      })
      .returning();
    await recordAudit(
      workspaceId,
      "capability.installed",
      `The "${packageId}" capability package v${entry.manifest.version} was installed.`,
      tx,
    );
    return inserted!;
  });
  return { ok: true, row };
}

/** Apply a pending permission-expanding update after the owner reviewed it. */
export async function applyPendingUpdate(
  workspaceId: string,
  packageId: string,
): Promise<
  | { ok: true; row: CapabilityPackageRecord }
  | { ok: false; error: "not_installed" | "no_pending_update" | "registry_mismatch" }
> {
  const [row] = await db
    .select()
    .from(capabilityPackagesTable)
    .where(
      and(
        eq(capabilityPackagesTable.workspaceId, workspaceId),
        eq(capabilityPackagesTable.packageId, packageId),
      ),
    )
    .limit(1);
  if (!row) return { ok: false, error: "not_installed" };
  if (row.status !== "update_review" || !row.pendingVersion || !row.pendingManifest) {
    return { ok: false, error: "no_pending_update" };
  }
  // The accepted diff must be the diff that is still on offer: if the
  // registry moved again since the owner looked, force a fresh review.
  const entry = findRegistryEntry(packageId);
  if (
    !entry ||
    entry.manifest.version !== row.pendingVersion ||
    manifestFingerprint(entry.manifest) !== row.pendingFingerprint
  ) {
    return { ok: false, error: "registry_mismatch" };
  }
  const acceptSignature = signInstallRow({
    workspaceId,
    packageId,
    version: row.pendingVersion,
    fingerprint: row.pendingFingerprint!,
  });
  if (!acceptSignature) {
    throw new Error("Capability install signing key is not configured.");
  }
  const updated = await db.transaction(async (tx) => {
    const [next] = await tx
      .update(capabilityPackagesTable)
      .set({
        installedVersion: row.pendingVersion!,
        fingerprint: row.pendingFingerprint!,
        installSignature: acceptSignature,
        manifest: row.pendingManifest!,
        status: "active",
        pendingVersion: null,
        pendingFingerprint: null,
        pendingManifest: null,
        pendingDiff: null,
        quarantineReason: null,
        updatedAt: new Date(),
      })
      .where(eq(capabilityPackagesTable.id, row.id))
      .returning();
    await recordAudit(
      workspaceId,
      "capability.updated",
      `The "${packageId}" capability package update to v${row.pendingVersion} was reviewed and accepted.`,
      tx,
    );
    return next!;
  });
  return { ok: true, row: updated };
}

/** Uninstall an optional package (built-ins cannot be removed). */
export async function uninstallPackage(
  workspaceId: string,
  packageId: string,
): Promise<{ ok: boolean }> {
  const deleted = await db
    .delete(capabilityPackagesTable)
    .where(
      and(
        eq(capabilityPackagesTable.workspaceId, workspaceId),
        eq(capabilityPackagesTable.packageId, packageId),
      ),
    )
    .returning();
  if (deleted.length > 0) {
    await recordAudit(
      workspaceId,
      "capability.uninstalled",
      `The "${packageId}" capability package was uninstalled.`,
    );
  }
  return { ok: deleted.length > 0 };
}

export async function listInstallRows(
  workspaceId: string,
): Promise<CapabilityPackageRecord[]> {
  return db
    .select()
    .from(capabilityPackagesTable)
    .where(eq(capabilityPackagesTable.workspaceId, workspaceId));
}

/** Render a tool's human "what/where" summary for approvals and audit. */
export function capabilityTarget(
  tool: ResolvedCapabilityTool,
  params: Record<string, unknown>,
): string {
  if (tool.builtinOp) return tool.builtinOp.target(params).slice(0, 300);
  return renderTargetTemplate(tool.def.targetTemplate, params);
}
