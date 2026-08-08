import { describe, expect, it } from "vitest";
import { events, type HerdrBlockedEvent, withBlockingUserInteraction } from "../events.js";

function eventRecorder() {
  const emitted: Array<{ name: string; data: unknown }> = [];
  return {
    emitted,
    emitter: {
      emit(name: string, data: unknown) {
        emitted.push({ name, data });
      },
    },
  };
}

describe("withBlockingUserInteraction", () => {
  it("emits exact start and end payloads around a successful operation", async () => {
    const { emitted, emitter } = eventRecorder();

    await expect(
      withBlockingUserInteraction(emitter, "Choose a model", async () => "selected"),
    ).resolves.toBe("selected");

    expect(emitted).toEqual([
      {
        name: events.userInteraction,
        data: { active: true, reason: "Choose a model" },
      },
      {
        name: events.herdrBlocked,
        data: { active: true, label: "Choose a model" },
      },
      {
        name: events.userInteraction,
        data: { active: false, reason: "Choose a model" },
      },
      {
        name: events.herdrBlocked,
        data: { active: false },
      },
    ]);
  });

  it("ends both event streams when the user cancels", async () => {
    const { emitted, emitter } = eventRecorder();

    await expect(
      withBlockingUserInteraction(emitter, "Confirm a change", async () => undefined),
    ).resolves.toBeUndefined();

    expect(emitted.slice(-2)).toEqual([
      {
        name: events.userInteraction,
        data: { active: false, reason: "Confirm a change" },
      },
      {
        name: events.herdrBlocked,
        data: { active: false },
      },
    ]);
  });

  it("ends both event streams and preserves thrown errors", async () => {
    const { emitted, emitter } = eventRecorder();
    const failure = new Error("dialog failed");

    await expect(
      withBlockingUserInteraction(emitter, "Open a dialog", async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);

    expect(emitted.slice(-2)).toEqual([
      {
        name: events.userInteraction,
        data: { active: false, reason: "Open a dialog" },
      },
      {
        name: events.herdrBlocked,
        data: { active: false },
      },
    ]);
  });

  it("emits balanced pairs for overlapping operations", async () => {
    const blockedCounts: number[] = [];
    let blockedCount = 0;
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const emitter = {
      emit(name: string, data: unknown) {
        if (name !== events.herdrBlocked) return;
        const event = data as HerdrBlockedEvent;
        blockedCount += event.active ? 1 : -1;
        blockedCounts.push(blockedCount);
      },
    };

    const first = withBlockingUserInteraction(
      emitter,
      "First dialog",
      () =>
        new Promise<void>((resolve) => {
          resolveFirst = resolve;
        }),
    );
    const second = withBlockingUserInteraction(
      emitter,
      "Second dialog",
      () =>
        new Promise<void>((resolve) => {
          resolveSecond = resolve;
        }),
    );

    expect(blockedCounts).toEqual([1, 2]);
    resolveFirst();
    await first;
    expect(blockedCounts).toEqual([1, 2, 1]);
    resolveSecond();
    await second;
    expect(blockedCounts).toEqual([1, 2, 1, 0]);
  });
});
