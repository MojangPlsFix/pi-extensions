import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateReferenceId, validateRemote, validateRevision } from "../model.js";
import {
  cleanupRepositoryReferences,
  cloneRepositoryReference,
  listRepositoryReferences,
  removeRepositoryReference,
} from "../store.js";

const roots: string[] = [];
const resolvedRevision = "0123456789abcdef0123456789abcdef01234567";

async function temporaryRoot(): Promise<string> {
  const root = await fs.mkdtemp(join(tmpdir(), "repository-reference-test-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

describe("repository reference validation", () => {
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
});

describe("managed repository references", () => {
  it("clones into a managed path and supports list, remove, and cleanup", async () => {
    const root = await temporaryRoot();
    const calls: string[][] = [];
    const fakeGit = async (args: string[]) => {
      calls.push(args);
      if (args[0] === "clone") await fs.mkdir(args[3]!, { recursive: true });
      return { stdout: args[2] === "rev-parse" ? `${resolvedRevision}\n` : "", stderr: "" };
    };

    const reference = await cloneRepositoryReference(
      "https://github.com/example/project.git",
      "main",
      root,
      fakeGit,
    );
    expect(reference.path.startsWith(`${root}/ref-`)).toBe(true);
    expect(reference.resolvedRevision).toBe(resolvedRevision);
    expect(calls).toEqual([
      ["clone", "--no-checkout", "https://github.com/example/project.git", reference.path],
      ["-C", reference.path, "checkout", "--detach", "--quiet", "main"],
      ["-C", reference.path, "rev-parse", "HEAD"],
    ]);
    expect(await listRepositoryReferences(root)).toEqual([reference]);

    await removeRepositoryReference(reference.id, root);
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
});
