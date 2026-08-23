import { execFileSync } from "node:child_process";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { deriveCandidateId, runPatchValidator, type ValidationRecord } from "../validation.js";
import {
  candidatePatchBytes,
  captureWorktreeCandidate,
  createMissionWorktree,
  removeMissionWorktree,
  type WorktreeCandidate,
} from "../worktrees.js";

const cleanup: string[] = [];
const ownedPids = new Set<number>();

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

function gitBytes(cwd: string, ...args: string[]): Buffer {
  return execFileSync("git", args, { cwd });
}

async function fixture() {
  const source = await fs.mkdtemp(join(tmpdir(), "hackler-validator-source-"));
  const worktrees = await fs.mkdtemp(join(tmpdir(), "hackler-validator-worktrees-"));
  const validators = await fs.mkdtemp(join(tmpdir(), "hackler-validator-runs-"));
  cleanup.push(source, worktrees, validators);
  git(source, "init", "-q");
  git(source, "config", "user.name", "Validator Test");
  git(source, "config", "user.email", "validator@example.invalid");
  await fs.mkdir(join(source, "nested"));
  await fs.writeFile(join(source, "nested", "value.txt"), "base\n");
  git(source, "add", ".");
  git(source, "commit", "-q", "-m", "base");
  const worktree = await createMissionWorktree(join(source, "nested"), "candidate", worktrees);
  await fs.writeFile(join(worktree.cwd, "value.txt"), "candidate\n");
  const candidate = await captureWorktreeCandidate(worktree);
  return { source, worktree, candidate, validators };
}

async function waitForFile(path: string, timeoutMs = 3_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await fs.readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  throw new Error(`Timed out waiting for ${path}.`);
}

async function provePidDead(pid: number, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") {
        ownedPids.delete(pid);
        return;
      }
      throw cause;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`Owned validator descendant ${pid} is still alive.`);
}

async function expectValidatorWorkspaceAbsent(record: {
  intendedPath: string;
  sourceRoot: string;
}): Promise<void> {
  expect(await fs.stat(record.intendedPath).catch(() => undefined)).toBeUndefined();
  expect(git(record.sourceRoot, "worktree", "list", "--porcelain")).not.toContain(
    record.intendedPath,
  );
}

async function expectStartedValidatorCleanup(record: ValidationRecord): Promise<void> {
  if (process.platform === "win32") {
    expect(record).toMatchObject({ terminationProven: false, cleanup: "retained" });
    expect(record.cleanupError).toContain("could not be proven");
    await removeMissionWorktree(
      {
        missionId: record.id,
        root: record.intendedPath,
        cwd: record.intendedPath,
        baseCommit: record.baseCommit,
        sourceRoot: record.sourceRoot,
      },
      { force: true },
    );
    return;
  }
  expect(record).toMatchObject({ terminationProven: true, cleanup: "removed" });
  await expectValidatorWorkspaceAbsent(record);
}

function stubbornDescendantScript(marker: string, overflow = false): string {
  return `const {spawn}=require('node:child_process');const fs=require('node:fs');process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});const c=spawn(process.execPath,['-e',"process.on('SIGINT',()=>{});process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"],{stdio:'ignore'});fs.writeFileSync(${JSON.stringify(marker)},String(c.pid));${overflow ? "process.stdout.write('o'.repeat(40));process.stderr.write('e'.repeat(40));" : ""}setInterval(()=>{},1000);`;
}

afterEach(async () => {
  for (const pid of ownedPids) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // The validator cleanup normally already proved it dead.
    }
  }
  ownedPids.clear();
  for (const path of cleanup.splice(0)) await fs.rm(path, { recursive: true, force: true });
});

describe("report-only patch validator", () => {
  it("derives a stable id from the exact base and patch", () => {
    const first = deriveCandidateId("abc", Buffer.from("patch\n"));
    expect(first).toMatch(/^[0-9a-f]{64}$/u);
    expect(deriveCandidateId("abc", Buffer.from("patch\n"))).toBe(first);
    expect(deriveCandidateId("abc", Buffer.from("patch\r\n"))).not.toBe(first);
    expect(deriveCandidateId("abcd", Buffer.from("patch\n"))).not.toBe(first);
  });

  it("reconstructs exact captured bytes, preserves cwd/source/original state, closes stdin, and passes exact argv", async () => {
    const setup = await fixture();
    const commandMarker = join(setup.validators, "command-ran");
    const tokens = ["literal ; $HOME && * | value", " leading", "trailing ", ""];
    const capturedPatch = Buffer.from(candidatePatchBytes(setup.candidate));
    await fs.writeFile(join(setup.worktree.cwd, "value.txt"), "edited again\n");
    const originalBytes = await fs.readFile(join(setup.worktree.cwd, "value.txt"));
    const originalStatus = git(setup.worktree.root, "status", "--porcelain=v1");
    const sourceStatus = git(setup.source, "status", "--porcelain=v1");
    expect(await fs.stat(commandMarker).catch(() => undefined)).toBeUndefined();

    const callbacks: string[] = [];
    const record = await runPatchValidator({
      target: { kind: "run", id: "worker-1" },
      validatorName: "literal",
      validator: {
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('fs');fs.writeFileSync(process.argv[1],'ran');const chunks=[];process.stdin.on('data',c=>chunks.push(c));process.stdin.on('end',()=>{const value=fs.readFileSync('value.txt');if(value.toString()!=='candidate\\n'||Buffer.concat(chunks).length!==0||JSON.stringify(process.argv.slice(2,6))!==process.argv[6])process.exit(2);console.log(process.cwd());console.log(JSON.stringify(process.argv.slice(2,6)))})",
          commandMarker,
          ...tokens,
          JSON.stringify(tokens),
        ],
        timeoutMs: 2_000,
        maxOutputBytes: 10_000,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
      onPreparing: async (preparing) => {
        callbacks.push("preparing");
        expect(preparing.status).toBe("preparing");
        expect(await fs.stat(preparing.intendedPath).catch(() => undefined)).toBeUndefined();
        expect(await fs.stat(commandMarker).catch(() => undefined)).toBeUndefined();
      },
      onRunning: async (running) => {
        callbacks.push("running");
        expect(running.status).toBe("running");
        expect((await fs.stat(running.intendedPath)).isDirectory()).toBe(true);
        expect(await fs.stat(commandMarker).catch(() => undefined)).toBeUndefined();
      },
    });
    expect(record).toMatchObject({
      status: "completed",
      outcome: "passed",
      exitCode: 0,
    });
    expect(callbacks).toEqual(["preparing", "running"]);
    expect(record.output).toContain(JSON.stringify(tokens));
    expect(record.output).toContain(`${join(record.intendedPath, "nested")}\n`);
    expect(candidatePatchBytes(setup.candidate)).toEqual(capturedPatch);
    expect(await fs.readFile(join(setup.source, "nested", "value.txt"), "utf8")).toBe("base\n");
    expect(await fs.readFile(join(setup.worktree.cwd, "value.txt"))).toEqual(originalBytes);
    expect(git(setup.source, "status", "--porcelain=v1")).toBe(sourceStatus);
    expect(git(setup.worktree.root, "status", "--porcelain=v1")).toBe(originalStatus);
    await expectStartedValidatorCleanup(record);
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it("captures and applies invalid-UTF8 textual patch bytes without normalization", async () => {
    const setup = await fixture();
    const captured = Buffer.from([
      0x63, 0x61, 0x6e, 0x64, 0x69, 0x64, 0x61, 0x74, 0x65, 0x20, 0x80, 0x0a,
    ]);
    await fs.writeFile(join(setup.worktree.cwd, "value.txt"), captured);
    const candidate = await captureWorktreeCandidate(setup.worktree);
    expect(candidatePatchBytes(candidate).includes(0x80)).toBe(true);
    expect(candidate.candidateId).toBe(
      deriveCandidateId(candidate.baseCommit, candidatePatchBytes(candidate)),
    );
    await fs.writeFile(join(setup.worktree.cwd, "value.txt"), Buffer.from([0xff, 0x00, 0xfe]));
    const record = await runPatchValidator({
      target: { kind: "run", id: "raw-bytes" },
      validatorName: "raw-bytes",
      validator: {
        command: process.execPath,
        args: [
          "-e",
          "const fs=require('fs');if(fs.readFileSync('value.txt').toString('base64')!==process.argv[1])process.exit(3)",
          captured.toString("base64"),
        ],
        timeoutMs: 2_000,
        maxOutputBytes: 1_000,
      },
      candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
    });
    expect(record.outcome).toBe("passed");
    expect(await fs.readFile(join(setup.source, "nested", "value.txt"), "utf8")).toBe("base\n");
    expect(await fs.readFile(join(setup.worktree.cwd, "value.txt"))).toEqual(
      Buffer.from([0xff, 0x00, 0xfe]),
    );
    await expectStartedValidatorCleanup(record);
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it.each(["rename", "copy"] as const)(
    "validates an exact stored %s patch with an unusual target path",
    async (change) => {
      const setup = await fixture();
      git(setup.worktree.root, "reset", "--hard", setup.worktree.baseCommit);
      const target = change === "rename" ? "nested/renamed\tvalue.txt" : "nested/copied\nvalue.txt";
      let candidate: WorktreeCandidate;
      if (change === "rename") {
        git(setup.worktree.root, "mv", "nested/value.txt", target);
        candidate = await captureWorktreeCandidate(setup.worktree);
      } else {
        await fs.copyFile(
          join(setup.worktree.root, "nested/value.txt"),
          join(setup.worktree.root, target),
        );
        git(setup.worktree.root, "add", "-A");
        const patch = gitBytes(
          setup.worktree.root,
          "diff",
          "--cached",
          "-C",
          "--find-copies-harder",
          "--binary",
          "--full-index",
          setup.worktree.baseCommit,
        );
        const names = gitBytes(
          setup.worktree.root,
          "diff",
          "--cached",
          "-C",
          "--find-copies-harder",
          "--name-only",
          "-z",
          setup.worktree.baseCommit,
        )
          .toString("utf8")
          .split("\0")
          .filter(Boolean);
        candidate = {
          candidateId: deriveCandidateId(setup.worktree.baseCommit, patch),
          baseCommit: setup.worktree.baseCommit,
          patchBase64: patch.toString("base64"),
          files: names,
          hasChanges: true,
        };
        git(setup.worktree.root, "reset", "--mixed", setup.worktree.baseCommit);
      }
      expect(candidate.files).toEqual([target]);
      const record = await runPatchValidator({
        target: { kind: "run", id: change },
        validatorName: change,
        validator: {
          command: process.execPath,
          args: [
            "-e",
            "const fs=require('fs');if(fs.readFileSync(process.argv[1],'utf8')!=='base\\n')process.exit(4)",
            target.slice("nested/".length),
          ],
          timeoutMs: 2_000,
          maxOutputBytes: 1_000,
        },
        candidate,
        worktree: setup.worktree,
        workspaceRoot: setup.validators,
      });
      expect(record.outcome).toBe("passed");
      await expectStartedValidatorCleanup(record);
      await removeMissionWorktree(setup.worktree, { force: true });
    },
  );

  it("rejects every inconsistent candidate invariant before workspace creation", async () => {
    const setup = await fixture();
    const patch = candidatePatchBytes(setup.candidate);
    const candidates: WorktreeCandidate[] = [
      { ...setup.candidate, hasChanges: false },
      { ...setup.candidate, files: [] },
      { ...setup.candidate, files: ["other.txt"] },
      { ...setup.candidate, patchBase64: Buffer.alloc(0).toString("base64") },
      {
        ...setup.candidate,
        candidateId: deriveCandidateId(setup.candidate.baseCommit, Buffer.from("other")),
      },
      {
        ...setup.candidate,
        baseCommit: "0".repeat(setup.candidate.baseCommit.length),
        candidateId: deriveCandidateId("0".repeat(setup.candidate.baseCommit.length), patch),
      },
    ];
    let preparingCalls = 0;
    for (const candidate of candidates) {
      await expect(
        runPatchValidator({
          target: { kind: "run", id: "invalid" },
          validatorName: "must-not-run",
          validator: {
            command: process.execPath,
            args: ["-e", "process.exit(99)"],
            timeoutMs: 1_000,
            maxOutputBytes: 1_000,
          },
          candidate,
          worktree: setup.worktree,
          workspaceRoot: setup.validators,
          onPreparing: () => {
            preparingCalls += 1;
          },
        }),
      ).rejects.toThrow(/candidate|patch|metadata|commit/iu);
    }
    expect(preparingCalls).toBe(0);
    expect(await fs.readdir(setup.validators)).toEqual([]);
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it("rejects a candidate-created symlink cwd escape without spawning the validator", async () => {
    const setup = await fixture();
    const outside = await fs.mkdtemp(join(tmpdir(), "hackler-validator-outside-"));
    cleanup.push(outside);
    const commandMarker = join(setup.validators, "escaped-command-ran");
    await fs.rm(setup.worktree.cwd, { recursive: true });
    await fs.symlink(outside, setup.worktree.cwd, "dir");
    const candidate = await captureWorktreeCandidate(setup.worktree);
    const record = await runPatchValidator({
      target: { kind: "run", id: "symlink" },
      validatorName: "symlink",
      validator: {
        command: process.execPath,
        args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(commandMarker)},'ran')`],
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      },
      candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
    });
    expect(record).toMatchObject({ outcome: "preparation-failure", cleanup: "removed" });
    expect(record.error).toContain("inside the disposable worktree");
    expect(await fs.stat(commandMarker).catch(() => undefined)).toBeUndefined();
    await expectValidatorWorkspaceAbsent(record);
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it.each([
    {
      name: "zero",
      script: "process.stdout.write('ok')",
      outcome: "passed",
      exitCode: 0,
    },
    {
      name: "nonzero",
      script: "console.error('bad');process.exit(7)",
      outcome: "failed",
      exitCode: 7,
    },
    {
      name: "overflow",
      script:
        "process.stdout.write('o'.repeat(40));process.stderr.write('e'.repeat(40));setInterval(()=>{},1000)",
      outcome: "output-overflow",
      exitCode: undefined,
    },
    {
      name: "timeout",
      script: "setInterval(()=>{},1000)",
      outcome: "timeout",
      exitCode: undefined,
    },
  ])(
    "bounds the $name outcome and cleans after termination",
    async ({ name, script, outcome, exitCode }) => {
      const setup = await fixture();
      const record = await runPatchValidator({
        target: { kind: "run", id: name },
        validatorName: name,
        validator: {
          command: process.execPath,
          args: ["-e", script],
          timeoutMs: name === "timeout" ? 200 : 2_000,
          maxOutputBytes: name === "overflow" ? 64 : 10_000,
        },
        candidate: setup.candidate,
        worktree: setup.worktree,
        workspaceRoot: setup.validators,
      });
      expect(record.outcome).toBe(outcome);
      if (exitCode !== undefined) expect(record.exitCode).toBe(exitCode);
      if (name === "overflow") {
        expect(record.outputBytes).toBe(64);
        expect(record.outputTruncated).toBe(true);
        expect(record.output).toContain("o");
        expect(record.output).toContain("e");
      }
      if (process.platform === "win32") {
        expect(record).toMatchObject({ terminationProven: false, cleanup: "retained" });
        expect(record.cleanupError).toContain("could not be proven");
        await removeMissionWorktree(
          {
            missionId: record.id,
            root: record.intendedPath,
            cwd: record.intendedPath,
            baseCommit: record.baseCommit,
            sourceRoot: record.sourceRoot,
          },
          { force: true },
        );
      } else {
        expect(record).toMatchObject({ terminationProven: true, cleanup: "removed" });
        await expectValidatorWorkspaceAbsent(record);
      }
      await removeMissionWorktree(setup.worktree, { force: true });
    },
  );

  it("keeps persisted UTF-8 output within the configured byte cap", async () => {
    const setup = await fixture();
    const record = await runPatchValidator({
      target: { kind: "run", id: "invalid-output" },
      validatorName: "invalid-output",
      validator: {
        command: process.execPath,
        args: ["-e", "process.stdout.write(Buffer.alloc(64,255))"],
        timeoutMs: 2_000,
        maxOutputBytes: 64,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
    });
    expect(record.outcome).toBe("passed");
    expect(record.outputBytes).toBe(64);
    expect(Buffer.byteLength(record.output, "utf8")).toBeLessThanOrEqual(64);
    expect(record.outputTruncated).toBe(true);
    if (process.platform === "win32") {
      expect(record.cleanup).toBe("retained");
      await removeMissionWorktree(
        {
          missionId: record.id,
          root: record.intendedPath,
          cwd: record.intendedPath,
          baseCommit: record.baseCommit,
          sourceRoot: record.sourceRoot,
        },
        { force: true },
      );
    } else await expectValidatorWorkspaceAbsent(record);
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it("quarantines a normal Windows exit when a descendant may survive", async () => {
    if (process.platform !== "win32") return;
    const setup = await fixture();
    const marker = join(setup.validators, "windows-descendant.pid");
    const record = await runPatchValidator({
      target: { kind: "run", id: "windows-natural-exit" },
      validatorName: "windows-natural-exit",
      validator: {
        command: process.execPath,
        args: [
          "-e",
          `const {spawn}=require('node:child_process');const fs=require('node:fs');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:'ignore'});c.unref();fs.writeFileSync(${JSON.stringify(marker)},String(c.pid))`,
        ],
        timeoutMs: 2_000,
        maxOutputBytes: 1_000,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
    });
    const descendantPid = Number(await waitForFile(marker));
    ownedPids.add(descendantPid);
    expect(record).toMatchObject({
      outcome: "passed",
      terminationProven: false,
      cleanup: "retained",
    });
    process.kill(descendantPid, "SIGKILL");
    await provePidDead(descendantPid);
    await removeMissionWorktree(
      {
        missionId: record.id,
        root: record.intendedPath,
        cwd: record.intendedPath,
        baseCommit: record.baseCommit,
        sourceRoot: record.sourceRoot,
      },
      { force: true },
    );
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it("reports spawn failure without invoking a shell", async () => {
    const setup = await fixture();
    const record = await runPatchValidator({
      target: { kind: "mission", id: "mission-1" },
      validatorName: "missing",
      validator: {
        command: join(setup.source, "does-not-exist"),
        args: ["; echo unsafe"],
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
    });
    expect(record).toMatchObject({ outcome: "spawn-failure", cleanup: "removed" });
    await expectValidatorWorkspaceAbsent(record);
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it.each([{ reason: "timeout" }, { reason: "cancel" }] as const)(
    "proves a stubborn owned descendant dead before $reason cleanup",
    async ({ reason }) => {
      if (process.platform === "win32") return;
      const setup = await fixture();
      const marker = join(setup.validators, `${reason}-descendant.pid`);
      const controller = new AbortController();
      let descendantPid = 0;
      let cleanupCalled = 0;
      const validation = runPatchValidator({
        target: { kind: "run", id: reason },
        validatorName: reason,
        validator: {
          command: process.execPath,
          args: ["-e", stubbornDescendantScript(marker)],
          timeoutMs: reason === "timeout" ? 1_000 : 5_000,
          maxOutputBytes: 1_000,
        },
        candidate: setup.candidate,
        worktree: setup.worktree,
        workspaceRoot: setup.validators,
        signal: controller.signal,
        cleanupWorkspace: async (workspace) => {
          cleanupCalled += 1;
          descendantPid ||= Number(await waitForFile(marker));
          ownedPids.add(descendantPid);
          await provePidDead(descendantPid);
          await removeMissionWorktree(workspace, { force: true });
          return { removed: true };
        },
      });
      if (reason === "cancel") {
        descendantPid = Number(await waitForFile(marker));
        ownedPids.add(descendantPid);
        controller.abort(new Error("manual cancel"));
      }
      const record = await validation;
      expect(record).toMatchObject({
        outcome: reason === "timeout" ? "timeout" : "aborted",
        cleanup: "removed",
        terminationProven: true,
      });
      expect(cleanupCalled).toBe(1);
      expect(descendantPid).toBeGreaterThan(0);
      await provePidDead(descendantPid);
      await expectValidatorWorkspaceAbsent(record);
      await removeMissionWorktree(setup.worktree, { force: true });
    },
    10_000,
  );

  it("returns a deterministic retained quarantine when cleanup falsely claims removal", async () => {
    const setup = await fixture();
    let retainedWorktree: Parameters<typeof removeMissionWorktree>[0] | undefined;
    const record = await runPatchValidator({
      target: { kind: "run", id: "quarantine" },
      validatorName: "quarantine",
      validator: {
        command: join(setup.source, "does-not-exist"),
        args: [],
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
      cleanupWorkspace: async (workspace) => {
        retainedWorktree = workspace;
        return { removed: true };
      },
    });
    expect(record).toMatchObject({
      outcome: "spawn-failure",
      cleanup: "retained",
      terminationProven: true,
      retainedPath: record.intendedPath,
    });
    expect(record.cleanupError).toBe("Cleanup reported removal but the workspace still exists.");
    expect((await fs.stat(record.intendedPath)).isDirectory()).toBe(true);
    expect(git(setup.source, "worktree", "list", "--porcelain")).toContain(record.intendedPath);
    expect(retainedWorktree).toBeDefined();
    await removeMissionWorktree(retainedWorktree!, { force: true });
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it("never throws from a failing cleanup seam and returns retained with cleanupError", async () => {
    const setup = await fixture();
    let retainedWorktree: Parameters<typeof removeMissionWorktree>[0] | undefined;
    const record = await runPatchValidator({
      target: { kind: "run", id: "cleanup-error" },
      validatorName: "cleanup-error",
      validator: {
        command: join(setup.source, "does-not-exist"),
        args: [],
        timeoutMs: 1_000,
        maxOutputBytes: 1_000,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
      cleanupWorkspace: async (workspace) => {
        retainedWorktree = workspace;
        throw new Error("cleanup seam exploded");
      },
    });
    expect(record).toMatchObject({
      outcome: "spawn-failure",
      cleanup: "retained",
      terminationProven: true,
      retainedPath: record.intendedPath,
      cleanupError: "Workspace cleanup failed: cleanup seam exploded",
    });
    expect((await fs.stat(record.intendedPath)).isDirectory()).toBe(true);
    await removeMissionWorktree(retainedWorktree!, { force: true });
    await removeMissionWorktree(setup.worktree, { force: true });
  });

  it("aborts only after a validator marker and reports conservative Windows cleanup", async () => {
    const setup = await fixture();
    const controller = new AbortController();
    const marker = join(setup.validators, "abort-ready");
    let running = 0;
    const promise = runPatchValidator({
      target: { kind: "run", id: "abort" },
      validatorName: "abort",
      validator: {
        command: process.execPath,
        args: [
          "-e",
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ready');setInterval(()=>{},1000)`,
        ],
        timeoutMs: 5_000,
        maxOutputBytes: 1_000,
      },
      candidate: setup.candidate,
      worktree: setup.worktree,
      workspaceRoot: setup.validators,
      onRunning: () => {
        running += 1;
      },
      signal: controller.signal,
    });
    await waitForFile(marker);
    controller.abort(new Error("manual cancel"));
    const record = await promise;
    expect(record).toMatchObject({ status: "interrupted", outcome: "aborted" });
    if (process.platform === "win32") {
      expect(record).toMatchObject({ cleanup: "retained", terminationProven: false });
      await removeMissionWorktree(
        {
          missionId: record.id,
          root: record.intendedPath,
          cwd: record.intendedPath,
          baseCommit: record.baseCommit,
          sourceRoot: record.sourceRoot,
        },
        { force: true },
      );
    } else {
      expect(record).toMatchObject({ cleanup: "removed", terminationProven: true });
      await expectValidatorWorkspaceAbsent(record);
    }
    expect(running).toBe(1);
    await removeMissionWorktree(setup.worktree, { force: true });
  });
});
