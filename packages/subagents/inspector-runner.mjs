#!/usr/bin/env node

import { open, stat } from "node:fs/promises";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
import {
  AssistantMessageComponent,
  getMarkdownTheme,
  initTheme,
  ToolExecutionComponent,
  UserMessageComponent,
} from "@earendil-works/pi-coding-agent";

const terminalEscape = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu;
const unsafeControl = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\p{Cf}]/gu;
const osc133 = /\x1b\]133;[ABC]\x07/gu;

const defaultTheme = "dark";
const entryTruncatedSuffix = "[… entry truncated …]";
const valueTruncatedSuffix = "[… truncated …]";

const sessionFile = process.argv[2];
const configuredLimit = Number(process.argv[3]);
const inspectorCwd =
  process.argv[4] && safeLine(process.argv[4]) ? safeText(process.argv[4]) : process.cwd();
const requestedTheme =
  process.argv[5] && safeLine(process.argv[5]) ? safeLine(process.argv[5]) : defaultTheme;

const maxOutputBytes =
  Number.isFinite(configuredLimit) && configuredLimit > 0 ? Math.floor(configuredLimit) : 1_000_000;
const preRenderBudgetBytes = Math.max(1, Math.min(maxOutputBytes, 131_072));
const maxEntryBytes = Math.max(1, Math.min(maxOutputBytes, 24_576));
const maxStringBytes = Math.max(1, Math.min(maxEntryBytes, 8_192));
const maxRenderedLines = 220;
const maxJsonLineBytes = preRenderBudgetBytes;
const maxSanitizeNodes = Math.max(1, Math.min(2_048, Math.floor(preRenderBudgetBytes / 64)));
const maxContentParts = Math.max(1, Math.min(128, Math.floor(preRenderBudgetBytes / 1_024)));
const maxArrayEntries = Math.max(1, Math.min(256, Math.floor(preRenderBudgetBytes / 256)));
const maxObjectEntries = Math.max(1, Math.min(256, Math.floor(preRenderBudgetBytes / 256)));

let markdownTheme;
let offset = 0;
let remainder = "";
let reading = false;
let stopped = false;

const pendingToolCalls = new Map();
const TOOL_CACHE_LIMIT = 1_000;

const TOOL_UI = {
  requestRender() {},
};

function safeText(value) {
  return String(value)
    .replace(terminalEscape, "")
    .replace(/\r\n?/gu, "\n")
    .replace(unsafeControl, " ");
}

function safeLine(value) {
  return safeText(value).replace(/\s+/gu, " ").trim();
}

function safeUtf8Slice(value, limit) {
  if (!value || limit <= 0) return "";
  if (Buffer.byteLength(value, "utf8") <= limit) return value;
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    const candidate = value.slice(0, middle);
    if (Buffer.byteLength(candidate, "utf8") <= limit) low = middle;
    else high = middle - 1;
  }
  let result = value.slice(0, low);
  const tail = result.charCodeAt(result.length - 1);
  if (Number.isFinite(tail) && tail >= 0xd800 && tail <= 0xdbff) result = result.slice(0, -1);
  return result;
}

export function trimToBytes(value, limit, suffix = entryTruncatedSuffix) {
  const text = String(value ?? "");
  const boundedLimit = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
  if (boundedLimit === 0) return "";
  if (Buffer.byteLength(text, "utf8") <= boundedLimit) return text;

  const marker = String(suffix ?? "");
  const markerBytes = Buffer.byteLength(marker, "utf8");
  if (markerBytes >= boundedLimit) return safeUtf8Slice(marker, boundedLimit);

  const prefix = safeUtf8Slice(text, boundedLimit - markerBytes);
  const output = `${prefix}${marker}`;
  if (Buffer.byteLength(output, "utf8") <= boundedLimit) return output;
  return safeUtf8Slice(output, boundedLimit);
}

function plainText(parts) {
  if (!Array.isArray(parts)) return "";
  const lines = [];
  for (const part of parts) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") lines.push(part.text);
    if (part.type === "thinking" && typeof part.thinking === "string") lines.push(part.thinking);
    if (part.type === "image") lines.push(`[image ${safeLine(part.mimeType ?? "unknown")}]`);
  }
  return lines.join("\n");
}

function freshSanitizeState() {
  return { nodes: 0 };
}

function sanitizeValue(value, state = freshSanitizeState(), depth = 0, seen = new WeakSet()) {
  if (depth > 20) return "[max depth reached]";
  if (state.nodes >= maxSanitizeNodes) return "[… omitted for safety budget …]";
  state.nodes += 1;

  if (value === undefined) return undefined;
  if (typeof value === "string")
    return trimToBytes(safeText(value), maxStringBytes, valueTruncatedSuffix);
  if (typeof value === "number" || typeof value === "boolean" || value === null) return value;
  if (Array.isArray(value)) {
    const count = Math.min(value.length, maxArrayEntries);
    const output = [];
    for (let index = 0; index < count; index += 1)
      output.push(sanitizeValue(value[index], state, depth + 1, seen));
    if (value.length > count)
      output.push(`[… ${value.length - count} more items omitted for safety …]`);
    return output;
  }
  if (value && typeof value === "object") {
    if (seen.has(value)) return "[circular]";
    seen.add(value);
    const output = {};
    const entries = Object.entries(value);
    const count = Math.min(entries.length, maxObjectEntries);
    for (let index = 0; index < count; index += 1) {
      const [rawKey, rawValue] = entries[index] ?? ["field", undefined];
      const key = safeLine(rawKey) || `field-${index + 1}`;
      output[key] = sanitizeValue(rawValue, state, depth + 1, seen);
    }
    if (entries.length > count)
      output["…"] = `[… ${entries.length - count} more fields omitted for safety …]`;
    return output;
  }
  return safeText(String(value));
}

function paneWidth() {
  const columns = Number(process.stdout.columns);
  return Math.max(40, Math.min(Number.isFinite(columns) ? columns : 100, 240));
}

function componentLines(component) {
  const lines = component.render(paneWidth()).map((line) => line.replace(osc133, ""));
  if (lines.length <= maxRenderedLines) return lines;
  return [...lines.slice(0, maxRenderedLines - 1), "[… output truncated …]"];
}

function componentText(component) {
  const block = componentLines(component).join("\n").trimEnd();
  return block ? trimToBytes(block, maxEntryBytes) : "";
}

function sanitizeAssistantContent(content) {
  if (typeof content === "string") {
    const text = trimToBytes(safeText(content), maxStringBytes, valueTruncatedSuffix);
    return text ? [{ type: "text", text }] : [];
  }
  if (!Array.isArray(content)) return [];

  const sanitized = [];
  const count = Math.min(content.length, maxContentParts);
  for (let index = 0; index < count; index += 1) {
    const part = content[index];
    if (!part || typeof part !== "object") continue;

    if (part.type === "text" && typeof part.text === "string") {
      const text = trimToBytes(safeText(part.text), maxStringBytes, valueTruncatedSuffix);
      if (text.trim()) sanitized.push({ type: "text", text });
      continue;
    }
    if (part.type === "thinking" && typeof part.thinking === "string") {
      const thinking = trimToBytes(safeText(part.thinking), maxStringBytes, valueTruncatedSuffix);
      if (thinking.trim()) sanitized.push({ type: "thinking", thinking });
      continue;
    }
    if (part.type === "toolCall") {
      const id = safeLine(part.id);
      const name = safeLine(part.name ?? "unknown");
      if (!id) continue;
      const args = sanitizeValue(part.arguments ?? {}, freshSanitizeState());
      if (pendingToolCalls.size >= TOOL_CACHE_LIMIT) {
        const first = pendingToolCalls.keys().next().value;
        if (first) pendingToolCalls.delete(first);
      }
      pendingToolCalls.set(id, { id, name, arguments: args });
      sanitized.push({ type: "toolCall", id, name, arguments: args });
    }
  }

  if (content.length > count) {
    sanitized.push({
      type: "text",
      text: `[… ${content.length - count} more content parts omitted for safety …]`,
    });
  }
  return sanitized;
}

function sanitizeToolResultContent(content) {
  if (!Array.isArray(content)) return [];
  const blocks = [];
  const count = Math.min(content.length, maxContentParts);
  for (let index = 0; index < count; index += 1) {
    const part = content[index];
    if (!part || typeof part !== "object") continue;
    if (part.type === "text" && typeof part.text === "string") {
      blocks.push({
        type: "text",
        text: trimToBytes(safeText(part.text), maxStringBytes, valueTruncatedSuffix),
      });
      continue;
    }
    if (part.type === "image") {
      blocks.push({
        type: "text",
        text: `[image ${safeLine(part.mimeType ?? "unknown")}]`,
      });
    }
  }
  if (content.length > count) {
    blocks.push({
      type: "text",
      text: `[… ${content.length - count} more content parts omitted for safety …]`,
    });
  }
  return blocks;
}

function userText(content) {
  if (typeof content === "string")
    return trimToBytes(safeText(content), maxStringBytes, valueTruncatedSuffix);
  return trimToBytes(
    plainText(sanitizeToolResultContent(content)),
    maxStringBytes,
    valueTruncatedSuffix,
  );
}

function roleHeader(stamp, role) {
  const safeStamp = safeLine(stamp || "--:--:--") || "--:--:--";
  const safeRole = safeLine(role || "event") || "event";
  return `\n\x1b[1m${safeStamp} ${safeRole}\x1b[0m\n`;
}

function writeSection(stamp, role, body) {
  const text = trimToBytes(String(body ?? "").trim(), maxEntryBytes);
  if (!safeLine(text)) return;
  process.stdout.write(`${roleHeader(stamp, role)}${text}\n`);
}

function renderAssistant(stamp, message) {
  const content = sanitizeAssistantContent(message?.content);
  const stopReason =
    typeof message?.stopReason === "string" &&
    ["pending", "stop", "length", "toolUse", "error", "aborted", "deferred"].includes(
      message.stopReason,
    )
      ? message.stopReason
      : "stop";
  const assistant = {
    role: "assistant",
    content,
    stopReason,
    ...(typeof message?.errorMessage === "string"
      ? {
          errorMessage: trimToBytes(
            safeText(message.errorMessage),
            maxStringBytes,
            valueTruncatedSuffix,
          ),
        }
      : {}),
  };
  const component = new AssistantMessageComponent(assistant, false, markdownTheme);
  const body = componentText(component);
  if (body) writeSection(stamp, "assistant", body);
}

function renderUser(stamp, message) {
  const text = userText(message?.content);
  if (!safeLine(text)) return;
  const component = new UserMessageComponent(text, markdownTheme);
  const body = componentText(component);
  if (body) writeSection(stamp, "user", body);
}

function renderToolFallback(stamp, message, call) {
  const toolName = safeLine(message?.toolName ?? call?.name ?? "unknown");
  const resultText = plainText(sanitizeToolResultContent(message?.content));
  const body = trimToBytes(
    [toolName + (message?.isError ? " · error" : ""), resultText ? `output:\n${resultText}` : ""]
      .filter(Boolean)
      .join("\n\n"),
    maxEntryBytes,
  );
  if (body) writeSection(stamp, "tool", body);
}

function renderToolResult(stamp, message) {
  const toolCallId = safeLine(message?.toolCallId);
  const call = toolCallId ? pendingToolCalls.get(toolCallId) : undefined;
  if (toolCallId) pendingToolCalls.delete(toolCallId);

  const name = safeLine(message?.toolName ?? call?.name ?? "unknown");
  const args = call?.arguments ?? {};
  const details =
    message?.details === undefined
      ? undefined
      : sanitizeValue(message.details, freshSanitizeState());
  const result = {
    content: sanitizeToolResultContent(message?.content),
    details,
    isError: Boolean(message?.isError),
  };

  if (call) {
    const component = new ToolExecutionComponent(
      name,
      call.id,
      args,
      { showImages: false, imageWidthCells: Math.max(24, Math.floor(paneWidth() * 0.75)) },
      undefined,
      TOOL_UI,
      inspectorCwd,
    );
    component.markExecutionStarted();
    component.setArgsComplete();
    component.updateResult(result, false);
    // The Herdr mirror is display-only, so render Pi's expanded card once instead of hiding
    // result output behind an unavailable interactive expand shortcut.
    component.setExpanded(true);
    const body = componentText(component);
    if (body) {
      writeSection(stamp, "tool", body);
      return;
    }
  }
  renderToolFallback(stamp, message, call);
}

function render(line) {
  if (Buffer.byteLength(line, "utf8") > maxJsonLineBytes) {
    writeSection(
      "",
      "event",
      `[entry skipped: ${Buffer.byteLength(line, "utf8")} bytes exceeds ${maxJsonLineBytes} byte safety limit]`,
    );
    return;
  }

  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    return;
  }
  if (entry?.type !== "message" || !entry.message || typeof entry.message !== "object") return;

  const stamp =
    typeof entry.timestamp === "string"
      ? trimToBytes(safeLine(entry.timestamp.slice(11, 19)), 32)
      : "";
  const message = entry.message;
  const role = safeLine(typeof message.role === "string" ? message.role : "event") || "event";

  if (role === "assistant") {
    renderAssistant(stamp, message);
    return;
  }
  if (role === "user") {
    renderUser(stamp, message);
    return;
  }
  if (role === "toolResult") {
    renderToolResult(stamp, message);
    return;
  }

  const fallback = trimToBytes(
    safeText(JSON.stringify(sanitizeValue(message, freshSanitizeState()), null, 2)),
    maxEntryBytes,
  );
  if (fallback) writeSection(stamp, role, fallback);
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

async function main() {
  if (!sessionFile) {
    process.stderr.write(
      "Usage: inspector-runner.mjs <session.jsonl> [maxOutputBytes] [cwd] [theme]\n",
    );
    process.exit(2);
  }

  try {
    initTheme(requestedTheme, false);
  } catch {
    initTheme(defaultTheme, false);
  }
  markdownTheme = getMarkdownTheme();

  process.stdout.write(
    `\x1b[2J\x1b[H\x1b[1mHackler transcript · ${safeLine(basename(sessionFile))}\x1b[0m\n`,
  );
  process.stdout.write(
    `Display-only mirror · follow mode · requested theme ${safeLine(requestedTheme)} · cwd ${safeLine(inspectorCwd)}\n`,
  );

  await readMore();
  const timer = setInterval(readMore, 350);

  const stop = () => {
    stopped = true;
    clearInterval(timer);
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

const isMain = process.argv[1] ? pathToFileURL(process.argv[1]).href === import.meta.url : false;
if (isMain) await main();
