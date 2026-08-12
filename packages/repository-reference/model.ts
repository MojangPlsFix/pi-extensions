import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

export const RepositoryReferenceParams = Type.Object({
  action: StringEnum(["clone", "list", "remove", "cleanup"] as const),
  remote: Type.Optional(
    Type.String({ description: "Validated Git remote URL (https, http, ssh, or git)" }),
  ),
  revision: Type.Optional(
    Type.String({ description: "Validated branch, tag, ref, or commit revision" }),
  ),
  verbose: Type.Optional(
    Type.Boolean({ description: "Include more detailed, sanitized Git diagnostics for clone" }),
  ),
  id: Type.Optional(Type.String({ description: "Managed reference id returned by clone/list" })),
});

export type RepositoryReferenceAction = "clone" | "list" | "remove" | "cleanup";

export type RepositoryReference = {
  id: string;
  remote: string;
  revision: string;
  resolvedRevision: string;
  path: string;
  createdAt: string;
};

export type RepositoryReferencePhase = "clone" | "resolve-revision" | "checkout" | "metadata";

export type RepositoryReferenceDiagnostics = {
  phase: RepositoryReferencePhase;
  stderr?: string;
  stdout?: string;
  attemptedRefs?: string[];
  exitCode?: number;
  signal?: string;
  timedOut?: boolean;
  cancelled?: boolean;
};

export type RepositoryReferenceProgress = {
  phase: RepositoryReferencePhase;
  message: string;
  output?: string;
  diagnostics?: RepositoryReferenceDiagnostics;
};

export type RepositoryReferenceCloneDetails = {
  action: "clone";
  phase?: RepositoryReferencePhase;
  status?: string;
  progress?: string[];
  diagnostics?: RepositoryReferenceDiagnostics;
  reference?: RepositoryReference;
  error?: string;
};

export type RepositoryReferenceDetails =
  | RepositoryReferenceCloneDetails
  | { action: "list" | "cleanup"; references: RepositoryReference[]; error?: string }
  | { action: "remove"; id: string; error?: string };

const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);
const SCP_REMOTE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@:+~^=-]*$/;
const REFERENCE_ID = /^ref-[A-Za-z0-9]{1,60}$/;

export function redactRemote(remote: string): string {
  if (SCP_REMOTE.test(remote)) return remote;
  try {
    const parsed = new URL(remote);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return remote.replace(/:\/\/[^/\s@]+@/g, "://[redacted]@");
  }
}

export function sanitizeGitOutput(output: string, remote?: string): string {
  let sanitized = output;
  if (remote) sanitized = sanitized.replaceAll(remote, redactRemote(remote));
  return sanitized
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, "$1[redacted]@")
    .replace(
      /([?&](?:access[_-]?token|auth|key|password|passwd|secret|token)=)[^&\s]*/gi,
      "$1[redacted]",
    );
}

export function validateRemote(value: unknown): { remote: string } | { error: string } {
  if (typeof value !== "string" || !value.trim()) return { error: "remote is required" };
  const remote = value;
  if (remote.length > 2048 || /[\u0000-\u001f\u007f\s]/.test(remote))
    return { error: "remote must be a single supported Git URL without whitespace" };
  if (SCP_REMOTE.test(remote)) return { remote };
  try {
    const parsed = new URL(remote);
    if (!REMOTE_PROTOCOLS.has(parsed.protocol))
      return { error: "remote must use https, http, ssh, or git" };
    if (!parsed.hostname) return { error: "remote URL must include a host" };
    return { remote };
  } catch {
    return { error: "remote must be a valid Git URL" };
  }
}

export function validateRevision(value: unknown): { revision: string } | { error: string } {
  if (value === undefined || value === "") return { revision: "HEAD" };
  if (typeof value !== "string") return { error: "revision must be a string" };
  const revision = value;
  if (!revision || revision.length > 256 || /\s/.test(revision) || !REVISION.test(revision))
    return { error: "revision must be a simple branch, tag, ref, or commit without whitespace" };
  return { revision };
}

export function validateReferenceId(value: unknown): { id: string } | { error: string } {
  if (typeof value !== "string" || !REFERENCE_ID.test(value))
    return { error: "id must be a managed repository reference id" };
  return { id: value };
}

export function isRepositoryReference(value: unknown): value is RepositoryReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.id === "string" &&
    REFERENCE_ID.test(candidate.id) &&
    typeof candidate.remote === "string" &&
    typeof candidate.revision === "string" &&
    typeof candidate.resolvedRevision === "string" &&
    typeof candidate.path === "string" &&
    typeof candidate.createdAt === "string"
  );
}
