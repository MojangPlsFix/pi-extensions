import { spawn } from "node:child_process";
import { basename } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const maximumBodyLength = 160;
const maximumTitleLength = 60;
type NotificationMode = "winrt" | "osc99" | "osc777";

export function isWsl(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
}
export function notificationMode(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): NotificationMode {
  if (platform === "win32" || isWsl(env)) return "winrt";
  return env.KITTY_WINDOW_ID ? "osc99" : "osc777";
}

function compact(value: string, maximum: number): string {
  const text = value
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
}
function textContent(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const content = (message as { content?: unknown }).content;
  if (typeof content === "string") return compact(content, maximumBodyLength) || undefined;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join(" ");
  return compact(text, maximumBodyLength) || undefined;
}
function roleIs(message: unknown, role: string): boolean {
  return Boolean(
    message && typeof message === "object" && (message as { role?: unknown }).role === role,
  );
}
function powershellEncoded(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}
function powershellText(value: string): string {
  return `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
}
async function sendWindowsToast(title: string, body: string): Promise<void> {
  const appId =
    process.env.PI_WINDOWS_TOAST_APP_ID?.trim() || "Microsoft.WindowsTerminal_8wekyb3d8bbwe!App";
  const script = [
    "$ErrorActionPreference = 'Stop'",
    "[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null",
    `$appId=${powershellText(appId)}`,
    `$title=${powershellText(title)}`,
    `$body=${powershellText(body)}`,
    "$xml=[Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)",
    "$nodes=$xml.GetElementsByTagName('text')",
    "$nodes.Item(0).AppendChild($xml.CreateTextNode($title)) > $null",
    "$nodes.Item(1).AppendChild($xml.CreateTextNode($body)) > $null",
    "[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($appId).Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
  ].join("\n");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-EncodedCommand", powershellEncoded(script)],
      { stdio: "ignore", windowsHide: true },
    );
    child.once("error", reject);
    child.once("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`powershell.exe exited with ${code ?? -1}`)),
    );
  });
}

export async function sendNotification(title: string, body: string): Promise<void> {
  const safeTitle = compact(title, maximumTitleLength).replaceAll(";", ",");
  const safeBody = compact(body, maximumBodyLength).replaceAll(";", ",");
  switch (notificationMode()) {
    case "winrt":
      return sendWindowsToast(safeTitle, safeBody);
    case "osc99":
      process.stdout.write(
        `\x1b]99;i=1:d=0;${safeTitle}\x1b\\\x1b]99;i=1:p=body;${safeBody}\x1b\\`,
      );
      return;
    case "osc777":
      process.stdout.write(`\x1b]777;notify;${safeTitle};${safeBody}\x07`);
      return;
  }
}

function taskLabel(pi: ExtensionAPI, ctx: ExtensionContext): string {
  const named = pi.getSessionName()?.trim() || ctx.sessionManager.getSessionName()?.trim();
  if (named) return compact(named, maximumTitleLength);
  for (const entry of [...ctx.sessionManager.getBranch()].reverse()) {
    if (entry.type !== "message" || !roleIs(entry.message, "user")) continue;
    const text = textContent(entry.message);
    if (text && !text.startsWith("/") && !/^(ok|okay|yes|no|thanks|thank you)$/i.test(text))
      return compact(text, maximumTitleLength);
  }
  return basename(ctx.cwd) || "session";
}

export default function notifyExtension(pi: ExtensionAPI): void {
  let enabled = true;
  const notify = async (ctx: ExtensionContext, body: string): Promise<void> => {
    if (!enabled) return;
    try {
      await sendNotification(`Pi · ${taskLabel(pi, ctx)}`, body);
    } catch (error) {
      console.error(
        `[pi-extensions notify] ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };
  const test = async (_args: string, ctx: ExtensionContext): Promise<void> => {
    try {
      await sendNotification(`Pi test · ${taskLabel(pi, ctx)}`, "Test notification");
      ctx.ui.notify(`Notification sent via ${notificationMode()}.`, "info");
    } catch (error) {
      ctx.ui.notify(
        `Notification test failed: ${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    }
  };
  pi.on("turn_end", async (event, ctx) => {
    if (
      ctx.signal?.aborted ||
      !roleIs(event.message, "assistant") ||
      event.toolResults.length > 0 ||
      ctx.hasPendingMessages()
    )
      return;
    await notify(ctx, textContent(event.message) || "Finished");
  });
  pi.registerCommand("notify-test", {
    description: "Send a desktop notification test.",
    handler: test,
  });
  pi.registerCommand("notify-toggle", {
    description: "Toggle completion notifications.",
    handler: async (_args, ctx) => {
      enabled = !enabled;
      ctx.ui.notify(`Notifications ${enabled ? "enabled" : "disabled"}.`, "info");
    },
  });
  pi.registerCommand("notify-status", {
    description: "Show notification mode and enabled state.",
    handler: async (_args, ctx) =>
      ctx.ui.notify(
        `mode=${notificationMode()} | enabled=${enabled} | task=${taskLabel(pi, ctx)}`,
        "info",
      ),
  });
}
