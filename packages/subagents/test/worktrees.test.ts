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
