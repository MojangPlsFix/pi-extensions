import type {
  AgentToolResult,
  Theme,
  ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  cleanSingleLine,
  type SearchBackend,
  type SearchDetails,
  type SearchParams,
} from "./search.js";

function backendLabel(backend: SearchBackend): string {
  return backend === "copilot-cli" ? "Copilot CLI" : "Codex native";
}

export function renderSearchCall(args: SearchParams, theme: Theme) {
  const kind = args.kind === "code" ? "code" : "web";
  const query =
    [args.prompt, args.query, ...(Array.isArray(args.queries) ? args.queries : [])].find(
      (value): value is string => typeof value === "string" && value.trim().length > 0,
    ) ?? "waiting for query";
  let text = theme.fg("toolTitle", theme.bold("search "));
  text += theme.fg("accent", kind);
  text += theme.fg("dim", ` · ${cleanSingleLine(query, 100)}`);
  return new Text(text, 0, 0);
}

export function renderSearchResult(
  result: AgentToolResult<SearchDetails | undefined>,
  options: ToolRenderResultOptions,
  theme: Theme,
  context?: { isError?: boolean },
) {
  const rawText = result.content.find((item) => item.type === "text")?.text ?? "";
  if (options.isPartial)
    return new Text(theme.fg("warning", cleanSingleLine(rawText || "Searching…", 200)), 0, 0);
  if (context?.isError) {
    const error = cleanSingleLine(rawText || "Search failed.", 240);
    return new Text(theme.fg("error", error), 0, 0);
  }
  const details = result.details;
  if (!details)
    return new Text(theme.fg("muted", cleanSingleLine(rawText || "Search completed.", 240)), 0, 0);
  let text = theme.fg("success", "✓ ");
  text += theme.fg("muted", `${backendLabel(details.backend)} ${details.kind} search`);
  text += theme.fg(
    "dim",
    ` · ${details.sourceCount} source${details.sourceCount === 1 ? "" : "s"}${
      details.truncated ? " · truncated" : ""
    } · provider-accounted`,
  );
  if (options.expanded) {
    if (details.sourceUrls.length) {
      text += theme.fg("muted", "\nSources:");
      for (const url of details.sourceUrls)
        text += `\n${theme.fg("dim", `  ${cleanSingleLine(url, 300)}`)}`;
      if (details.sourcesTruncated || details.sourceCount > details.sourceUrls.length)
        text += `\n${theme.fg("warning", "  … more sources omitted")}`;
    }
    if (details.preview) text += `\n${theme.fg("dim", `Preview: ${details.preview}`)}`;
    text += `\n${theme.fg("dim", "Usage/cost is accounted by the provider and omitted from Pi totals.")}`;
  }
  return new Text(text, 0, 0);
}
