import type { ContextLanguage } from "./runner.js";

export type ContextToolParams = {
  language?: ContextLanguage;
  code?: string;
  path?: string;
  timeout?: number;
  cwd?: string;
  intent?: string;
  commands?: Array<{ label?: string; command?: string }>;
  queries?: string[];
  concurrency?: number;
  query_scope?: "batch" | "global";
  [key: string]: unknown;
};

export type ContextDetails = {
  status: "running" | "success" | "error" | "cancelled";
  backend: "native" | "external-bridge";
  outputBytes?: number;
  truncated?: boolean;
  cancellation?: "hard" | "best-effort-external";
  toolName?: string;
  phase?: "execute" | "index" | "search";
  elapsedMs?: number;
  completedCommands?: number;
  totalCommands?: number;
};

export type ContextUpdate = {
  content: Array<{ type: "text"; text: string }>;
  details: ContextDetails;
};
