import { promises as fs } from "node:fs";
import { join } from "node:path";
import type { RpcEvent } from "./rpc-client.js";
import type { ManagedAgent } from "./types.js";

const MAX_ACTIVITY = 24;

type SessionRecord = {
  type?: string;
  timestamp?: string;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  message?: { role?: string; content?: unknown; usage?: unknown; toolName?: string };
};

export function textFromContent(content: unknown): string {
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is { type?: unknown; text?: unknown } =>
        Boolean(part) && typeof part === "object",
    )
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

export function addUsage(agent: ManagedAgent, usage: unknown): void {
  if (!usage || typeof usage !== "object") return;
  const value = usage as Record<string, unknown>;
  const number = (key: string) => (typeof value[key] === "number" ? value[key] : 0);
  agent.usage.input += number("input");
  agent.usage.output += number("output");
  agent.usage.cacheRead += number("cacheRead");
  agent.usage.cacheWrite += number("cacheWrite");
  agent.usage.total += number("totalTokens") || number("total");
  if (
    value.cost &&
    typeof value.cost === "object" &&
    typeof (value.cost as { total?: unknown }).total === "number"
  )
    agent.usage.cost += (value.cost as { total: number }).total;
}

export function recordActivity(
  agent: ManagedAgent,
  kind: ManagedAgent["activity"][number]["kind"],
  text: string,
  at = new Date().toISOString(),
): void {
  agent.activity.push({ at, kind, text });
  if (agent.activity.length > MAX_ACTIVITY)
    agent.activity.splice(0, agent.activity.length - MAX_ACTIVITY);
}

/** Consume telemetry carried directly by the RPC transport. */
export function consumeRpcTelemetry(agent: ManagedAgent, event: RpcEvent): void {
  if (event.type === "message_end" && event.message?.role === "assistant") {
    agent.output = textFromContent(event.message.content) || agent.output;
    addUsage(agent, event.message.usage);
    recordActivity(
      agent,
      "message",
      (agent.output || "assistant response").replace(/\s+/gu, " ").slice(0, 160),
    );
  }
  if (event.type === "response" && event.data?.sessionFile)
    agent.sessionFile = event.data.sessionFile;
}

/** Consume one persisted Pi session JSONL record. Returns whether an assistant report was observed. */
export function consumeSessionRecord(
  agent: ManagedAgent,
  record: SessionRecord,
  includeUsage = true,
): boolean {
  const at = record.timestamp ?? new Date().toISOString();
  if (record.type === "model_change" && record.modelId)
    agent.effectiveModel = record.provider
      ? `${record.provider}/${record.modelId}`
      : record.modelId;
  if (record.type === "thinking_level_change" && record.thinkingLevel)
    agent.effectiveThinking = record.thinkingLevel;
  if (record.type !== "message" || !record.message) return false;
  if (record.message.role === "assistant") {
    const report = textFromContent(record.message.content);
    if (report) {
      agent.output = report;
      recordActivity(agent, "message", report.replace(/\s+/gu, " ").slice(0, 160), at);
    }
    if (includeUsage) addUsage(agent, record.message.usage);
    // Tool-call/thinking assistant records are intermediate turns. Only persisted text is a report.
    return Boolean(report);
  }
  if (record.message.role === "toolResult") {
    recordActivity(
      agent,
      "tool",
      record.message.toolName ? `used ${record.message.toolName}` : "completed a tool",
      at,
    );
  }
  return false;
}

/** Incrementally follows the child session that Pi creates inside an isolated session directory. */
export class SessionPoller {
  private timer?: ReturnType<typeof setInterval>;
  private file?: string;
  private offset = 0;
  private remainder = "";
  private pollTail: Promise<void> = Promise.resolve();
  private legacyAssistant = false;
  private generation?: { text: string; userPersisted: boolean; assistantPersisted: boolean; offset: number };

  constructor(
    private readonly agent: ManagedAgent,
    private readonly onUpdate: () => void,
    private readonly includeUsage = true,
  ) {}

  start(): void {
    if (!this.timer) {
      void this.pollOnce();
      this.timer = setInterval(() => {
        void this.pollOnce();
      }, 400);
    }
  }
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }
  hasAssistantSincePrompt(): boolean {
    return this.generation
      ? Boolean(this.generation.userPersisted && this.generation.assistantPersisted)
      : this.legacyAssistant;
  }
  /** Begin an exact, persisted turn boundary after draining records already present. */
  async beginPrompt(text: string): Promise<void> {
    await this.pollOnce();
    this.generation = { text, userPersisted: false, assistantPersisted: false, offset: this.offset };
  }
  resetPromptBoundary(): void {
    // Kept for callers that cannot provide text; it never consumes old reports.
    this.generation = { text: "", userPersisted: true, assistantPersisted: false, offset: this.offset };
    this.legacyAssistant = false;
  }
  rollbackPromptBoundary(): void { this.generation = undefined; }

  /** One deterministic incremental poll, exposed for lifecycle verification and diagnostics. */
  async pollOnce(): Promise<void> {
    const operation = this.pollTail.then(() => this.pollNow(), () => this.pollNow());
    this.pollTail = operation.catch(() => {});
    return operation;
  }
  private async pollNow(): Promise<void> {
    try {
      if (!this.file) this.file = await this.findSessionFile();
      if (!this.file) return;
      this.agent.sessionFile = this.file;
      const content = await fs.readFile(this.file, "utf8");
      if (content.length < this.offset) {
        this.offset = 0;
        this.remainder = "";
      }
      const fresh = content.slice(this.offset);
      this.offset = content.length;
      for (const line of (this.remainder + fresh).split("\n")) {
        if (!line) continue;
        try {
          const record = JSON.parse(line) as SessionRecord;
          const report = consumeSessionRecord(this.agent, record, this.includeUsage);
          const generation = this.generation;
          if (!generation && report) this.legacyAssistant = true;
          if (generation && record.type === "message" && record.message) {
            if (record.message.role === "user") {
              const text = textFromContent(record.message.content);
              if (text === generation.text) generation.userPersisted = true;
            } else if (generation.userPersisted && report) generation.assistantPersisted = true;
          }
        } catch {
          this.remainder = line;
          continue;
        }
        this.remainder = "";
      }
      this.onUpdate();
    } catch {
      /* A child can create its file after us or be writing it; retry next tick. */
    }
  }

  private async findSessionFile(): Promise<string | undefined> {
    const entries = await fs.readdir(this.agent.sessionDir, {
      recursive: true,
      withFileTypes: true,
    });
    const jsonl = entries.find((entry) => entry.isFile() && entry.name.endsWith(".jsonl"));
    if (!jsonl) return undefined;
    return join(jsonl.parentPath ?? this.agent.sessionDir, jsonl.name);
  }
}
