import { execFile as nodeExecFile } from "node:child_process";
import { type Dirent, promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  isRepositoryReference,
  type RepositoryReference,
  validateReferenceId,
  validateRemote,
  validateRevision,
} from "./model.js";

const execFile = promisify(nodeExecFile);
const METADATA_FILE = ".pi-repository-reference.json";
export const REPOSITORY_REFERENCE_ROOT = join(tmpdir(), "pi-repository-references");
const GIT_ENV = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
  GIT_OPTIONAL_LOCKS: "0",
};

type GitRunner = (args: string[], cwd?: string) => Promise<{ stdout: string; stderr: string }>;

export const runGit: GitRunner = async (args, cwd) => {
  const result = await execFile("git", args, {
    cwd,
    env: GIT_ENV,
    shell: false,
    timeout: 10 * 60 * 1000,
    maxBuffer: 2 * 1024 * 1024,
  });
  return { stdout: result.stdout, stderr: result.stderr };
};

function referenceRoot(root = REPOSITORY_REFERENCE_ROOT): string {
  return resolve(root);
}

function referencePath(root: string, id: string): string {
  return join(root, id);
}

async function ensureManagedRoot(root: string): Promise<string> {
  const managedRoot = referenceRoot(root);
  await fs.mkdir(managedRoot, { recursive: true, mode: 0o700 });
  const stat = await fs.lstat(managedRoot);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("managed repository reference root is not a directory");
  return managedRoot;
}

async function readReference(root: string, id: string): Promise<RepositoryReference | undefined> {
  const path = referencePath(root, id);
  let stat: Awaited<ReturnType<typeof fs.lstat>> | undefined;
  try {
    stat = await fs.lstat(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  if (!stat.isDirectory() || stat.isSymbolicLink()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await fs.readFile(join(path, METADATA_FILE), "utf8"));
  } catch {
    return undefined;
  }
  if (!isRepositoryReference(value) || resolve(value.path) !== path) return undefined;
  return value;
}

export async function listRepositoryReferences(
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<RepositoryReference[]> {
  const managedRoot = await ensureManagedRoot(root);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(managedRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const references: RepositoryReference[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const idResult = validateReferenceId(entry.name);
    if ("error" in idResult) continue;
    const reference = await readReference(managedRoot, idResult.id);
    if (reference) references.push(reference);
  }
  return references.sort((left, right) => left.id.localeCompare(right.id));
}

export async function cloneRepositoryReference(
  remoteInput: unknown,
  revisionInput: unknown,
  root = REPOSITORY_REFERENCE_ROOT,
  git: GitRunner = runGit,
): Promise<RepositoryReference> {
  const remoteResult = validateRemote(remoteInput);
  if ("error" in remoteResult) throw new Error(remoteResult.error);
  const revisionResult = validateRevision(revisionInput);
  if ("error" in revisionResult) throw new Error(revisionResult.error);

  const managedRoot = await ensureManagedRoot(root);
  const path = await fs.mkdtemp(join(managedRoot, "ref-"));
  const id = basename(path);
  try {
    // Use execFile with an argument array. Remote and revision never become shell text.
    await git(["clone", "--no-checkout", remoteResult.remote, path]);
    await git(["-C", path, "checkout", "--detach", "--quiet", revisionResult.revision]);
    const resolvedRevision = (await git(["-C", path, "rev-parse", "HEAD"])).stdout.trim();
    if (!/^[0-9a-f]{40}$/i.test(resolvedRevision))
      throw new Error("git returned an invalid resolved revision");
    const reference: RepositoryReference = {
      id,
      remote: remoteResult.remote,
      revision: revisionResult.revision,
      resolvedRevision,
      path,
      createdAt: new Date().toISOString(),
    };
    await fs.writeFile(join(path, METADATA_FILE), `${JSON.stringify(reference, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    return reference;
  } catch (error) {
    await fs.rm(path, { recursive: true, force: true }).catch(() => undefined);
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`repository reference clone failed: ${detail}`);
  }
}

export async function removeRepositoryReference(
  idInput: unknown,
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<void> {
  const idResult = validateReferenceId(idInput);
  if ("error" in idResult) throw new Error(idResult.error);
  const managedRoot = await ensureManagedRoot(root);
  const reference = await readReference(managedRoot, idResult.id);
  if (!reference) throw new Error(`repository reference ${idResult.id} was not found`);
  await fs.rm(referencePath(managedRoot, idResult.id), { recursive: true, force: true });
}

export async function cleanupRepositoryReferences(
  root = REPOSITORY_REFERENCE_ROOT,
): Promise<RepositoryReference[]> {
  const references = await listRepositoryReferences(root);
  for (const reference of references) await removeRepositoryReference(reference.id, root);
  return references;
}

export const repositoryReferenceMetadataFile = METADATA_FILE;
