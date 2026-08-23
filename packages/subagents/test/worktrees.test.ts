import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  applyCandidate,
  captureWorktreeCandidate,
  checkCandidateApplies,
  createMissionWorktree,
  inspectGitRepository,
  removeMissionWorktree,
  validateMissionWorktree,
} from "../worktrees.js";

const cleanup: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

async function repository(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-test-"));
  cleanup.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Test User");
  git(root, "config", "user.email", "test@example.invalid");
  await fs.writeFile(join(root, "file.txt"), "base\n");
  git(root, "add", "file.txt");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

afterEach(async () => {
  for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

describe("mission worktrees", () => {
  it("refuses to copy or stash a dirty checkout", async () => {
    const root = await repository();
    await fs.writeFile(join(root, "file.txt"), "dirty\n");
    const state = await inspectGitRepository(root);
    expect(state?.dirty).toBe(true);
    await expect(createMissionWorktree(root, "dirty", join(root, "worktrees"))).rejects.toThrow(
      "never stash or copy",
    );
    expect(await fs.readFile(join(root, "file.txt"), "utf8")).toBe("dirty\n");
  });

  it("captures new and modified files and applies them only when requested", async () => {
    const root = await repository();
    const base = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-base-"));
    cleanup.push(base);
    const worktree = await createMissionWorktree(root, "candidate", base);
    await fs.writeFile(join(worktree.root, "file.txt"), "changed\n");
    await fs.writeFile(join(worktree.root, "new.txt"), "new\n");
    const candidate = await captureWorktreeCandidate(worktree);
    expect(candidate.files.sort()).toEqual(["file.txt", "new.txt"]);
    expect(await fs.readFile(join(root, "file.txt"), "utf8")).toBe("base\n");
    await checkCandidateApplies(root, candidate);
    await applyCandidate(root, candidate);
    expect(await fs.readFile(join(root, "file.txt"), "utf8")).toBe("changed\n");
    expect(await fs.readFile(join(root, "new.txt"), "utf8")).toBe("new\n");
    await removeMissionWorktree(worktree, { force: true });
  });

  it("validates restored worktree ownership before reuse", async () => {
    const root = await repository();
    const other = await repository();
    const base = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-base-"));
    cleanup.push(base);
    const worktree = await createMissionWorktree(root, "restore", base);
    await expect(validateMissionWorktree(worktree, root)).resolves.toMatchObject({
      root: worktree.root,
      sourceRoot: root,
    });
    await expect(validateMissionWorktree({ ...worktree, sourceRoot: other }, root)).rejects.toThrow(
      /different source repository/,
    );
    await removeMissionWorktree(worktree, { force: true });
  });

  it("honors pre-cancellation across every public Git operation", async () => {
    const root = await repository();
    const base = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-base-"));
    cleanup.push(base);
    const worktree = await createMissionWorktree(root, "cancel-all", base);
    const controller = new AbortController();
    controller.abort(new Error("mission cancelled"));
    const candidate = { patch: "", hasChanges: false };

    await expect(inspectGitRepository(root, controller.signal)).rejects.toThrow(
      "mission cancelled",
    );
    await expect(
      createMissionWorktree(root, "never-created", base, controller.signal),
    ).rejects.toThrow("mission cancelled");
    await expect(captureWorktreeCandidate(worktree, controller.signal)).rejects.toThrow(
      "mission cancelled",
    );
    await expect(checkCandidateApplies(root, candidate, controller.signal)).rejects.toThrow(
      "mission cancelled",
    );
    await expect(applyCandidate(root, candidate, controller.signal)).rejects.toThrow(
      "mission cancelled",
    );
    await expect(validateMissionWorktree(worktree, root, controller.signal)).rejects.toThrow(
      "mission cancelled",
    );
    await expect(
      removeMissionWorktree(worktree, { force: true, signal: controller.signal }),
    ).rejects.toThrow("mission cancelled");
    expect(await fs.realpath(worktree.root)).toBe(worktree.root);
    await removeMissionWorktree(worktree, { force: true });
  });

  it("cancels worktree creation by escalating against the owned Git process group", async () => {
    if (process.platform === "win32") return;
    const root = await repository();
    const base = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-base-"));
    cleanup.push(base);
    const hookDirectory = join(base, "hooks");
    const hook = join(hookDirectory, "post-checkout");
    const marker = join(base, "hook-child.pid");
    await fs.mkdir(hookDirectory);
    await fs.writeFile(
      hook,
      `#!/usr/bin/env node\nconst {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));setInterval(()=>{},1000);\n`,
      { mode: 0o755 },
    );
    git(root, "config", "core.hooksPath", hookDirectory);
    const controller = new AbortController();
    let preparedRoot: string | undefined;
    const creating = createMissionWorktree(root, "cancel-group", {
      baseDirectory: base,
      signal: controller.signal,
      onPrepared: (worktree) => {
        preparedRoot = worktree.root;
      },
    });
    let childPid = 0;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      try {
        childPid = Number(await fs.readFile(marker, "utf8"));
        if (childPid) break;
      } catch {
        await new Promise((resolveWait) => setTimeout(resolveWait, 20));
      }
    }
    expect(childPid).toBeGreaterThan(0);
    controller.abort(new Error("stop git"));
    await expect(creating).rejects.toThrow(/stop git.*retained/iu);
    expect(preparedRoot).toBe(join(base, "pi-mission-cancel-group"));
    expect(() => process.kill(childPid, 0)).toThrow();
  }, 10_000);

  it("retains an unregistered partial worktree when safe cleanup cannot be proven", async () => {
    const root = await repository();
    const base = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-base-"));
    cleanup.push(base);
    const state = await inspectGitRepository(root);
    const partialRoot = join(base, "pi-mission-partial");
    await fs.mkdir(partialRoot);
    await fs.writeFile(join(partialRoot, "sentinel.txt"), "retain\n");

    await expect(
      removeMissionWorktree(
        {
          missionId: "partial",
          root: partialRoot,
          cwd: partialRoot,
          baseCommit: state!.head,
          sourceRoot: state!.root,
        },
        { force: true },
      ),
    ).rejects.toThrow(/Safe cleanup cannot be proven.*retained/iu);
    expect(await fs.readFile(join(partialRoot, "sentinel.txt"), "utf8")).toBe("retain\n");
  });

  it("detects an overlapping source change before integration", async () => {
    const root = await repository();
    const base = await fs.mkdtemp(join(tmpdir(), "subagents-worktree-base-"));
    cleanup.push(base);
    const worktree = await createMissionWorktree(root, "conflict", base);
    await fs.writeFile(join(worktree.root, "file.txt"), "candidate\n");
    const candidate = await captureWorktreeCandidate(worktree);
    await fs.writeFile(join(root, "file.txt"), "parent change\n");
    await expect(checkCandidateApplies(root, candidate)).rejects.toThrow(
      "no longer applies cleanly",
    );
    await removeMissionWorktree(worktree, { force: true });
  });
});
