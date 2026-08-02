import { spawn, spawnSync } from "node:child_process";
import {
  boundedCopilotOutput,
  DEFAULT_COPILOT_SEARCH_EFFORT,
  DEFAULT_COPILOT_SEARCH_MODEL,
  maximumOutputCharacters,
  normalizeSearchParams,
  promptFor,
  type SearchMode,
  type SearchParams,
} from "./search.js";

export function copilotAvailable(executable = "copilot"): boolean {
  try {
    return spawnSync(executable, ["--version"], { stdio: "ignore", timeout: 2_000 }).status === 0;
  } catch {
    return false;
  }
}

/** Builds shell-free retrieval arguments, including the intentionally cheap default backend. */
export function buildCopilotArguments(mode: SearchMode, params: SearchParams): string[] {
  const normalized = normalizeSearchParams({ ...params, kind: mode });
  const model = normalized.model ?? DEFAULT_COPILOT_SEARCH_MODEL;
  const effort = normalized.reasoningEffort ?? DEFAULT_COPILOT_SEARCH_EFFORT;
  return [
    "-p",
    promptFor(normalized),
    "--no-ask-user",
    "--no-custom-instructions",
    "--stream",
    "off",
    "--model",
    model,
    "--effort",
    effort,
    "--output-format",
    "json",
  ];
}

function assistantAnswer(output: string): string {
  const messages: string[] = [];
  for (const line of output.split("\n")) {
    try {
      const event = JSON.parse(line) as { type?: unknown; data?: { content?: unknown } };
      if (event.type === "assistant.message" && typeof event.data?.content === "string")
        messages.push(event.data.content);
    } catch {
      /* Plain-text CLI output remains supported. */
    }
  }
  return messages.at(-1)?.trim() || output.trim();
}

export function copilotSpawnOptions(
  signal?: AbortSignal,
  cwd = process.cwd(),
): {
  cwd: string;
  stdio: ["ignore", "pipe", "pipe"];
  shell: false;
  signal: AbortSignal | undefined;
  windowsHide: boolean;
} {
  return {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    shell: false,
    signal,
    windowsHide: true,
  };
}

export async function runCopilotSearch(
  mode: SearchMode,
  params: SearchParams,
  signal?: AbortSignal,
  executable = "copilot",
  onStatus?: (value: string) => void,
  cwd = process.cwd(),
): Promise<string> {
  const args = buildCopilotArguments(mode, params);
  onStatus?.("Searching with Copilot CLI…");
  if (!copilotAvailable(executable))
    throw new Error(
      "Copilot CLI search is unavailable. Install and authenticate `copilot`, then run `copilot login`.",
    );
  const child = spawn(executable, args, { ...copilotSpawnOptions(signal, cwd) });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout = (stdout + chunk).slice(-maximumOutputCharacters * 2);
  });
  child.stderr.on("data", (chunk: string) => {
    stderr = (stderr + chunk).slice(-4_000);
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  if (code !== 0)
    throw new Error(
      `Copilot CLI search failed (exit code ${code ?? "unknown"}). Confirm the configured model and run \`copilot login\`.`,
    );
  const answer = assistantAnswer(stdout);
  if (!answer) throw new Error("Copilot CLI search completed without an answer.");
  return boundedCopilotOutput(answer);
}
