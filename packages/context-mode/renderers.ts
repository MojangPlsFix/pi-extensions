import {
  type AgentToolResult,
  keyHint,
  type Theme,
  type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { cleanSingleLine } from "../web-search/search.js";
import type { ContextDetails, ContextToolParams } from "./types.js";

function expandHint(): string {
  try {
    return keyHint("app.tools.expand", "to expand");
  } catch {
    return "Ctrl+O to expand";
  }
}

function cleanExpanded(value: string): string {
  return value
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)?)/gu, "")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, " ");
}

function expandableHint(details: ContextDetails | undefined, rawText: string): string {
  return details?.inputEcho || rawText.trim() ? ` · (${expandHint()})` : "";
}

function inputBlock(details: ContextDetails | undefined, theme: Theme): string {
  const input = details?.inputEcho?.trim();
  return input
    ? `\n\n${theme.fg("dim", "Input:")}\n${theme.fg("toolOutput", cleanExpanded(input))}`
    : "";
}

function callPreview(toolName: string, args: ContextToolParams): string {
  if (toolName === "ctx_execute" || toolName === "ctx_execute_file") {
    const language = typeof args.language === "string" ? args.language : "waiting";
    const path = typeof args.path === "string" ? ` · ${args.path}` : "";
    const code = typeof args.code === "string" ? cleanSingleLine(args.code, 80) : "";
    return `${language}${path}${code ? ` · ${code}` : ""}`;
  }
  if (toolName === "ctx_batch_execute") {
    const count = Array.isArray(args.commands) ? args.commands.length : 0;
    const concurrency = typeof args.concurrency === "number" ? args.concurrency : 1;
    return `${count} command${count === 1 ? "" : "s"} · concurrency ${concurrency}`;
  }
  if (toolName === "ctx_search") {
    const query = Array.isArray(args.queries) ? args.queries[0] : undefined;
    return typeof query === "string" ? cleanSingleLine(query, 100) : "indexed content";
  }
  if (toolName === "ctx_index") {
    const source = typeof args.source === "string" ? args.source : args.path;
    return typeof source === "string" ? cleanSingleLine(source, 100) : "content";
  }
  if (toolName === "ctx_fetch_and_index") {
    const target = typeof args.url === "string" ? args.url : "external source";
    return cleanSingleLine(target, 100);
  }
  return "";
}

export function renderContextCall(
  args: ContextToolParams,
  theme: Theme,
  toolName = "context-mode",
) {
  const preview = callPreview(toolName, args);
  return new Text(
    `${theme.fg("toolTitle", theme.bold(`${toolName} `))}${theme.fg("dim", preview)}`.trimEnd(),
    0,
    0,
  );
}

export function createContextCallRenderer(toolName: string) {
  return (args: ContextToolParams, theme: Theme) => renderContextCall(args, theme, toolName);
}

function renderResult(
  toolName: string,
  result: AgentToolResult<ContextDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context?: { isError?: boolean },
) {
  const rawText = result.content.find((item) => item.type === "text")?.text ?? "";
  if (options.isPartial) {
    const status = theme.fg("warning", cleanSingleLine(rawText || `${toolName} running…`, 240));
    const hint = expandableHint(result.details, rawText);
    if (options.expanded) return new Text(`${status}${inputBlock(result.details, theme)}`, 0, 0);
    return new Text(`${status}${theme.fg("dim", hint)}`, 0, 0);
  }
  if (result.details?.status === "cancelled" || /cancelled/iu.test(rawText)) {
    const status = theme.fg(
      "warning",
      `Cancelled ${toolName}${rawText ? ` · ${cleanSingleLine(rawText, 160)}` : ""}`,
    );
    if (options.expanded) return new Text(`${status}${inputBlock(result.details, theme)}`, 0, 0);
    return new Text(`${status}${theme.fg("dim", expandableHint(result.details, rawText))}`, 0, 0);
  }
  if (context?.isError) {
    const message = rawText || `${toolName} failed.`;
    if (options.expanded)
      return new Text(
        `${theme.fg("error", cleanExpanded(message))}${inputBlock(result.details, theme)}`,
        0,
        0,
      );
    return new Text(
      `${theme.fg("error", cleanSingleLine(message, 240))}${theme.fg("dim", expandableHint(result.details, rawText))}`,
      0,
      0,
    );
  }
  if (options.expanded) {
    const cancellation =
      result.details?.cancellation === "best-effort-external"
        ? `\n\n${theme.fg("dim", "External MCP cancellation is best-effort; the server may finish after this call.")}`
        : "";
    return new Text(
      `${theme.fg("toolOutput", cleanExpanded(rawText || `${toolName} completed.`))}${cancellation}`,
      0,
      0,
    );
  }
  const details = result.details;
  if (!details)
    return new Text(
      `${theme.fg("muted", cleanSingleLine(rawText || `${toolName} completed.`, 240))}${theme.fg("dim", expandableHint(details, rawText))}`,
      0,
      0,
    );
  let text = theme.fg("success", "✓ ");
  text += theme.fg("muted", toolName);
  if (details.elapsedMs !== undefined)
    text += theme.fg("dim", ` · ${Math.max(0, details.elapsedMs / 1000).toFixed(1)}s`);
  if (details.completedCommands !== undefined && details.totalCommands !== undefined)
    text += theme.fg("dim", ` · ${details.completedCommands}/${details.totalCommands} commands`);
  if (details.outputBytes !== undefined)
    text += theme.fg(
      "dim",
      ` · ${details.outputBytes} bytes${details.truncated ? " · truncated" : ""}`,
    );
  text += theme.fg("dim", expandableHint(details, rawText));
  return new Text(text, 0, 0);
}

export function renderContextResult(
  result: AgentToolResult<ContextDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context?: { isError?: boolean },
) {
  return renderResult(result.details?.toolName ?? "context-mode", result, options, theme, context);
}

export function createContextResultRenderer(toolName: string) {
  return (
    result: AgentToolResult<ContextDetails | undefined>,
    options: ToolRenderResultOptions,
    theme: Theme,
    context?: { isError?: boolean },
  ) => renderResult(toolName, result, options, theme, context);
}
