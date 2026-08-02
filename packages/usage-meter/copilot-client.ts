import { execFile as execFileCallback } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { type CopilotQuota, parseCopilotQuota } from "./copilot-quota.js";

const credentialCacheMs = 5 * 60_000;
const endpoint = "https://api.github.com/copilot_internal/user";
type RecordValue = Record<string, unknown>;
const record = (value: unknown): value is RecordValue =>
  Boolean(value && typeof value === "object");

const execFile = promisify(execFileCallback);
let cachedCredentials: { expiresAt: number; values: string[] } | undefined;

async function credentialCandidates(): Promise<string[]> {
  if (cachedCredentials && cachedCredentials.expiresAt > Date.now())
    return cachedCredentials.values;
  const candidates: string[] = [];
  try {
    const agentDir =
      process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=$|[\\/])/, homedir()) ||
      join(homedir(), ".pi", "agent");
    const auth = JSON.parse(await readFile(join(agentDir, "auth.json"), "utf8")) as unknown;
    const copilot =
      record(auth) && record(auth["github-copilot"]) ? auth["github-copilot"] : undefined;
    for (const value of [copilot?.refresh, copilot?.access])
      if (typeof value === "string" && value && !candidates.includes(value)) candidates.push(value);
  } catch {
    /* no Pi Copilot authentication is a quiet no-op */
  }
  try {
    const { stdout } = await execFile("gh", ["auth", "token"], { timeout: 5_000 });
    const token = stdout.toString().trim();
    if (token && !candidates.includes(token)) candidates.push(token);
  } catch {
    /* GitHub CLI is optional */
  }
  cachedCredentials = { expiresAt: Date.now() + credentialCacheMs, values: candidates };
  return candidates;
}

export async function fetchCopilotQuota(
  fetchImpl: typeof fetch = fetch,
): Promise<CopilotQuota | undefined> {
  for (const token of await credentialCandidates()) {
    try {
      const response = await fetchImpl(endpoint, {
        headers: {
          Accept: "application/json",
          Authorization: `token ${token}`,
          "User-Agent": "Pi",
        },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) continue;
      const quota = parseCopilotQuota(await response.json());
      if (quota) return quota;
    } catch {
      /* try another credential or quietly leave the provider UI empty */
    }
  }
  return undefined;
}
