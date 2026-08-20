#!/usr/bin/env node

import { open, stat } from "node:fs/promises";
import { basename } from "node:path";

const sessionFile = process.argv[2];
const configuredLimit = Number(process.argv[3]);
const maxOutputBytes =
  Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 1_000_000;
if (!sessionFile) {
  process.stderr.write("Usage: inspector-runner.mjs <session.jsonl>\n");
  process.exit(2);
}

let offset = 0;
let remainder = "";
let reading = false;
let stopped = false;

const terminalEscape = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu;
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;

function safeText(value) {
  return String(value)
    .replace(terminalEscape, "")
    .replace(/\r\n?/gu, "\n")
    .replace(unsafeControl, " ");
}

function safeLine(value) {
  return safeText(value).replace(/\s+/gu, " ").trim();
}

const maxEntryBytes = Math.min(maxOutputBytes, 16_384);

function truncateText(value, limit = maxEntryBytes) {
  const text = safeText(value);
  if (Buffer.byteLength(text, "utf8") <= limit) return text;
  let truncated = text;
  while (truncated && Buffer.byteLength(`${truncated}\n[… entry truncated …]`, "utf8") > limit)
    truncated = truncated.slice(0, -1);
  return `${truncated}\n[… entry truncated …]`;
}

function jsonText(value) {
  try {
    return truncateText(JSON.stringify(value, null, 2));
  } catch {
    return truncateText(String(value));
  }
}

function textContent(content) {
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((part) => {
      if (!part || typeof part !== "object") return [];
      if (part.type === "text" && typeof part.text === "string") return [part.text];
      if (part.type === "thinking" && typeof part.thinking === "string")
        return [`[thinking] ${part.thinking}`];
      if (part.type === "toolCall")
        return [
          `[tool] ${part.name ?? "unknown"}`,
          `arguments:\n${jsonText(part.arguments ?? {})}`,
        ];
      return [];
    })
    .join("\n");
}

function toolResultText(message) {
  const name = typeof message.toolName === "string" ? message.toolName : "unknown";
  const lines = [`[result] ${name}${message.isError ? " · error" : ""}`];
  const output = textContent(message.content);
  if (output) lines.push(`output:\n${truncateText(output)}`);
  if (message.details !== undefined) lines.push(`details:\n${jsonText(message.details)}`);
  return lines.join("\n");
}

function render(line) {
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (entry?.type !== "message" || !entry.message) return;
  const role = safeLine(typeof entry.message.role === "string" ? entry.message.role : "event");
  const rawBody =
    entry.message.role === "toolResult"
      ? toolResultText(entry.message)
      : textContent(entry.message.content);
  const body = truncateText(rawBody).trim();
  if (!body) return;
  const stamp = safeLine(typeof entry.timestamp === "string" ? entry.timestamp.slice(11, 19) : "");
  process.stdout.write(`\n\x1b[1m${stamp} ${role}\x1b[0m\n${body}\n`);
}

async function readMore() {
  if (reading || stopped) return;
  reading = true;
  try {
    const info = await stat(sessionFile);
    if (info.size < offset) {
      offset = 0;
      remainder = "";
    }
    if (info.size === offset) return;
    const handle = await open(sessionFile, "r");
    try {
      const unread = info.size - offset;
      if (unread > maxOutputBytes) {
        offset = info.size - maxOutputBytes;
        remainder = "";
      }
      const length = Math.min(info.size - offset, maxOutputBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, offset);
      offset += length;
      const lines = `${remainder}${buffer.toString("utf8")}`.split("\n");
      remainder = lines.pop() ?? "";
      if (Buffer.byteLength(remainder, "utf8") > maxOutputBytes) remainder = "";
      for (const line of lines) if (line.trim()) render(line);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code !== "ENOENT")
      process.stderr.write(`Inspector read error: ${safeLine(error?.message ?? error)}\n`);
  } finally {
    reading = false;
  }
}

process.stdout.write(
  `\x1b[2J\x1b[H\x1b[1mSubagent transcript · ${safeLine(basename(sessionFile))}\x1b[0m\n`,
);
process.stdout.write("Display only · close the pane to exit\n");
await readMore();
const timer = setInterval(readMore, 350);

function stop() {
  stopped = true;
  clearInterval(timer);
  process.exit(0);
}
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
