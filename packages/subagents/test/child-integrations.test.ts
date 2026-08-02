import { describe, expect, it, vi } from "vitest";
import { createIdempotentShutdown } from "../child-context-mode.js";

describe("child integration lifecycle", () => {
  it("cleans a partially started Context Mode client exactly once", () => {
    const client = { shutdown: vi.fn(() => {}) };
    const state: { client?: typeof client } = { client };
    const shutdown = createIdempotentShutdown(state);

    shutdown();
    shutdown();

    expect(client.shutdown).toHaveBeenCalledOnce();
    expect(state.client).toBeUndefined();
  });

  it("does not let cleanup errors escape or repeat", () => {
    const client = {
      shutdown: vi.fn(() => {
        throw new Error("already closed");
      }),
    };
    const state: { client?: typeof client } = { client };
    const shutdown = createIdempotentShutdown(state);

    expect(() => shutdown()).not.toThrow();
    expect(() => shutdown()).not.toThrow();
    expect(client.shutdown).toHaveBeenCalledOnce();
  });
});
