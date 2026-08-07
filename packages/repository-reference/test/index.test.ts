import { describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  cleanupRepositoryReferences: vi.fn(),
  cloneRepositoryReference: vi.fn(),
  listRepositoryReferences: vi.fn(),
  removeRepositoryReference: vi.fn(),
}));
vi.mock("../store.js", () => storeMocks);

import repositoryReferenceExtension from "../index.js";

type RegisteredTool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    context: unknown,
  ) => Promise<{ content: Array<{ text?: string }> }>;
};

function registeredTool(): RegisteredTool {
  let tool: RegisteredTool | undefined;
  repositoryReferenceExtension({
    registerTool: (candidate: unknown) => {
      tool = candidate as unknown as RegisteredTool;
    },
  } as never);
  if (!tool) throw new Error("repository_reference tool was not registered");
  return tool;
}

function text(result: { content: Array<{ text?: string }> }): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("repository_reference tool", () => {
  it("clones without UI confirmation", async () => {
    const tool = registeredTool();
    const confirm = vi.fn();
    const reference = {
      id: "ref-test",
      remote: "https://github.com/example/project.git",
      revision: "main",
      resolvedRevision: "0123456789abcdef0123456789abcdef01234567",
      path: "/tmp/pi-repository-references/ref-test",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    storeMocks.cloneRepositoryReference.mockResolvedValueOnce(reference);

    const result = await tool.execute(
      "call",
      { action: "clone", remote: reference.remote, revision: reference.revision },
      undefined,
      undefined,
      { hasUI: false, ui: { confirm } },
    );

    expect(text(result)).toContain("Created repository reference ref-test");
    expect(confirm).not.toHaveBeenCalled();
    expect(storeMocks.cloneRepositoryReference).toHaveBeenCalledWith(
      reference.remote,
      reference.revision,
    );
  });

  it("rejects local file remotes without asking for confirmation", async () => {
    const tool = registeredTool();
    const confirm = vi.fn();

    const result = await tool.execute(
      "call",
      { action: "clone", remote: "file:///tmp/example.git" },
      undefined,
      undefined,
      { hasUI: true, ui: { confirm } },
    );

    expect(text(result)).toContain("remote must use https, http, ssh, or git");
    expect(confirm).not.toHaveBeenCalled();
  });
});
