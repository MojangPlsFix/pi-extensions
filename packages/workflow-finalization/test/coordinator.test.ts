import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CONTINUATION_MESSAGE_TYPE,
  ContinuationCoordinator,
  type ContinuationSnapshot,
  deliveredContinuationDetails,
  deterministicProducerId,
  withContinuationDetails,
} from "../coordinator.js";

function entry(id: string, parentId: string | null = null): SessionEntry {
  return {
    type: "message",
    id,
    parentId,
    timestamp: "2026-01-01T00:00:00Z",
    message: { role: "user", content: "x", timestamp: 1 },
  } as SessionEntry;
}

function custom(id: string, snapshot: ContinuationSnapshot): SessionEntry {
  return {
    type: "custom",
    customType: "workflow-finalization:continuation-state",
    data: snapshot,
    id,
    parentId: null,
    timestamp: "2026-01-01T00:00:00Z",
  };
}

function delivered(id: string, requestId: string, producerId: string): SessionEntry {
  return {
    type: "custom_message",
    customType: CONTINUATION_MESSAGE_TYPE,
    content: "continue",
    display: true,
    details: { version: 1, requestId, producerId },
    id,
    parentId: "root",
    timestamp: "2026-01-01T00:00:00Z",
  };
}

function harness() {
  let latest: ContinuationSnapshot | undefined;
  const host = {
    persist: vi.fn((snapshot: ContinuationSnapshot) => {
      latest = structuredClone(snapshot);
    }),
    send: vi.fn(),
    receipt: vi.fn(),
    activity: vi.fn(),
  };
  const coordinator = new ContinuationCoordinator(host);
  return { coordinator, host, latest: () => latest };
}

describe("ContinuationCoordinator", () => {
  it("serializes requests and receipts only the corresponding started, settled run", () => {
    const subject = harness();
    const branch = [entry("root")];
    subject.coordinator.restore("session", branch, branch, true);
    expect(subject.coordinator.enqueue({ producerId: "a", message: { content: "one" } })).toEqual({
      accepted: true,
      requestId: "a:1",
    });
    subject.coordinator.enqueue({ producerId: "b", message: { content: "two" } });
    expect(subject.host.send).toHaveBeenCalledTimes(1);
    subject.coordinator.agentSettled();
    expect(subject.host.receipt).not.toHaveBeenCalled();
    subject.coordinator.agentStarted();
    subject.coordinator.agentSettled();
    expect(subject.host.receipt).toHaveBeenCalledWith(
      expect.objectContaining({
        producerId: "a",
        requestId: "a:1",
        status: "settled",
        sessionId: "session",
        originEntryId: "root",
      }),
    );
    expect(subject.host.send).toHaveBeenCalledTimes(2);
  });

  it("defers an inactive origin branch and dispatches it when that branch is active", () => {
    const subject = harness();
    const origin = [entry("root"), entry("origin", "root")];
    subject.coordinator.restore("session", origin, origin, false);
    subject.coordinator.enqueue({ producerId: "p", message: { content: "work" } });
    subject.coordinator.setBranch([entry("root"), entry("sibling", "root")]);
    subject.coordinator.setIdle(true);
    expect(subject.host.send).not.toHaveBeenCalled();
    subject.coordinator.setBranch(origin);
    subject.coordinator.setIdle(true);
    expect(subject.host.send).toHaveBeenCalledTimes(1);
  });

  it("reconciles delivered IDs on reload without resending and deduplicates producer keys", () => {
    const first = harness();
    const branch = [entry("root")];
    first.coordinator.restore("session", branch, branch, true);
    first.coordinator.enqueue({
      producerId: "p",
      dedupeKey: "wave-1",
      message: { content: "work" },
    });
    const snapshot = first.latest();
    expect(snapshot).toBeDefined();

    const second = harness();
    const entries = [...branch, custom("state", snapshot!), delivered("delivery", "p:1", "p")];
    second.coordinator.restore("session", entries, entries, true);
    expect(second.host.send).not.toHaveBeenCalled();
    expect(
      second.coordinator.enqueue({
        producerId: "p",
        dedupeKey: "wave-1",
        message: { content: "duplicate" },
      }),
    ).toMatchObject({ accepted: false, requestId: "p:1", reason: "deduplicated" });
  });

  it("does not break single-flight when a delivered request is cancelled", () => {
    const subject = harness();
    const branch = [entry("root")];
    subject.coordinator.restore("session", branch, branch, true);
    subject.coordinator.enqueue({ producerId: "p", message: { content: "one" } });
    subject.coordinator.enqueue({ producerId: "p", message: { content: "two" } });
    subject.coordinator.cancel("p", "p:1");
    expect(subject.host.send).toHaveBeenCalledTimes(1);
    subject.coordinator.agentStarted();
    subject.coordinator.agentSettled();
    expect(subject.host.send).toHaveBeenCalledTimes(2);
  });

  it("does not let a sibling assistant settle an origin-branch delivery", () => {
    const first = harness();
    const origin = [entry("root"), entry("origin", "root")];
    first.coordinator.restore("session", origin, origin, true);
    first.coordinator.enqueue({
      producerId: "branch",
      requestId: "branch:stable",
      message: { content: "origin work" },
    });
    const state = custom("state", first.latest()!);
    const delivery = { ...delivered("delivery", "branch:stable", "branch"), parentId: "origin" };
    const sibling = entry("sibling", "root");
    const unrelatedAssistant = {
      ...entry("assistant", "sibling"),
      message: {
        role: "assistant",
        content: [{ type: "text", text: "unrelated" }],
        timestamp: 2,
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      },
    } as SessionEntry;

    const second = harness();
    second.coordinator.restore(
      "session",
      [...origin, state, delivery, sibling, unrelatedAssistant],
      [origin[0]!, sibling, unrelatedAssistant],
      true,
    );
    expect(second.coordinator.getRequest("branch:stable")?.status).toBe("dispatched");
    expect(second.coordinator.hasOpenRequests()).toBe(false);
    expect(second.host.receipt).not.toHaveBeenCalled();
    expect(second.host.send).not.toHaveBeenCalled();
  });

  it("supports canonical IDs and preserves producer renderer details in its envelope", () => {
    const subject = harness();
    const branch = [entry("root")];
    subject.coordinator.restore("session", branch, branch, false);
    expect(
      subject.coordinator.enqueue({
        producerId: "batch",
        requestId: "hackler-batch:abc",
        message: { content: "reports", customType: "subagent-batch-v3", details: { batch: 7 } },
      }),
    ).toMatchObject({ accepted: true, requestId: "hackler-batch:abc" });
    expect(
      subject.coordinator.enqueue({
        producerId: "batch",
        requestId: "hackler-batch:abc",
        message: { content: "different" },
      }),
    ).toMatchObject({ accepted: false, reason: "request ID conflict" });

    const details = withContinuationDetails(
      { batch: 7 },
      {
        version: 1,
        requestId: "hackler-batch:abc",
        producerId: "batch",
      },
    );
    const message = {
      type: "custom_message",
      id: "delivery",
      parentId: "root",
      timestamp: "2026-01-01T00:00:00Z",
      customType: "subagent-batch-v3",
      content: "reports",
      display: true,
      details,
    } as SessionEntry;
    expect(details.batch).toBe(7);
    expect(deliveredContinuationDetails(message)).toMatchObject({
      requestId: "hackler-batch:abc",
      producerId: "batch",
    });
  });

  it("invalidates all runtime dispatch state on shutdown", () => {
    const subject = harness();
    const branch = [entry("root")];
    subject.coordinator.restore("session", branch, branch, false);
    subject.coordinator.enqueue({ producerId: "p", message: { content: "work" } });
    subject.coordinator.shutdown();
    subject.coordinator.setIdle(true);
    subject.coordinator.agentStarted();
    subject.coordinator.agentSettled();
    expect(subject.host.send).not.toHaveBeenCalled();
    expect(subject.host.receipt).not.toHaveBeenCalled();
  });

  it("builds deterministic producer IDs", () => {
    expect(deterministicProducerId("Hackler", "integration")).toBe(
      deterministicProducerId("Hackler", "integration"),
    );
    expect(deterministicProducerId("Hackler", "integration")).not.toBe(
      deterministicProducerId("Hackler", "review"),
    );
  });
});
