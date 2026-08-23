import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const FINALIZATION_STATE_ENTRY = "workflow-finalization:implementation-wave";
export const FINALIZATION_PRODUCER_ID = "workflow-finalization:implementation-summary:v1";

export const IMPLEMENTATION_SUMMARY_HEADINGS = [
  "Outcome",
  "Changes",
  "Validation",
  "Review status",
  "Risks and blockers",
] as const;

export type ImplementationSummaryHeading = (typeof IMPLEMENTATION_SUMMARY_HEADINGS)[number];

export type ParsedImplementationSummary = {
  ok: true;
  sections: Record<ImplementationSummaryHeading, string>;
};

export type InvalidImplementationSummary = { ok: false; errors: string[] };

export type ImplementationWaveState = {
  version: 1;
  wave: number;
  armed: boolean;
  anchorEntryId: string | null;
  processedAssistantEntryIds: string[];
  retryQueued: boolean;
  warned: boolean;
  correctionRequestId?: string;
  lastCheckedAssistantEntryId?: string;
  lastParseFailure?: string[];
  completedByEntryId?: string;
  advanceReason?: string;
};

export type FinalizationTransition = {
  state: ImplementationWaveState;
  action: "none" | "queue-correction" | "warn" | "complete";
  entryId?: string;
  errors?: string[];
};

export const IMPLEMENTATION_SUMMARY_CONTRACT = [
  "Implementation finalization contract (required while this implementation wave is armed):",
  "Before ending, return exactly one implementation summary with these unfenced Markdown headings in order, each with non-empty content:",
  ...IMPLEMENTATION_SUMMARY_HEADINGS.map((heading) => `## ${heading}`),
  "Report honestly; do not claim validation or review that did not happen.",
].join("\n");

export const IMPLEMENTATION_SUMMARY_CORRECTION = [
  "Your implementation summary is missing or invalid. Make no more repository changes.",
  "Return only a corrected summary using these unfenced headings in this exact order, each with non-empty content:",
  ...IMPLEMENTATION_SUMMARY_HEADINGS.map((heading) => `## ${heading}`),
].join("\n");

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

export function createImplementationWaveState(): ImplementationWaveState {
  return {
    version: 1,
    wave: 0,
    armed: false,
    anchorEntryId: null,
    processedAssistantEntryIds: [],
    retryQueued: false,
    warned: false,
  };
}

export function parseImplementationWaveState(value: unknown): ImplementationWaveState | undefined {
  if (
    !record(value) ||
    value.version !== 1 ||
    !Number.isSafeInteger(value.wave) ||
    typeof value.armed !== "boolean" ||
    !(value.anchorEntryId === null || typeof value.anchorEntryId === "string") ||
    !Array.isArray(value.processedAssistantEntryIds) ||
    !value.processedAssistantEntryIds.every((id) => typeof id === "string") ||
    typeof value.retryQueued !== "boolean" ||
    typeof value.warned !== "boolean"
  )
    return undefined;
  return {
    version: 1,
    wave: value.wave as number,
    armed: value.armed,
    anchorEntryId: value.anchorEntryId,
    processedAssistantEntryIds: [...(value.processedAssistantEntryIds as string[])],
    retryQueued: value.retryQueued,
    warned: value.warned,
    ...(typeof value.correctionRequestId === "string"
      ? { correctionRequestId: value.correctionRequestId }
      : {}),
    ...(typeof value.lastCheckedAssistantEntryId === "string"
      ? { lastCheckedAssistantEntryId: value.lastCheckedAssistantEntryId }
      : {}),
    ...(Array.isArray(value.lastParseFailure) &&
    value.lastParseFailure.every((failure) => typeof failure === "string")
      ? { lastParseFailure: [...(value.lastParseFailure as string[])] }
      : {}),
    ...(typeof value.completedByEntryId === "string"
      ? { completedByEntryId: value.completedByEntryId }
      : {}),
    ...(typeof value.advanceReason === "string" ? { advanceReason: value.advanceReason } : {}),
  };
}

export function advanceImplementationWave(
  state: ImplementationWaveState,
  anchorEntryId: string | null,
  reason: string,
): ImplementationWaveState {
  return {
    version: 1,
    wave: state.wave + 1,
    armed: true,
    anchorEntryId,
    processedAssistantEntryIds: [],
    retryQueued: false,
    warned: false,
    advanceReason: reason,
  };
}

/** Parse exact level-two headings while ignoring headings and content inside Markdown fences. */
export function parseImplementationSummary(
  markdown: string,
): ParsedImplementationSummary | InvalidImplementationSummary {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: Array<{ name: ImplementationSummaryHeading; line: number }> = [];
  const fencedLines = new Set<number>();
  let fence: { marker: "`" | "~"; length: number } | undefined;
  for (const [line, text] of lines.entries()) {
    const fenceMatch = /^\s{0,3}(`{3,}|~{3,})(?:\s*.*)?$/.exec(text);
    if (fenceMatch) {
      const sequence = fenceMatch[1] ?? "";
      const marker = sequence[0];
      if (!fence && (marker === "`" || marker === "~")) {
        fence = { marker, length: sequence.length };
        fencedLines.add(line);
        continue;
      }
      if (fence && marker === fence.marker && sequence.length >= fence.length) {
        fencedLines.add(line);
        fence = undefined;
        continue;
      }
    }
    if (fence) {
      fencedLines.add(line);
      continue;
    }
    const match = /^\s{0,3}##[ \t]+(.+?)[ \t]*#*[ \t]*$/.exec(text);
    if (!match) continue;
    const required = IMPLEMENTATION_SUMMARY_HEADINGS.find(
      (heading) => heading === match[1]?.trim(),
    );
    if (required) headings.push({ name: required, line });
  }

  const errors: string[] = [];
  for (const required of IMPLEMENTATION_SUMMARY_HEADINGS) {
    const occurrences = headings.filter((heading) => heading.name === required);
    if (occurrences.length === 0) errors.push(`missing heading: ${required}`);
    else if (occurrences.length > 1) errors.push(`duplicate heading: ${required}`);
  }
  if (errors.length === 0) {
    const actual = headings.map((heading) => heading.name);
    if (actual.some((heading, index) => heading !== IMPLEMENTATION_SUMMARY_HEADINGS[index]))
      errors.push("required headings are out of order");
  }

  const sections = {} as Record<ImplementationSummaryHeading, string>;
  if (errors.length === 0) {
    for (const [index, heading] of headings.entries()) {
      const nextLine = headings[index + 1]?.line ?? lines.length;
      const content = lines
        .slice(heading.line + 1, nextLine)
        .filter((_line, offset) => !fencedLines.has(heading.line + 1 + offset))
        .join("\n")
        .trim();
      sections[heading.name] = content;
      if (!content) errors.push(`empty section: ${heading.name}`);
    }
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, sections };
}

function assistantText(entry: SessionEntry): string | undefined {
  if (entry.type !== "message" || entry.message.role !== "assistant") return undefined;
  return entry.message.content
    .filter(
      (block): block is Extract<(typeof entry.message.content)[number], { type: "text" }> =>
        block.type === "text",
    )
    .map((block) => block.text)
    .join("\n")
    .trim();
}

export function assistantResponsesAfterAnchor(
  entries: SessionEntry[],
  anchorEntryId: string | null,
): Array<{ entryId: string; text: string }> {
  const anchorIndex = anchorEntryId ? entries.findIndex((entry) => entry.id === anchorEntryId) : -1;
  if (anchorEntryId && anchorIndex < 0) return [];
  const responses: Array<{ entryId: string; text: string }> = [];
  for (const entry of entries.slice(anchorIndex + 1)) {
    const text = assistantText(entry);
    if (text) responses.push({ entryId: entry.id, text });
  }
  return responses;
}

/** Generic one-retry/one-warning state transition; safe to call repeatedly. */
export function evaluateImplementationFinalization(
  state: ImplementationWaveState,
  responses: ReadonlyArray<{ entryId: string; text: string }>,
): FinalizationTransition {
  if (!state.armed) return { state, action: "none" };

  const valid = [...responses]
    .reverse()
    .find((response) => parseImplementationSummary(response.text).ok);
  if (valid) {
    return {
      state: {
        ...state,
        armed: false,
        completedByEntryId: valid.entryId,
        lastCheckedAssistantEntryId: responses.at(-1)?.entryId ?? valid.entryId,
        processedAssistantEntryIds: [
          ...new Set([
            ...state.processedAssistantEntryIds,
            ...responses.map(({ entryId }) => entryId),
          ]),
        ],
      },
      action: "complete",
      entryId: valid.entryId,
    };
  }

  const processed = new Set(state.processedAssistantEntryIds);
  const unprocessed = responses.filter((response) => !processed.has(response.entryId));
  const next = unprocessed.at(-1);
  if (!next) return { state, action: "none" };
  const parsed = parseImplementationSummary(next.text);
  const errors = parsed.ok ? [] : parsed.errors;
  const updated: ImplementationWaveState = {
    ...state,
    processedAssistantEntryIds: [
      ...new Set([
        ...state.processedAssistantEntryIds,
        ...unprocessed.map(({ entryId }) => entryId),
      ]),
    ],
    lastCheckedAssistantEntryId: next.entryId,
    lastParseFailure: errors,
  };
  if (!state.retryQueued) {
    return {
      state: { ...updated, retryQueued: true },
      action: "queue-correction",
      entryId: next.entryId,
      errors,
    };
  }
  if (!state.warned) {
    return {
      state: { ...updated, warned: true },
      action: "warn",
      entryId: next.entryId,
      errors,
    };
  }
  return { state: updated, action: "none" };
}

const MUTATOR_NAMES = new Set([
  "edit",
  "write",
  "apply_patch",
  "edit_file",
  "write_file",
  "create_file",
  "delete_file",
  "move_file",
  "rename_file",
  "multi_edit",
]);

export function isReviewedRepositoryMutator(toolName: string): boolean {
  return MUTATOR_NAMES.has(toolName.split(".").pop()?.toLocaleLowerCase() ?? "");
}

/** Best-effort classifier for reviewed shell patterns that are likely to change the checkout. */
export function isLikelyMutatingBash(command: string): boolean {
  const source = command.trim();
  if (!source) return false;
  if (
    /(?:^|[;&|]\s*|\b)(?:rm|mv|cp|mkdir|rmdir|touch|truncate|chmod|chown|ln|install|tee|dd|patch|apply_patch)(?:\s|$)/i.test(
      source,
    ) ||
    /\b(?:sed\s+[^\n]*(?:-i|--in-place)|perl\s+[^\n]*-p?i\b|find\b[^\n]*(?:-delete|-exec|-execdir|-ok)\b)/i.test(
      source,
    )
  )
    return true;
  // Output redirection to a real path is mutating. Descriptor duplication and
  // /dev/null-only redirection are operational rather than repository changes.
  if (/(?:^|\s)(?:\d*)>>?\s*(?![&]|\/dev\/null(?:\s|$))[^\s]+/i.test(source)) return true;
  if (
    /\bgit\s+(?:add|am|apply|bisect|branch\s+(?:-d|-D|-m|-M)|checkout|cherry-pick|clean|commit|merge|mv|rebase|reset|restore|revert|rm|stash|switch|tag\s+(?:-d|-f)|worktree\s+(?:add|move|remove|repair))\b/i.test(
      source,
    )
  )
    return true;
  if (
    /\b(?:npm|pnpm|yarn|bun)\s+(?:add|install|remove|uninstall|update|upgrade|link|unlink|dedupe|version)\b/i.test(
      source,
    ) ||
    /\b(?:pip|pipx|uv\s+pip|poetry)\s+(?:install|uninstall|add|remove|sync)\b/i.test(source)
  )
    return true;
  return /\b(?:prettier\b[^\n]*--write|eslint\b[^\n]*--fix|biome\s+(?:check|format)\b[^\n]*--write|gofmt\b[^\n]*-w|cargo\s+fmt\b|rustfmt\b)\b/i.test(
    source,
  );
}

export function shouldArmForToolResult(event: {
  toolName: string;
  input: Record<string, unknown>;
  isError: boolean;
}): boolean {
  if (event.isError) return false;
  const name = event.toolName.split(".").pop()?.toLocaleLowerCase() ?? "";
  if (isReviewedRepositoryMutator(name)) return true;
  return name === "bash" && typeof event.input.command === "string"
    ? isLikelyMutatingBash(event.input.command)
    : false;
}
