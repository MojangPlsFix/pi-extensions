export type SupervisorRequestKind =
  | "decision"
  | "approval"
  | "blocker"
  | "progress"
  | "integration-ready";

export type SupervisorRequestStatus = "pending" | "answered" | "rejected" | "cancelled";

export type SupervisorChoice = {
  value: string;
  label: string;
  description?: string;
};

export type SupervisorRequest = {
  id: string;
  missionId?: string;
  fromRunId: string;
  kind: SupervisorRequestKind;
  title: string;
  detail: string;
  choices: SupervisorChoice[];
  blocking: boolean;
  status: SupervisorRequestStatus;
  createdAt: string;
  resolvedAt?: string;
  answer?: string;
};

export type SupervisorRequestInput = Pick<
  SupervisorRequest,
  "missionId" | "fromRunId" | "kind" | "title" | "detail"
> & {
  choices?: SupervisorChoice[];
};

export type SupervisorResolution = {
  status: Exclude<SupervisorRequestStatus, "pending">;
  answer?: string;
};

type PendingResolution = {
  resolve: (resolution: SupervisorResolution) => void;
};

function requestId(): string {
  return `request-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clone(request: SupervisorRequest): SupervisorRequest {
  return { ...request, choices: request.choices.map((choice) => ({ ...choice })) };
}

export class SupervisorInbox {
  private readonly entries = new Map<string, SupervisorRequest>();
  private readonly pending = new Map<string, PendingResolution>();
  private readonly listeners = new Set<(requests: SupervisorRequest[]) => void>();

  all(): SupervisorRequest[] {
    return [...this.entries.values()]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .map(clone);
  }

  open(): SupervisorRequest[] {
    return this.all().filter((entry) => entry.status === "pending");
  }

  subscribe(listener: (requests: SupervisorRequest[]) => void): () => void {
    this.listeners.add(listener);
    listener(this.all());
    return () => this.listeners.delete(listener);
  }

  private publish(): void {
    const snapshot = this.all();
    for (const listener of this.listeners) listener(snapshot);
  }

  /**
   * Record a supervisor event. Progress is nonblocking and resolves immediately;
   * decisions, approvals, blockers, and integration handoffs wait for a response.
   */
  request(input: SupervisorRequestInput): {
    request: SupervisorRequest;
    resolution: Promise<SupervisorResolution>;
  } {
    if (!input.fromRunId.trim()) throw new Error("Supervisor requests require a source run id.");
    if (!input.title.trim()) throw new Error("Supervisor requests require a title.");
    if (!input.detail.trim()) throw new Error("Supervisor requests require actionable detail.");
    const blocking = input.kind !== "progress";
    const entry: SupervisorRequest = {
      id: requestId(),
      missionId: input.missionId,
      fromRunId: input.fromRunId,
      kind: input.kind,
      title: input.title.trim(),
      detail: input.detail.trim(),
      choices: (input.choices ?? []).map((choice) => ({ ...choice })),
      blocking,
      status: blocking ? "pending" : "answered",
      createdAt: new Date().toISOString(),
      ...(blocking ? {} : { resolvedAt: new Date().toISOString() }),
    };
    this.entries.set(entry.id, entry);
    const resolution = blocking
      ? new Promise<SupervisorResolution>((resolve) => this.pending.set(entry.id, { resolve }))
      : Promise.resolve({ status: "answered" as const });
    this.publish();
    return { request: clone(entry), resolution };
  }

  resolve(id: string, answer: string): SupervisorRequest {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown supervisor request: ${id}.`);
    if (entry.status !== "pending")
      throw new Error(`Supervisor request ${id} is already resolved.`);
    const trimmed = answer.trim();
    if (!trimmed) throw new Error("A supervisor response must not be empty.");
    if (entry.choices.length && !entry.choices.some((choice) => choice.value === trimmed))
      throw new Error(
        `Supervisor response must be one of: ${entry.choices.map((choice) => choice.value).join(", ")}.`,
      );
    entry.status = "answered";
    entry.answer = trimmed;
    entry.resolvedAt = new Date().toISOString();
    this.pending.get(id)?.resolve({ status: "answered", answer: trimmed });
    this.pending.delete(id);
    this.publish();
    return clone(entry);
  }

  reject(id: string, reason?: string): SupervisorRequest {
    return this.finish(id, "rejected", reason);
  }

  cancel(id: string, reason?: string): SupervisorRequest {
    return this.finish(id, "cancelled", reason);
  }

  cancelByRun(runId: string, reason = "Source run stopped."): void {
    for (const entry of this.entries.values())
      if (entry.fromRunId === runId && entry.status === "pending")
        this.finish(entry.id, "cancelled", reason);
  }

  private finish(id: string, status: "rejected" | "cancelled", answer?: string): SupervisorRequest {
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`Unknown supervisor request: ${id}.`);
    if (entry.status !== "pending")
      throw new Error(`Supervisor request ${id} is already resolved.`);
    entry.status = status;
    entry.answer = answer?.trim() || undefined;
    entry.resolvedAt = new Date().toISOString();
    this.pending.get(id)?.resolve({ status, answer: entry.answer });
    this.pending.delete(id);
    this.publish();
    return clone(entry);
  }

  reset(reason = "Supervisor session changed."): void {
    for (const entry of this.entries.values())
      if (entry.status === "pending") this.finish(entry.id, "cancelled", reason);
    this.entries.clear();
    this.pending.clear();
    this.publish();
  }

  dispose(): void {
    this.reset("Supervisor inbox disposed.");
    this.listeners.clear();
  }
}
