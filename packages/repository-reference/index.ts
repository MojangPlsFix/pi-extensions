import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  type RepositoryReferenceDetails,
  RepositoryReferenceParams,
  validateRemote,
  validateRevision,
} from "./model.js";
import {
  cleanupRepositoryReferences,
  cloneRepositoryReference,
  listRepositoryReferences,
  removeRepositoryReference,
} from "./store.js";

function result(text: string, details: RepositoryReferenceDetails) {
  return { content: [{ type: "text" as const, text }], details };
}

export default function repositoryReferenceExtension(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "repository_reference",
    label: "Repository reference",
    description:
      "Safely clone a validated network Git remote at a validated revision into a managed temporary directory after interactive confirmation, then list, remove, or clean up only references created by this tool. It does not use a shell or require Context Mode.",
    parameters: RepositoryReferenceParams,
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      try {
        switch (params.action) {
          case "clone": {
            const remoteResult = validateRemote(params.remote);
            if ("error" in remoteResult) throw new Error(remoteResult.error);
            const revisionResult = validateRevision(params.revision);
            if ("error" in revisionResult) throw new Error(revisionResult.error);
            if (!ctx.hasUI)
              throw new Error(
                "repository reference clone requires an interactive UI confirmation; invoke it from a session with UI available",
              );
            const confirmed = await ctx.ui.confirm(
              "Confirm repository clone",
              `Clone ${remoteResult.remote} at revision ${revisionResult.revision}? This may access the network and create a temporary checkout.`,
            );
            if (!confirmed) throw new Error("repository reference clone cancelled");
            const reference = await cloneRepositoryReference(
              remoteResult.remote,
              revisionResult.revision,
            );
            return result(
              `Created repository reference ${reference.id}\nRemote: ${reference.remote}\nRevision: ${reference.revision}\nResolved revision: ${reference.resolvedRevision}\nPath: ${reference.path}`,
              { action: "clone", reference },
            );
          }
          case "list": {
            const references = await listRepositoryReferences();
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
            const references = await cleanupRepositoryReferences();
            return result(
              references.length
                ? `Removed ${references.length} managed repository reference(s).`
                : "No managed repository references needed cleanup.",
              { action: "cleanup", references },
            );
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const action = params.action;
        if (action === "clone") return result(`Error: ${message}`, { action, error: message });
        if (action === "remove")
          return result(`Error: ${message}`, { action, id: params.id ?? "", error: message });
        return result(`Error: ${message}`, { action, references: [], error: message });
      }
    },
  });
}
