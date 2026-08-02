/** Shared OpenAI Codex OAuth helpers used by provider integrations. */

/** Extracts the ChatGPT account id embedded in a Codex OAuth access token. */
export function extractCodexAccountId(token: string): string {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("invalid token");
    const payload = JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8")) as {
      [key: string]: unknown;
    };
    const auth = payload["https://api.openai.com/auth"];
    const accountId =
      auth && typeof auth === "object"
        ? (auth as Record<string, unknown>).chatgpt_account_id
        : undefined;
    if (typeof accountId !== "string" || !accountId) throw new Error("missing account id");
    return accountId;
  } catch {
    throw new Error(
      "OpenAI Codex authentication is invalid. Run `/login openai-codex` and try again.",
    );
  }
}

/** Builds the authenticated headers required by the native Codex endpoints. */
export function buildCodexHeaders(
  token: string,
  accountId: string,
  inherited?: Record<string, unknown>,
): Headers {
  const headers = new Headers();
  const blockedInherited = new Set([
    "authorization",
    "chatgpt-account-id",
    "connection",
    "content-length",
    "cookie",
    "host",
    "originator",
    "proxy-authorization",
    "transfer-encoding",
  ]);
  for (const [key, value] of Object.entries(inherited ?? {})) {
    if (typeof value === "string" && !blockedInherited.has(key.toLowerCase()))
      headers.set(key, value);
  }
  // Provider-supplied values must not be allowed to override these credentials or protocol headers.
  headers.set("authorization", `Bearer ${token}`);
  headers.set("chatgpt-account-id", accountId);
  headers.set("originator", "pi");
  headers.set("accept", "application/json");
  headers.set("content-type", "application/json");
  return headers;
}
