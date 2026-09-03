import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  redactRemote,
  sanitizeGitOutput,
  validateReferenceId,
  validateRemote,
  validateRevision,
} from "../model.js";
import {
  ARBITRARY_LOCAL_REF,
  cleanupRepositoryReferences,
  cloneRepositoryReference,
  createGitRunner,
  DEFAULT_CLEANUP_TIMEOUT_MS,
  GitCommandError,
  type GitRunner,
  type GitSpawner,
  listRepositoryReferences,
  PROCESS_SETTLEMENT_FALLBACK_MS,
  removeDirectoryBounded,
  removeRepositoryReference,
  runGit,
} from "../store.js";

const roots: string[] = [];
const resolvedRevision = "0123456789abcdef0123456789abcdef01234567";
const secondResolvedRevision = "fedcba9876543210fedcba9876543210fedcba98";
const arbitraryPullRevision = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const arbitraryNotesRevision = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const arbitraryCommitRevision = "cccccccccccccccccccccccccccccccccccccccc";

function advertisedRemote(): string {
  return [
    `ref: refs/heads/main\tHEAD`,
    `${resolvedRevision}\tHEAD`,
    `${resolvedRevision}\trefs/heads/main`,
    `${secondResolvedRevision}\trefs/heads/develop`,
    `${resolvedRevision}\trefs/tags/v1`,
    `${resolvedRevision}\trefs/tags/v1^{}`,
    `${arbitraryPullRevision}\trefs/pull/123/head`,
    `${arbitraryNotesRevision}\trefs/notes/test`,
  ].join("\n");
}

function advertisedMainOnly(): string {
  return advertisedRemote().split("\n").slice(0, 3).join("\n");
}

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "repository-reference-test-"));
  roots.push(root);
  return root;
}

async function createCloneDirectory(args: string[]): Promise<void> {
  const path = args[args.length - 1];
  if (path) await fs.mkdir(path, { recursive: true });
}

type FakeGitChild = {
  child: ChildProcess;
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function fakeGitChild(pid: number | null = null): FakeGitChild {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const unref = vi.fn();
  const child = Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    kill,
    unref,
    stdout,
    stderr,
  }) as unknown as ChildProcess;
  return { child, kill, unref };
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
        stdout:
          args[0] === "ls-remote"
            ? `${advertisedRemote()}\n`
            : args.includes("rev-parse")
              ? `${resolvedRevision}\n`
              : "",
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
      ["ls-remote", "--symref", "https://github.com/example/project.git"],
      [
        "clone",
        "--no-checkout",
        "--progress",
        "--single-branch",
        "--branch",
        "main",
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
    expect(calls.slice(-4)).toEqual([
      ["ls-remote", "--symref", "https://github.com/example/project.git"],
      [
        "clone",
        "--no-checkout",
        "--progress",
        "--single-branch",
        "--branch",
        "develop",
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
      if (args[0] === "clone") await createCloneDirectory(args);
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
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
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
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
      if (args[0] === "ls-remote") {
        expect(options?.timeoutMs).toBeLessThanOrEqual(100);
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
      }
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

  it("ignores a throwing progress callback on a successful clone", async () => {
    const root = await temporaryRoot();
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
      if (args[0] === "clone") {
        await createCloneDirectory(args);
        options?.onOutput?.("stderr", "Receiving objects: 100%\n");
      }
      if (args.includes("rev-parse"))
        return { stdout: `${resolvedRevision}\n`, stderr: "", code: 0 };
      return { stdout: "", stderr: "", code: 0 };
    };

    await expect(
      cloneRepositoryReference("https://github.com/example/project.git", "main", root, fakeGit, {
        onProgress: () => {
          throw new Error("renderer failed");
        },
      }),
    ).resolves.toMatchObject({ resolvedRevision });
  });

  it("preserves the primary Git failure when a progress callback throws", async () => {
    const root = await temporaryRoot();
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
      await createCloneDirectory(args);
      throw new GitCommandError("git clone failed", {
        args,
        stderr: "fatal: primary clone failure",
        exitCode: 128,
      });
    };

    await expect(
      cloneRepositoryReference("https://github.com/example/project.git", "main", root, fakeGit, {
        onProgress: () => {
          throw new Error("renderer failed");
        },
      }),
    ).rejects.toThrow("primary clone failure");
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it("preflights an invalid revision before creating a clone directory", async () => {
    const root = await temporaryRoot();
    const calls: string[][] = [];
    const fakeGit: GitRunner = async (args) => {
      calls.push(args);
      return {
        stdout: `${advertisedMainOnly()}\n`,
        stderr: "",
        code: 0,
      };
    };

    await expect(
      cloneRepositoryReference("https://github.com/example/project.git", "develop", root, fakeGit),
    ).rejects.toThrow("was not advertised");
    expect(calls).toEqual([["ls-remote", "--symref", "https://github.com/example/project.git"]]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("fetches advertised arbitrary refs into a fixed local ref before resolving", async () => {
    const root = await temporaryRoot();
    const remote = "https://github.com/example/project.git";
    const calls: string[][] = [];
    const arbitraryRevisions = new Map([
      ["refs/pull/123/head", arbitraryPullRevision],
      ["refs/notes/test", arbitraryNotesRevision],
    ]);
    const fetchedRevisions = new Map<string, string>();
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      calls.push(args);
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
      if (args[0] === "clone") {
        await createCloneDirectory(args);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "-C" && args[2] === "fetch") {
        const path = args[1];
        const refspec = args.at(-1);
        const separator = refspec?.indexOf(":") ?? -1;
        const source = separator >= 0 ? refspec?.slice(0, separator) : undefined;
        const fetchedRevision = source ? arbitraryRevisions.get(source) : undefined;
        if (!path || !fetchedRevision) throw new Error("test fetch plan was incomplete");
        fetchedRevisions.set(path, fetchedRevision);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args.includes("rev-parse")) {
        const path = args[1];
        expect(args.at(-1)).toBe(`${ARBITRARY_LOCAL_REF}^{commit}`);
        const fetchedRevision = path ? fetchedRevisions.get(path) : undefined;
        if (!fetchedRevision) throw new Error("test fetch did not populate the local ref");
        options?.onOutput?.("stdout", `${fetchedRevision}\n`);
        return { stdout: `${fetchedRevision}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const references = [];
    for (const revision of arbitraryRevisions.keys()) {
      references.push(await cloneRepositoryReference(remote, revision, root, fakeGit));
    }

    const fetchCalls = calls.filter((args) => args[0] === "-C" && args[2] === "fetch");
    expect(fetchCalls.map((args) => args.at(-1))).toEqual([
      `refs/pull/123/head:${ARBITRARY_LOCAL_REF}`,
      `refs/notes/test:${ARBITRARY_LOCAL_REF}`,
    ]);
    const resolutionCalls = calls.filter((args) => args.includes("rev-parse"));
    expect(resolutionCalls).toHaveLength(2);
    expect(references.map((reference) => reference.resolvedRevision)).toEqual([
      arbitraryPullRevision,
      arbitraryNotesRevision,
    ]);
    expect(
      calls
        .filter((args) => args[0] === "clone")
        .every((args) => !args.includes("--single-branch")),
    ).toBe(true);
  });

  it("fetches a commit advertised only through an arbitrary ref", async () => {
    const root = await temporaryRoot();
    const remote = "https://github.com/example/project.git";
    const arbitraryRef = "refs/pull/456/head";
    const calls: string[][] = [];
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      calls.push(args);
      if (args[0] === "ls-remote") {
        return { stdout: `${arbitraryCommitRevision}\t${arbitraryRef}\n`, stderr: "", code: 0 };
      }
      if (args[0] === "clone") {
        await createCloneDirectory(args);
        return { stdout: "", stderr: "", code: 0 };
      }
      if (args[0] === "-C" && args[2] === "fetch") return { stdout: "", stderr: "", code: 0 };
      if (args.includes("rev-parse")) {
        expect(args.at(-1)).toBe(`${ARBITRARY_LOCAL_REF}^{commit}`);
        options?.onOutput?.("stdout", `${arbitraryCommitRevision}\n`);
        return { stdout: `${arbitraryCommitRevision}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    const reference = await cloneRepositoryReference(
      remote,
      arbitraryCommitRevision,
      root,
      fakeGit,
    );

    expect(reference.resolvedRevision).toBe(arbitraryCommitRevision);
    expect(calls.find((args) => args[0] === "-C" && args[2] === "fetch")).toEqual([
      "-C",
      reference.path,
      "fetch",
      "--no-tags",
      "origin",
      `${arbitraryRef}:${ARBITRARY_LOCAL_REF}`,
    ]);
  });

  it("rejects an unadvertised arbitrary ref before creating a clone directory", async () => {
    const root = await temporaryRoot();
    const calls: string[][] = [];
    const fakeGit: GitRunner = async (args) => {
      calls.push(args);
      return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
    };

    await expect(
      cloneRepositoryReference(
        "https://github.com/example/project.git",
        "refs/pull/999/head",
        root,
        fakeGit,
      ),
    ).rejects.toThrow("was not advertised");
    expect(calls).toEqual([["ls-remote", "--symref", "https://github.com/example/project.git"]]);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it("keeps HEAD, refs, tags, and commit revisions compatible with the clone plan", async () => {
    const root = await temporaryRoot();
    const calls: string[][] = [];
    const unknownCommit = "abcdef0123456789abcdef0123456789abcdef01";
    const fakeGit: GitRunner = async (args, _cwd, options) => {
      calls.push(args);
      if (args[0] === "clone") await createCloneDirectory(args);
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
      if (args.includes("rev-parse")) {
        options?.onOutput?.("stdout", `${resolvedRevision}\n`);
        return { stdout: `${resolvedRevision}\n`, stderr: "", code: 0 };
      }
      return { stdout: "", stderr: "", code: 0 };
    };

    await cloneRepositoryReference("https://github.com/example/project.git", "HEAD", root, fakeGit);
    await cloneRepositoryReference(
      "https://github.com/example/project.git",
      "refs/heads/main",
      root,
      fakeGit,
    );
    await cloneRepositoryReference("https://github.com/example/project.git", "v1", root, fakeGit);
    await cloneRepositoryReference(
      "https://github.com/example/project.git",
      "refs/tags/v1",
      root,
      fakeGit,
    );
    await cloneRepositoryReference(
      "https://github.com/example/project.git",
      unknownCommit,
      root,
      fakeGit,
    );

    const cloneCalls = calls.filter((args) => args[0] === "clone");
    expect(cloneCalls).toHaveLength(5);
    expect(cloneCalls[0]).toEqual(expect.arrayContaining(["--branch", "main"]));
    expect(cloneCalls[1]).toEqual(expect.arrayContaining(["--branch", "main"]));
    expect(cloneCalls[2]).toEqual(expect.arrayContaining(["--branch", "v1"]));
    expect(cloneCalls[3]).toEqual(expect.arrayContaining(["--branch", "v1"]));
    expect(cloneCalls[4]).not.toContain("--single-branch");
    expect(calls.filter((args) => args[0] === "ls-remote")).toHaveLength(5);
  });

  it("bounds failed-clone cleanup and reports a retained directory", async () => {
    const root = await temporaryRoot();
    const progress: Array<{ message: string; diagnostics?: { cleanup?: unknown } }> = [];
    const fakeGit: GitRunner = async (args) => {
      if (args[0] === "ls-remote")
        return { stdout: `${advertisedRemote()}\n`, stderr: "", code: 0 };
      await createCloneDirectory(args);
      throw new GitCommandError("git clone failed", { args, exitCode: 128 });
    };

    const pendingRemoval = new Promise<void>(() => undefined);
    let error: Error | undefined;
    try {
      await cloneRepositoryReference(
        "https://github.com/example/project.git",
        "main",
        root,
        fakeGit,
        {
          cleanup: { timeoutMs: 5, remove: async () => pendingRemoval },
          onProgress: (event) => progress.push(event),
        },
      );
    } catch (value) {
      error = value instanceof Error ? value : new Error(String(value));
    }

    expect(error?.message).toContain("cleanup timed out");
    expect(error?.message).toContain("retained");
    expect(progress.at(-1)?.diagnostics?.cleanup).toMatchObject({
      completed: false,
      timedOut: true,
    });
    expect((await fs.readdir(root)).some((entry) => entry.startsWith("ref-"))).toBe(true);
  });

  it("returns a bounded cleanup failure without swallowing the primary error", async () => {
    const result = await removeDirectoryBounded("/tmp/retained-reference", {
      timeoutMs: 5,
      remove: async () => {
        throw new Error("permission denied");
      },
    });
    expect(result).toMatchObject({ completed: false, timedOut: false });
    expect(result.error).toEqual(new Error("permission denied"));
    expect(DEFAULT_CLEANUP_TIMEOUT_MS).toBeGreaterThan(0);
  });

  it("settles cancellation even when Git never closes its stdio", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeGitChild();
      const spawnProcess = vi.fn(() => fake.child) as unknown as GitSpawner;
      const runner = createGitRunner(spawnProcess);
      const controller = new AbortController();
      const pending = runner(["clone", "remote", "path"], undefined, {
        signal: controller.signal,
        timeoutMs: 100,
      });
      const rejection = expect(pending).rejects.toMatchObject({ cancelled: true });
      controller.abort();
      await vi.advanceTimersByTimeAsync(PROCESS_SETTLEMENT_FALLBACK_MS);
      await rejection;
      expect(fake.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fake.unref).toHaveBeenCalledOnce();
      expect(spawnProcess).toHaveBeenCalledWith(
        "git",
        ["clone", "remote", "path"],
        expect.objectContaining({ shell: false, stdio: ["ignore", "pipe", "pipe"] }),
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the owned POSIX process group for cancellation", async () => {
    if (process.platform === "win32") return;
    vi.useFakeTimers();
    const processKill = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const fake = fakeGitChild(43210);
      const spawnProcess = vi.fn(() => fake.child) as unknown as GitSpawner;
      const runner = createGitRunner(spawnProcess);
      const controller = new AbortController();
      const pending = runner(["clone", "remote", "path"], undefined, {
        signal: controller.signal,
        timeoutMs: 100,
      });
      const rejection = expect(pending).rejects.toMatchObject({ cancelled: true });
      controller.abort();
      await vi.advanceTimersByTimeAsync(PROCESS_SETTLEMENT_FALLBACK_MS);
      await rejection;
      expect(processKill.mock.calls.map(([pid, signal]) => [pid, signal])).toEqual([
        [-43210, "SIGTERM"],
        [-43210, "SIGKILL"],
      ]);
      expect(fake.kill).not.toHaveBeenCalled();
    } finally {
      processKill.mockRestore();
      vi.useRealTimers();
    }
  });

  it("escalates timeout termination and settles without a close event", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeGitChild();
      const spawnProcess = vi.fn(() => fake.child) as unknown as GitSpawner;
      const runner = createGitRunner(spawnProcess);
      const pending = runner(["fetch", "remote"], undefined, { timeoutMs: 10 });
      const rejection = expect(pending).rejects.toMatchObject({ timedOut: true });
      await vi.advanceTimersByTimeAsync(10 + PROCESS_SETTLEMENT_FALLBACK_MS);
      await rejection;
      expect(fake.kill.mock.calls.map(([signal]) => signal)).toEqual(["SIGTERM", "SIGKILL"]);
      expect(fake.unref).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("exposes stderr when a Git command fails", async () => {
    await expect(
      runGit(["rev-parse", "--verify", "--end-of-options", "missing^{commit}"], undefined, {
        timeoutMs: 1000,
      }),
    ).rejects.toMatchObject({
      name: "GitCommandError",
      stderr: expect.stringContaining("fatal"),
    });
  });
});
