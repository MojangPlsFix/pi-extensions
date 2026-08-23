import { describe, expect, it, vi } from "vitest";
import { SupervisorInbox } from "../supervisor.js";

describe("SupervisorInbox", () => {
  it("records progress without blocking", async () => {
    const inbox = new SupervisorInbox();
    const { request, resolution } = inbox.request({
      fromRunId: "run-1",
      kind: "progress",
      title: "Review complete",
      detail: "No blockers found.",
    });
    expect(request.blocking).toBe(false);
    expect(request.status).toBe("answered");
    await expect(resolution).resolves.toEqual({ status: "answered" });
  });

  it("pauses a decision until an allowed answer arrives", async () => {
    const inbox = new SupervisorInbox();
    const { request, resolution } = inbox.request({
      fromRunId: "run-1",
      kind: "decision",
      title: "Choose storage",
      detail: "The implementation needs one storage format.",
      choices: [
        { value: "json", label: "JSON" },
        { value: "sqlite", label: "SQLite" },
      ],
    });
    expect(inbox.open()).toHaveLength(1);
    expect(() => inbox.resolve(request.id, "yaml")).toThrow("must be one of");
    inbox.resolve(request.id, "sqlite");
    await expect(resolution).resolves.toEqual({ status: "answered", answer: "sqlite" });
    expect(inbox.open()).toHaveLength(0);
  });

  it("finds all pending requests and the oldest request linked to one run", () => {
    const inbox = new SupervisorInbox();
    const first = inbox.request({
      fromRunId: "run-1",
      kind: "decision",
      title: "Choose format",
      detail: "A format is required.",
    }).request;
    const second = inbox.request({
      fromRunId: "run-1",
      kind: "blocker",
      title: "Missing input",
      detail: "The required input is missing.",
    }).request;
    inbox.request({
      fromRunId: "run-2",
      kind: "approval",
      title: "Approve operation",
      detail: "The other run needs approval.",
    });

    expect(inbox.pendingForRun("run-1").map((request) => request.id)).toEqual([
      first.id,
      second.id,
    ]);
    expect(inbox.oldestPendingForRun("run-1")?.id).toBe(first.id);
    expect(inbox.oldestPendingForRun("missing")).toBeUndefined();
    inbox.resolve(first.id, "continue");
    expect(inbox.oldestPendingForRun("run-1")?.id).toBe(second.id);
    inbox.dispose();
  });

  it("cancels pending requests owned by a stopped run", async () => {
    const inbox = new SupervisorInbox();
    const listener = vi.fn();
    const unsubscribe = inbox.subscribe(listener);
    const { resolution } = inbox.request({
      fromRunId: "run-1",
      kind: "blocker",
      title: "Missing fixture",
      detail: "The requested fixture does not exist.",
    });
    inbox.cancelByRun("run-1");
    await expect(resolution).resolves.toEqual({
      status: "cancelled",
      answer: "Source run stopped.",
    });
    expect(listener).toHaveBeenCalled();
    unsubscribe();
  });
});
