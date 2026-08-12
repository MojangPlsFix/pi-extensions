import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  redactRemote,
  sanitizeGitOutput,
  validateReferenceId,
  validateRemote,
  validateRevision,
} from "../model.js";
import {
  cleanupRepositoryReferences,
  cloneRepositoryReference,
  GitCommandError,
  type GitRunner,
  listRepositoryReferences,
  removeRepositoryReference,
  runGit,
} from "../store.js";

const roots: string[] = [];
const resolvedRevision = "0123456789abcdef0123456789abcdef01234567";

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "repository-reference-test-"));
  roots.push(root);
  return root;
}

async function createCloneDirectory(args: string[]): Promise<void> {
  const path = args[args.length - 1];
  if (path) await fs.mkdir(path, { recursive: true });
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("repository reference validation and redaction", () => {
  it("accepts supported remotes and safe revisions", () => {
    expect(validateRemote("https://github.com/example/project.git")).toEqual({
      remote: "https://github.com/example/project.git",
    });
    expect(validateRemote("git@github.com:example/project.git")).toEqual({
      remote: "git@github.com:example/project.git",
    });
    expect(validateRevision("refs/heads/main")).toEqual({ revision: "refs/heads/main" });
    expect(validateRevision("0123456789abcdef")).toEqual({ revision: "0123456789abcdef" });
    expect(validateRevision(undefined)).toEqual({ revision: "HEAD" });
  });

  it("rejects unsupported URLs, option-like input, and unsafe ids", () => {
    expect(validateRemote("https://example.test/repo.git && touch pwned")).toHaveProperty("error");
    expect(validateRemote("ftp://example.test/repo.git")).toHaveProperty("error");
    expect(validateRemote("file:///tmp/example.git")).toHaveProperty("error");
    expect(validateRevision("--upload-pack=touch")).toHaveProperty("error");
    expect(validateRevision("main; touch pwned")).toHaveProperty("error");
    expect(validateReferenceId("../../outside")).toHaveProperty("error");
  });

  it("redacts credentials and URL tokens from displayed diagnostics", () => {
    const remote = "https://user:secret@example.test/repo.git?token=abc#fragment";
    expect(redactRemote(remote)).toBe("https://example.test/repo.git");
    expect(sanitizeGitOutput(`fatal: unable to access ${remote}`, remote)).toBe(
      "fatal: unable to access https://example.test/repo.git",
    );
    expect(sanitizeGitOutput("request failed?password=secret&token=abc")).toBe(
      "request failed?password=[redacted]&token=[redacted]",
    );
  });
});

describe("managed repository references", () => {
  it("streams clone progress and supports list, remove, and cleanup", async () => {
    const root = await temporaryRoot();
    const calls: string[][] = [];
    const progress: string[] = [];
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      calls.push(args);
      if (args[0] === "clone") {
        await createCloneDirectory(args);
        options?.onOutput?.("stderr", "Receiving objects: 42% (1/2)\r");
        options?.onOutput?.("stderr", "Receiving objects: 100% (2/2)\n");
      }
      return {
        stdout: args.includes("rev-parse") ? `${resolvedRevision}\n` : "",
        stderr: "",
        code: 0,
      };
    };

    const reference = await cloneRepositoryReference(
      "https://github.com/example/project.git",
      "main",
      root,
      fakeGit,
      { onProgress: (event) => progress.push(event.message) },
    );
    expect(reference.path.startsWith(`${root}/ref-`)).toBe(true);
    expect(reference.resolvedRevision).toBe(resolvedRevision);
    expect(calls).toEqual([
      [
        "clone",
        "--no-checkout",
        "--progress",
        "https://github.com/example/project.git",
        reference.path,
      ],
      [
        "-C",
        reference.path,
        "rev-parse",
        "--verify",
        "--end-of-options",
        "refs/remotes/origin/main^{commit}",
      ],
      ["-C", reference.path, "checkout", "--detach", "--quiet", resolvedRevision],
    ]);
    expect(progress).toContain("Cloning repository…");
    expect(progress).toContain("Receiving objects: 100% (2/2)");
    expect(await listRepositoryReferences(root)).toEqual([reference]);

    const develop = await cloneRepositoryReference(
      "https://github.com/example/project.git",
      "refs/heads/develop",
      root,
      fakeGit,
    );
    expect(calls.slice(-3)).toEqual([
      [
        "clone",
        "--no-checkout",
        "--progress",
        "https://github.com/example/project.git",
        develop.path,
      ],
      [
        "-C",
        develop.path,
        "rev-parse",
        "--verify",
        "--end-of-options",
        "refs/remotes/origin/develop^{commit}",
      ],
      ["-C", develop.path, "checkout", "--detach", "--quiet", resolvedRevision],
    ]);

    await removeRepositoryReference(reference.id, root);
    expect(await listRepositoryReferences(root)).toEqual([develop]);
    await removeRepositoryReference(develop.id, root);
    expect(await listRepositoryReferences(root)).toEqual([]);

    const second = await cloneRepositoryReference(
      "https://github.com/example/another-project.git",
      undefined,
      root,
      fakeGit,
    );
    expect(await cleanupRepositoryReferences(root)).toEqual([second]);
    expect(await listRepositoryReferences(root)).toEqual([]);
  });

  it("reports sanitized Git diagnostics and removes failed clones", async () => {
    const root = await temporaryRoot();
    const remote = "https://user:secret@example.test/repo.git?token=abc";
    const progress: Array<{ message: string; diagnostics?: { stderr?: string } }> = [];
    const fakeGit: GitRunner = async (args) => {
      await createCloneDirectory(args);
      throw new GitCommandError("git clone failed", {
        args,
        stderr: `fatal: unable to access ${remote}`,
        exitCode: 128,
      });
    };

    let error: Error | undefined;
    try {
      await cloneRepositoryReference(remote, "main", root, fakeGit, {
        onProgress: (event) => progress.push(event),
      });
    } catch (value) {
      error = value instanceof Error ? value : new Error(String(value));
    }

    expect(error).toBeInstanceOf(Error);
    expect(error?.message).toContain("repository reference clone failed");
    expect(error?.message).not.toContain("secret");
    expect(error?.message).not.toContain("token=abc");
    expect(progress.at(-1)?.diagnostics?.stderr).not.toContain("secret");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("forwards cancellation and cleans up the temporary directory", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    let receivedSignal: AbortSignal | undefined;
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      receivedSignal = options?.signal;
      await createCloneDirectory(args);
      controller.abort();
      throw new GitCommandError("git clone was cancelled", {
        args,
        cancelled: true,
      });
    };

    await expect(
      cloneRepositoryReference("https://github.com/example/project.git", "main", root, fakeGit, {
        signal: controller.signal,
      }),
    ).rejects.toThrow("cancelled");
    expect(receivedSignal).toBe(controller.signal);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("reports timeout diagnostics and removes timed-out clones", async () => {
    const root = await temporaryRoot();
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      await createCloneDirectory(args);
      expect(options?.timeoutMs).toBeLessThanOrEqual(100);
      throw new GitCommandError("git clone timed out", {
        args,
        timedOut: true,
      });
    };

    await expect(
      cloneRepositoryReference("https://github.com/example/project.git", "main", root, fakeGit, {
        timeoutMs: 100,
      }),
    ).rejects.toThrow("timed out");
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("exposes stderr when a Git command fails", async () => {
    await expect(
      runGit(["rev-parse", "--verify", "--end-of-options", "missing^{commit}"]),
    ).rejects.toMatchObject({
      name: "GitCommandError",
      stderr: expect.stringContaining("fatal"),
    });
  });
});
