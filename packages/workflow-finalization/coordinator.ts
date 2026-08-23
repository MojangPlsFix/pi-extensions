import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type {
  ContinuationActivityEvent,
  ContinuationEnqueueEvent,
  ContinuationMessage,
  ContinuationReceiptEvent,
} from "../../shared/events.js";

export const CONTINUATION_STATE_ENTRY = "workflow-finalization:continuation-state";
export const CONTINUATION_MESSAGE_TYPE = "workflow-finalization:continuation";
export const CONTINUATION_DETAILS_KEY = "workflowContinuation";

export type PersistedContinuationRequest = {
  version: 1;
  requestId: string;
  producerId: string;
  sequence: number;
  /** Monotonic per-request revision prevents stale sibling snapshots from regressing status. */
  revision: number;
  dedupeKey?: string;
  message: ContinuationMessage;
  sessionId: string;
  originEntryId: string | null;
  deliveryEntryId?: string;
  settledEntryId?: string;
  status: "queued" | "dispatched" | "settled" | "cancelled";
};

export type ContinuationSnapshot = {
  version: 1;
  producerSequences: Record<string, number>;
  requests: PersistedContinuationRequest[];
};

export type DeliveredContinuationDetails = {
  version: 1;
  requestId: string;
  producerId: string;
};

export type CoordinatorHost = {
  persist(snapshot: ContinuationSnapshot): void;
  /** send must append synchronously and may return the resulting branch leaf. */
  send(request: PersistedContinuationRequest): { entryId?: string } | undefined;
  receipt(event: ContinuationReceiptEvent): void;
  activity(event: ContinuationActivityEvent): void;
};

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function validMessage(value: unknown): value is ContinuationMessage {
  return (
    record(value) &&
    typeof value.content === "string" &&
    value.content.trim().length > 0 &&
    (value.customType === undefined ||
      (typeof value.customType === "string" && value.customType.trim().length > 0)) &&
    (value.display === undefined || typeof value.display === "boolean")
  );
}

function cloneMessage(message: ContinuationMessage): ContinuationMessage {
  return {
    content: message.content,
    ...(message.customType ? { customType: message.customType } : {}),
    ...(message.display !== undefined ? { display: message.display } : {}),
    ...(message.details !== undefined ? { details: structuredClone(message.details) } : {}),
  };
}

function sameMessage(left: ContinuationMessage, right: ContinuationMessage): boolean {
  try {
    return JSON.stringify(left) === JSON.stringify(right);
  } catch {
    return false;
  }
}

export function parseContinuationSnapshot(value: unknown): ContinuationSnapshot | undefined {
  if (!record(value) || value.version !== 1 || !record(value.producerSequences)) return undefined;
  const producerSequences: Record<string, number> = {};
  for (const [producer, sequence] of Object.entries(value.producerSequences)) {
    if (producer && Number.isSafeInteger(sequence) && (sequence as number) >= 0)
      producerSequences[producer] = sequence as number;
  }
  if (!Array.isArray(value.requests)) return undefined;
  const requests: PersistedContinuationRequest[] = [];
  for (const candidate of value.requests) {
    if (
      !record(candidate) ||
      candidate.version !== 1 ||
      typeof candidate.requestId !== "string" ||
      !candidate.requestId ||
      typeof candidate.producerId !== "string" ||
      !candidate.producerId ||
      !Number.isSafeInteger(candidate.sequence) ||
      !(candidate.revision === undefined || Number.isSafeInteger(candidate.revision)) ||
      typeof candidate.sessionId !== "string" ||
      !(candidate.originEntryId === null || typeof candidate.originEntryId === "string") ||
      !(candidate.deliveryEntryId === undefined || typeof candidate.deliveryEntryId === "string") ||
      !(candidate.settledEntryId === undefined || typeof candidate.settledEntryId === "string") ||
      !["queued", "dispatched", "settled", "cancelled"].includes(String(candidate.status)) ||
      !validMessage(candidate.message)
    )
      continue;
    requests.push({
      version: 1,
      requestId: candidate.requestId,
      producerId: candidate.producerId,
      sequence: candidate.sequence as number,
      revision: typeof candidate.revision === "number" ? candidate.revision : 0,
      ...(typeof candidate.dedupeKey === "string" ? { dedupeKey: candidate.dedupeKey } : {}),
      message: cloneMessage(candidate.message),
      sessionId: candidate.sessionId,
      originEntryId: candidate.originEntryId,
      ...(typeof candidate.deliveryEntryId === "string"
        ? { deliveryEntryId: candidate.deliveryEntryId }
        : {}),
      ...(typeof candidate.settledEntryId === "string"
        ? { settledEntryId: candidate.settledEntryId }
        : {}),
      status: candidate.status as PersistedContinuationRequest["status"],
    });
  }
  return { version: 1, producerSequences, requests };
}

/** Stable, human-readable producer ID for packages that do not already have one. */
export function deterministicProducerId(namespace: string, purpose: string): string {
  const source = `${namespace.trim().toLowerCase()}\u0000${purpose.trim().toLowerCase()}`;
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index++) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const slug = `${namespace}-${purpose}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return `${slug || "producer"}:${(hash >>> 0).toString(16).padStart(8, "0")}`;
}

/** Read the coordinator envelope without constraining producer-owned details. */
export function deliveredContinuationDetails(
  entry: SessionEntry,
): DeliveredContinuationDetails | undefined {
  if (entry.type !== "custom_message") return undefined;
  const details = entry.details;
  const nested = record(details) ? details[CONTINUATION_DETAILS_KEY] : undefined;
  const candidate = record(nested) ? nested : details;
  if (
    !record(candidate) ||
    candidate.version !== 1 ||
    typeof candidate.requestId !== "string" ||
    typeof candidate.producerId !== "string"
  )
    return undefined;
  return {
    version: 1,
    requestId: candidate.requestId,
    producerId: candidate.producerId,
  };
}

/** Merge the receipt envelope into object details while preserving renderer data. */
export function withContinuationDetails(
  details: unknown,
  envelope: DeliveredContinuationDetails,
): Record<string, unknown> {
  return {
    ...(record(details) ? details : details === undefined ? {} : { producerDetails: details }),
    [CONTINUATION_DETAILS_KEY]: envelope,
  };
}

/** Newest persisted request revision for reload-time producer reconciliation. */
export function findPersistedContinuationRequest(
  entries: SessionEntry[],
  requestId: string,
): PersistedContinuationRequest | undefined {
  let found: PersistedContinuationRequest | undefined;
  for (const entry of entries) {
    if (entry.type !== "custom" || entry.customType !== CONTINUATION_STATE_ENTRY) continue;
    const snapshot = parseContinuationSnapshot(entry.data);
    const candidate = snapshot?.requests.find((request) => request.requestId === requestId);
    if (candidate && (!found || candidate.revision >= found.revision)) found = candidate;
  }
  return found ? { ...found, message: cloneMessage(found.message) } : undefined;
}

function isDescendant(
  entriesById: ReadonlyMap<string, SessionEntry>,
  descendantId: string,
  ancestorId: string,
): boolean {
  let current = entriesById.get(descendantId);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    if (current.id === ancestorId) return true;
    seen.add(current.id);
    current = current.parentId ? entriesById.get(current.parentId) : undefined;
  }
  return false;
}

export class ContinuationCoordinator {
  private requests: PersistedContinuationRequest[] = [];
  private sequences: Record<string, number> = {};
  private sessionId: string | undefined;
  private branchIds = new Set<string>();
  private originEntryId: string | null = null;
  private idle = false;
  private active = false;
  private inFlight: string | undefined;
  private inFlightStarted = false;
  private gates = new Set<string>();

  constructor(private readonly host: CoordinatorHost) {}

  restore(sessionId: string, entries: SessionEntry[], branch: SessionEntry[], idle: boolean): void {
    this.clearRuntime();
    this.active = true;
    this.sessionId = sessionId;
    this.idle = idle;
    this.setBranch(branch);

    // Merge snapshots in append order. Divergent branches may each own pending work.
    const merged = new Map<string, PersistedContinuationRequest>();
    for (const entry of entries) {
      if (entry.type !== "custom" || entry.customType !== CONTINUATION_STATE_ENTRY) continue;
      const parsed = parseContinuationSnapshot(entry.data);
      if (!parsed) continue;
      for (const [producer, sequence] of Object.entries(parsed.producerSequences))
        this.sequences[producer] = Math.max(this.sequences[producer] ?? 0, sequence);
      for (const request of parsed.requests) {
        if (request.sessionId !== sessionId) continue;
        this.sequences[request.producerId] = Math.max(
          this.sequences[request.producerId] ?? 0,
          request.sequence,
        );
        const previous = merged.get(request.requestId);
        if (!previous || request.revision >= previous.revision)
          merged.set(request.requestId, { ...request, message: cloneMessage(request.message) });
      }
    }
    this.requests = [...merged.values()].sort(
      (left, right) =>
        left.sequence - right.sequence || left.requestId.localeCompare(right.requestId),
    );

    const entriesById = new Map(entries.map((entry) => [entry.id, entry]));
    const deliveries = new Map<string, SessionEntry[]>();
    for (const entry of entries) {
      const details = deliveredContinuationDetails(entry);
      if (!details) continue;
      const candidates = deliveries.get(details.requestId) ?? [];
      candidates.push(entry);
      deliveries.set(details.requestId, candidates);
    }

    const restoredReceipts: ContinuationReceiptEvent[] = [];
    let changed = false;
    for (const request of this.requests) {
      if (request.status !== "queued" && request.status !== "dispatched") continue;
      const delivery = deliveries
        .get(request.requestId)
        ?.find(
          (entry) =>
            deliveredContinuationDetails(entry)?.producerId === request.producerId &&
            (request.originEntryId === null ||
              isDescendant(entriesById, entry.id, request.originEntryId)),
        );
      if (!delivery) {
        if (request.status === "dispatched") {
          request.status = "queued";
          request.revision += 1;
          delete request.deliveryEntryId;
          changed = true;
        }
        continue;
      }

      if (request.status !== "dispatched" || request.deliveryEntryId !== delivery.id) {
        request.status = "dispatched";
        request.deliveryEntryId = delivery.id;
        request.revision += 1;
        changed = true;
      }
      const completion = entries.find(
        (entry) =>
          entry.type === "message" &&
          entry.message.role === "assistant" &&
          isDescendant(entriesById, entry.id, delivery.id),
      );
      if (completion) {
        request.status = "settled";
        request.settledEntryId = completion.id;
        request.revision += 1;
        changed = true;
        restoredReceipts.push(this.receiptFor(request, "settled"));
      } else if (this.branchIds.has(delivery.id)) {
        // Pi exposes no message-less turn reservation after process death. Keep
        // the durable delivery claimed rather than appending a duplicate.
        this.inFlight = request.requestId;
      }
    }
    if (changed) this.persist();
    this.publish();
    for (const receipt of restoredReceipts) this.host.receipt(receipt);
    this.dispatch();
  }

  setBranch(branch: SessionEntry[]): void {
    this.branchIds = new Set(branch.map((entry) => entry.id));
    this.originEntryId = branch.at(-1)?.id ?? null;
  }

  setIdle(idle: boolean): void {
    this.idle = idle;
    if (idle) this.dispatch();
  }

  setGate(gateId: string, active: boolean): void {
    if (!gateId) return;
    if (active) this.gates.add(gateId);
    else this.gates.delete(gateId);
    this.publish();
    if (!active) this.dispatch();
  }

  enqueue(event: ContinuationEnqueueEvent): {
    accepted: boolean;
    requestId?: string;
    reason?: string;
  } {
    const producerId = event.producerId.trim();
    if (!this.active || !this.sessionId) return { accepted: false, reason: "no active session" };
    if (!producerId || !validMessage(event.message))
      return { accepted: false, reason: "invalid continuation request" };
    if (event.sessionId && event.sessionId !== this.sessionId)
      return { accepted: false, reason: "session mismatch" };
    const originEntryId =
      event.originEntryId === undefined ? this.originEntryId : event.originEntryId;
    if (originEntryId !== null && !this.branchIds.has(originEntryId))
      return { accepted: false, reason: "origin is not on the active branch" };

    const explicitId = event.requestId?.trim();
    if (event.requestId !== undefined && !explicitId)
      return { accepted: false, reason: "invalid request ID" };
    if (explicitId) {
      const byId = this.requests.find((request) => request.requestId === explicitId);
      if (byId) {
        const matches =
          byId.producerId === producerId &&
          byId.sessionId === this.sessionId &&
          byId.originEntryId === originEntryId &&
          byId.dedupeKey === event.dedupeKey &&
          sameMessage(byId.message, event.message);
        return {
          accepted: false,
          requestId: byId.requestId,
          reason: matches ? "deduplicated" : "request ID conflict",
        };
      }
    }
    const existing = this.requests.find(
      (request) =>
        request.producerId === producerId &&
        event.dedupeKey !== undefined &&
        request.dedupeKey === event.dedupeKey &&
        request.status !== "cancelled",
    );
    if (existing) return { accepted: false, requestId: existing.requestId, reason: "deduplicated" };

    const sequence = (this.sequences[producerId] ?? 0) + 1;
    this.sequences[producerId] = sequence;
    const request: PersistedContinuationRequest = {
      version: 1,
      requestId: explicitId ?? `${producerId}:${sequence}`,
      producerId,
      sequence,
      revision: 1,
      ...(event.dedupeKey !== undefined ? { dedupeKey: event.dedupeKey } : {}),
      message: cloneMessage(event.message),
      sessionId: this.sessionId,
      originEntryId,
      status: "queued",
    };
    this.requests.push(request);
    this.persist();
    this.publish();
    this.dispatch();
    return { accepted: true, requestId: request.requestId };
  }

  cancel(producerId: string, requestId?: string): void {
    let changed = false;
    for (const request of this.requests) {
      if (
        request.producerId !== producerId ||
        (requestId && request.requestId !== requestId) ||
        request.status === "settled" ||
        request.status === "cancelled"
      )
        continue;
      request.status = "cancelled";
      request.revision += 1;
      changed = true;
      this.host.receipt(this.receiptFor(request, "cancelled"));
    }
    if (changed) this.persist();
    this.publish();
    this.dispatch();
  }

  agentStarted(): void {
    if (this.inFlight) this.inFlightStarted = true;
  }

  agentSettled(settledEntryId?: string): void {
    if (!this.inFlight || !this.inFlightStarted) return;
    const request = this.requests.find((candidate) => candidate.requestId === this.inFlight);
    this.inFlight = undefined;
    this.inFlightStarted = false;
    if (request?.status === "cancelled") {
      this.publish();
      this.dispatch();
      return;
    }
    if (request?.status !== "dispatched") return;
    request.status = "settled";
    if (settledEntryId) request.settledEntryId = settledEntryId;
    request.revision += 1;
    this.persist();
    this.host.receipt(this.receiptFor(request, "settled"));
    this.publish();
    this.dispatch();
  }

  getRequest(requestId: string): PersistedContinuationRequest | undefined {
    const request = this.requests.find((candidate) => candidate.requestId === requestId);
    return request ? { ...request, message: cloneMessage(request.message) } : undefined;
  }

  hasOpenRequests(producerId?: string, activeBranchOnly = true): boolean {
    return this.requests.some(
      (request) =>
        (!producerId || request.producerId === producerId) &&
        (!activeBranchOnly || this.isOriginActive(request)) &&
        (request.status === "queued" || request.status === "dispatched"),
    );
  }

  shutdown(): void {
    this.clearRuntime();
    this.publish();
  }

  private clearRuntime(): void {
    this.active = false;
    this.sessionId = undefined;
    this.branchIds.clear();
    this.originEntryId = null;
    this.idle = false;
    this.inFlight = undefined;
    this.inFlightStarted = false;
    this.gates.clear();
    this.requests = [];
    this.sequences = {};
  }

  private isOriginActive(request: PersistedContinuationRequest): boolean {
    return request.originEntryId === null || this.branchIds.has(request.originEntryId);
  }

  private receiptFor(
    request: PersistedContinuationRequest,
    status: ContinuationReceiptEvent["status"],
  ): ContinuationReceiptEvent {
    return {
      producerId: request.producerId,
      requestId: request.requestId,
      status,
      sessionId: request.sessionId,
      originEntryId: request.originEntryId,
      ...(request.deliveryEntryId ? { deliveryEntryId: request.deliveryEntryId } : {}),
      ...(request.settledEntryId ? { settledEntryId: request.settledEntryId } : {}),
    };
  }

  private dispatch(): void {
    if (!this.active || !this.sessionId || !this.idle || this.inFlight || this.gates.size > 0)
      return;
    const request = this.requests.find(
      (candidate) => candidate.status === "queued" && this.isOriginActive(candidate),
    );
    if (!request) return;
    // Persist the single-flight claim before invoking Pi. A reload can distinguish
    // a delivered custom message from a claim whose send threw.
    request.status = "dispatched";
    request.revision += 1;
    this.inFlight = request.requestId;
    this.inFlightStarted = false;
    this.persist();
    this.publish();
    try {
      const sent = this.host.send(request);
      if (sent?.entryId && request.status === "dispatched") {
        request.deliveryEntryId = sent.entryId;
        request.revision += 1;
        this.persist();
      }
    } catch {
      if (this.inFlight === request.requestId) {
        this.inFlight = undefined;
        request.status = "queued";
        request.revision += 1;
        delete request.deliveryEntryId;
        this.persist();
        this.publish();
      }
    }
  }

  private snapshot(): ContinuationSnapshot {
    return {
      version: 1,
      producerSequences: { ...this.sequences },
      requests: this.requests.map((request) => ({
        ...request,
        message: cloneMessage(request.message),
      })),
    };
  }

  private persist(): void {
    if (this.active) this.host.persist(this.snapshot());
  }

  private publish(): void {
    const activeOpen = this.requests.filter(
      (request) =>
        this.isOriginActive(request) &&
        (request.status === "queued" || request.status === "dispatched"),
    );
    this.host.activity({
      ...(this.sessionId ? { sessionId: this.sessionId } : {}),
      open: activeOpen.length,
      queued: activeOpen.filter((request) => request.status === "queued").length,
      ...(this.inFlight ? { inFlight: this.inFlight } : {}),
      gated: this.gates.size > 0,
    });
  }
}
