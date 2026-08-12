import {
  type AgentToolUpdateCallback,
  type ExtensionAPI,
  keyHint,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
  type RepositoryReference,
  type RepositoryReferenceCloneDetails,
  type RepositoryReferenceDetails,
  RepositoryReferenceParams,
  type RepositoryReferenceProgress,
  redactRemote,
  sanitizeGitOutput,
  validateRemote,
  validateRevision,
} from "./model.js";
import {
  cleanupRepositoryReferences,
  cloneRepositoryReference,
  listRepositoryReferences,
  removeRepositoryReference,
} from "./store.js";

type RepositoryReferenceUpdate = AgentToolUpdateCallback<RepositoryReferenceDetails>;

type RepositoryReferenceRenderArgs = {
  action?: string;
  remote?: string;
  revision?: string;
};

function result(text: string, details: RepositoryReferenceDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

function displayReference(reference: RepositoryReference): RepositoryReference {
  return { ...reference, remote: redactRemote(reference.remote) };
}

function textContent(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((item) => item.type === "text" || item.type === undefined)
    .map((item) => item.text ?? "")
    .join("\n")
    .trim();
}

function appendProgress(progressLines: string[], progress: RepositoryReferenceProgress): string[] {
  const message = sanitizeGitOutput(progress.message).trim();
  if (!message) return progressLines;
  const next = [...progressLines, message];
  return next.slice(-24);
}

function publishProgress(
  onUpdate: RepositoryReferenceUpdate | undefined,
  progressLines: string[],
  progress: RepositoryReferenceProgress,
): string[] {
  const nextProgress = appendProgress(progressLines, progress);
  const status = progress.message.split("\n", 1)[0]?.trim() || progress.message;
  onUpdate?.({
    content: [{ type: "text", text: status }],
    details: {
      action: "clone",
      phase: progress.phase,
      status,
      progress: nextProgress,
      diagnostics: progress.diagnostics,
    },
  });
  return nextProgress;
}

function renderCall(args: RepositoryReferenceRenderArgs, theme: Theme) {
  let text = theme.fg("toolTitle", theme.bold("repository_reference"));
  if (args.action) text += theme.fg("accent", ` ${args.action}`);
  if (args.revision) text += theme.fg("muted", ` ${args.revision}`);
  if (args.remote) text += theme.fg("dim", ` ${redactRemote(args.remote)}`);
  return new Text(text, 0, 0);
}

function renderCloneResult(
  details: RepositoryReferenceCloneDetails | undefined,
  content: string,
  expanded: boolean,
  isPartial: boolean,
  isError: boolean,
  theme: Theme,
): string {
  const progress = details?.progress ?? [];
  const firstContentLine = content.split("\n", 1)[0] ?? "";
  let summary =
    details?.status ?? (firstContentLine || "Repository reference operation in progress");

  if (details?.reference && !isError && !isPartial) {
    summary = `Created ${details.reference.id} at ${details.reference.resolvedRevision}`;
  } else if (isError) {
    summary = `Error: ${firstContentLine || details?.error || "repository reference clone failed"}`;
  }

  let rendered = isError
    ? theme.fg("error", summary)
    : theme.fg(isPartial ? "warning" : "success", summary);
  if (expanded) {
    const history = progress.slice(-12);
    if (history.length > 0)
      rendered += `\n${history.map((line) => theme.fg("dim", line)).join("\n")}`;
    if (details?.diagnostics?.attemptedRefs?.length) {
      rendered += `\n${theme.fg("muted", `Attempted refs: ${details.diagnostics.attemptedRefs.join(", ")}`)}`;
    }
    if (details?.diagnostics?.stderr) {
      rendered += `\n${theme.fg("dim", details.diagnostics.stderr)}`;
    }
    if (details?.reference) {
      rendered += `\n${theme.fg("muted", `Path: ${details.reference.path}`)}`;
    }
  } else if (progress.length > 1 || details?.diagnostics) {
    rendered += theme.fg("muted", ` (${keyHint("app.tools.expand", "to expand")})`);
  }
  return rendered;
}

function renderResult(
  resultValue: { content: Array<{ type?: string; text?: string }>; details?: unknown },
  options: { expanded: boolean; isPartial: boolean },
  theme: Theme,
  context: { isError: boolean },
) {
  const content = textContent(resultValue.content);
  const details = resultValue.details as RepositoryReferenceDetails | undefined;
  if (details?.action === "clone") {
    return new Text(
      renderCloneResult(
        details,
        content,
        options.expanded,
        options.isPartial,
        context.isError,
        theme,
      ),
      0,
      0,
    );
  }

  const lines = content.split("\n").filter(Boolean);
  const visibleLines = options.expanded ? lines : lines.slice(0, 12);
  let rendered = visibleLines.join("\n");
  if (context.isError)
    rendered = theme.fg("error", rendered || "Repository reference operation failed");
  if (!options.expanded && lines.length > visibleLines.length) {
    rendered += `\n${theme.fg("muted", `… ${keyHint("app.tools.expand", "to expand")}`)}`;
  }
  return new Text(rendered, 0, 0);
}

export default function repositoryReferenceExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "repository_reference",
    label: "Repository reference",
    description:
      "Safely clone a validated network Git remote at a validated revision into a managed temporary directory, then list, remove, or clean up only references created by this tool. Clone progress is streamed in the tool row; set verbose=true for more sanitized diagnostics. Use Ctrl+O to expand tool output. It does not use a shell or require Context Mode.",
    parameters: RepositoryReferenceParams,
    async execute(_toolCallId, params, signal, onUpdate) {
      switch (params.action) {
        case "clone": {
          const remoteResult = validateRemote(params.remote);
          if ("error" in remoteResult) throw new Error(remoteResult.error);
          const revisionResult = validateRevision(params.revision);
          if ("error" in revisionResult) throw new Error(revisionResult.error);
          const progressUpdate = onUpdate as RepositoryReferenceUpdate | undefined;
          let progressLines: string[] = [];
          const reference = await cloneRepositoryReference(
            remoteResult.remote,
            revisionResult.revision,
            {
              signal,
              verbose: params.verbose,
              onProgress: (progress) => {
                progressLines = publishProgress(progressUpdate, progressLines, progress);
              },
            },
          );
          const safeReference = displayReference(reference);
          return result(
            `Created repository reference ${safeReference.id}\nRemote: ${safeReference.remote}\nRevision: ${safeReference.revision}\nResolved revision: ${safeReference.resolvedRevision}\nPath: ${safeReference.path}`,
            {
              action: "clone",
              phase: "metadata",
              progress: progressLines,
              reference: safeReference,
            },
          );
        }
        case "list": {
          const references = (await listRepositoryReferences()).map(displayReference);
          return result(
            references.length
              ? references
                  .map(
                    (reference) =>
                      `${reference.id}\t${reference.resolvedRevision}\t${reference.path}\t${reference.remote}`,
                  )
                  .join("\n")
              : "No managed repository references.",
            { action: "list", references },
          );
        }
        case "remove": {
          await removeRepositoryReference(params.id);
          return result(`Removed repository reference ${params.id}.`, {
            action: "remove",
            id: params.id ?? "",
          });
        }
        case "cleanup": {
          const references = (await cleanupRepositoryReferences()).map(displayReference);
          return result(
            references.length
              ? `Removed ${references.length} managed repository reference(s).`
              : "No managed repository references needed cleanup.",
            { action: "cleanup", references },
          );
        }
      }
    },
    renderCall,
    renderResult,
  });
}
