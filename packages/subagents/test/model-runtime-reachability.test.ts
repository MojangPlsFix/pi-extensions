import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";

describe("parent model runtime bridge", () => {
  it("keeps the installed ModelRegistry runtime reachable for isolated child sessions", async () => {
    const runtime = await ModelRuntime.create({ modelsPath: null });
    const registry = new ModelRegistry(runtime);
    expect((registry as unknown as { runtime?: ModelRuntime }).runtime).toBe(runtime);
  });
});
