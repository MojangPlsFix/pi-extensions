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

export type RepositoryReferenceDetails =
  | { action: "clone"; reference?: RepositoryReference; error?: string }
  | { action: "list" | "cleanup"; references: RepositoryReference[]; error?: string }
  | { action: "remove"; id: string; error?: string };

const REMOTE_PROTOCOLS = new Set(["http:", "https:", "ssh:", "git:"]);
const SCP_REMOTE = /^[A-Za-z0-9._-]+@[A-Za-z0-9._-]+:[^\s]+$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/@:+~^=-]*$/;
const REFERENCE_ID = /^ref-[A-Za-z0-9]{1,60}$/;

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
