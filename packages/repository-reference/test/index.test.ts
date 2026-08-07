import { describe, expect, it, vi } from "vitest";
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
  it("rejects clone without UI instead of starting a network operation", async () => {
    const tool = registeredTool();
    const confirm = vi.fn();

    const result = await tool.execute(
      "call",
      { action: "clone", remote: "https://github.com/example/project.git", revision: "main" },
      undefined,
      undefined,
      { hasUI: false, ui: { confirm } },
    );

    expect(text(result)).toContain("interactive UI confirmation");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("confirms a clone before allowing it to proceed", async () => {
    const tool = registeredTool();
    const confirm = vi.fn().mockResolvedValue(false);

    const result = await tool.execute(
      "call",
      { action: "clone", remote: "https://github.com/example/project.git", revision: "main" },
      undefined,
      undefined,
      { hasUI: true, ui: { confirm } },
    );

    expect(confirm).toHaveBeenCalledWith(
      "Confirm repository clone",
      "Clone https://github.com/example/project.git at revision main? This may access the network and create a temporary checkout.",
    );
    expect(text(result)).toContain("repository reference clone cancelled");
  });

  it("rejects local file remotes before asking for confirmation", async () => {
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
