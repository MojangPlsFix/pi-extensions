import { extractProposedPlan } from "./plan-parser.js";
import type { PlanRevisionExpectation } from "./state.js";

export type RevisionBranchEntry = {
  type: string;
  id: string;
  message?: { role?: string; content?: unknown };
};

export type RevisionEvaluation =
  | { kind: "pending" }
  | { kind: "valid"; entryId: string; plan: string; lastCheckedAssistantEntryId: string }
  | {
      kind: "invalid";
      failure: "missing" | "empty" | "multiple" | "unterminated";
      lastCheckedAssistantEntryId?: string;
    };

export function revisionAssistantText(entry: RevisionBranchEntry): string | undefined {
  if (
    entry.type !== "message" ||
    entry.message?.role !== "assistant" ||
    !Array.isArray(entry.message.content)
  )
    return undefined;
  const text = entry.message.content
    .filter((block): block is { type: "text"; text: string } =>
      Boolean(
        block &&
          typeof block === "object" &&
          (block as { type?: unknown }).type === "text" &&
          typeof (block as { text?: unknown }).text === "string",
      ),
    )
    .map((block) => block.text)
    .join("\n");
  return text || undefined;
}

/**
 * Evaluate the complete assistant response bounded by a coordinator delivery and settlement.
 * Marker-free acknowledgements do not hide a proposal, while the newest proposal-bearing response
 * wins even when malformed.
 */
export function evaluatePlanRevision(
  expectation: PlanRevisionExpectation,
  branch: readonly RevisionBranchEntry[],
): RevisionEvaluation {
  const { deliveryEntryId, settledEntryId } = expectation.responseBoundary;
  if (!deliveryEntryId || !settledEntryId) return { kind: "pending" };
  const deliveryIndex = branch.findIndex((entry) => entry.id === deliveryEntryId);
  const settledIndex = branch.findIndex((entry) => entry.id === settledEntryId);
  if (deliveryIndex < 0 || settledIndex <= deliveryIndex) return { kind: "pending" };

  const responses = branch
    .slice(deliveryIndex + 1, settledIndex + 1)
    .map((entry) => ({ entryId: entry.id, text: revisionAssistantText(entry) }))
    .filter((response): response is { entryId: string; text: string } => Boolean(response.text));
  const lastCheckedAssistantEntryId = responses.at(-1)?.entryId;
  for (let index = responses.length - 1; index >= 0; index -= 1) {
    const response = responses[index]!;
    const parsed = extractProposedPlan(response.text);
    if (parsed.plan)
      return {
        kind: "valid",
        entryId: response.entryId,
        plan: parsed.plan,
        lastCheckedAssistantEntryId: lastCheckedAssistantEntryId ?? response.entryId,
      };
    if (parsed.error)
      return {
        kind: "invalid",
        failure: parsed.error,
        ...(lastCheckedAssistantEntryId ? { lastCheckedAssistantEntryId } : {}),
      };
  }
  return {
    kind: "invalid",
    failure: "missing",
    ...(lastCheckedAssistantEntryId ? { lastCheckedAssistantEntryId } : {}),
  };
}
