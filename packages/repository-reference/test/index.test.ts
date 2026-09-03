import { beforeEach, describe, expect, it, vi } from "vitest";

const storeMocks = vi.hoisted(() => ({
  cleanupRepositoryReferences: vi.fn(),
  cloneRepositoryReference: vi.fn(),
  listRepositoryReferences: vi.fn(),
  removeRepositoryReference: vi.fn(),
}));
vi.mock("../store.js", () => storeMocks);

import { initTheme } from "@earendil-works/pi-coding-agent";
import repositoryReferenceExtension from "../index.js";

type ToolResult = {
  content: Array<{ text?: string }>;
  details?: unknown;
};

type RegisteredTool = {
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal: AbortSignal | undefined,
    onUpdate: ((result: ToolResult) => void) | undefined,
    context: unknown,
  ) => Promise<ToolResult>;
  renderResult?: (
    result: ToolResult,
    options: { expanded: boolean; isPartial: boolean },
    theme: { fg: (name: string, text: string) => string; bold: (text: string) => string },
    context: { isError: boolean },
  ) => { render(width: number): string[] };
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

function text(result: ToolResult): string {
  return result.content.map((item) => item.text ?? "").join("\n");
}

describe("repository_reference tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("streams clone progress and forwards clone options", async () => {
    const tool = registeredTool();
    const reference = {
      id: "ref-test",
      remote: "https://github.com/example/project.git",
      revision: "main",
      resolvedRevision: "0123456789abcdef0123456789abcdef01234567",
      path: "/tmp/pi-repository-references/ref-test",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    storeMocks.cloneRepositoryReference.mockImplementationOnce(
      async (
        _remote: string,
        _revision: string,
        options: { onProgress?: (progress: unknown) => void },
      ) => {
        options.onProgress?.({ phase: "clone", message: "Cloning repository…" });
        options.onProgress?.({ phase: "metadata", message: "Repository reference is ready." });
        return reference;
      },
    );
    const onUpdate = vi.fn();

    const result = await tool.execute(
      "call",
      {
        action: "clone",
        remote: reference.remote,
        revision: reference.revision,
        verbose: true,
      },
      undefined,
      onUpdate,
      { hasUI: false },
    );

    expect(text(result)).toContain("Created repository reference ref-test");
    expect(storeMocks.cloneRepositoryReference).toHaveBeenCalledWith(
      reference.remote,
      reference.revision,
      expect.objectContaining({
        verbose: true,
        signal: undefined,
        onProgress: expect.any(Function),
      }),
    );
    expect(onUpdate).toHaveBeenCalledTimes(2);
    expect(onUpdate.mock.calls[0]?.[0].content[0].text).toBe("Cloning repository…");
  });

  it("keeps clone success when an update renderer throws", async () => {
    const tool = registeredTool();
    const reference = {
      id: "ref-test",
      remote: "https://github.com/example/project.git",
      revision: "main",
      resolvedRevision: "0123456789abcdef0123456789abcdef01234567",
      path: "/tmp/pi-repository-references/ref-test",
      createdAt: "2025-01-01T00:00:00.000Z",
    };
    storeMocks.cloneRepositoryReference.mockImplementationOnce(
      async (
        _remote: string,
        _revision: string,
        options: { onProgress?: (progress: unknown) => void },
      ) => {
        options.onProgress?.({ phase: "clone", message: "Cloning repository…" });
        return reference;
      },
    );
    const onUpdate = vi.fn(() => {
      throw new Error("renderer failed");
    });

    await expect(
      tool.execute(
        "call",
        { action: "clone", remote: reference.remote, revision: reference.revision },
        undefined,
        onUpdate,
        { hasUI: true },
      ),
    ).resolves.toMatchObject({ details: { reference } });
    expect(onUpdate).toHaveBeenCalledOnce();
  });

  it("uses Pi error semantics for invalid clone inputs", async () => {
    const tool = registeredTool();

    await expect(
      tool.execute(
        "call",
        { action: "clone", remote: "file:///tmp/example.git" },
        undefined,
        undefined,
        { hasUI: true },
      ),
    ).rejects.toThrow("remote must use https, http, ssh, or git");
    expect(storeMocks.cloneRepositoryReference).not.toHaveBeenCalled();
  });

  it("renders collapsed and expanded progress using Pi's tool expansion state", () => {
    initTheme("dark", false);
    const tool = registeredTool();
    const renderResult = tool.renderResult;
    if (!renderResult) throw new Error("repository_reference renderResult was not registered");
    const theme = { fg: (_name: string, value: string) => value, bold: (value: string) => value };
    const result: ToolResult = {
      content: [{ text: "Receiving objects: 42%" }],
      details: {
        action: "clone",
        phase: "clone",
        status: "Receiving objects: 42%",
        progress: ["Cloning repository…", "Receiving objects: 42%"],
      },
    };

    const collapsed = renderResult(result, { expanded: false, isPartial: true }, theme, {
      isError: false,
    });
    const expanded = renderResult(result, { expanded: true, isPartial: true }, theme, {
      isError: false,
    });

    expect(collapsed.render(120).join("\n")).toContain("to expand");
    expect(expanded.render(120).join("\n")).toContain("Cloning repository…");
  });
});
