export interface ProposedPlanParseResult {
  plan?: string;
  error?: "empty" | "multiple" | "unterminated";
}

const openingTag = "<proposed_plan>";
const closingTag = "</proposed_plan>";
const completePlan = /<proposed_plan>\s*([\s\S]*?)\s*<\/proposed_plan>/gi;

/** Accept exactly one non-empty proposed-plan block and preserve its Markdown unchanged. */
export function extractProposedPlan(text: string): ProposedPlanParseResult {
  const matches = [...text.matchAll(completePlan)];
  const normalized = text.toLowerCase();
  const openingCount = normalized.split(openingTag).length - 1;
  const closingCount = normalized.split(closingTag).length - 1;
  if (matches.length > 1 || openingCount > 1 || closingCount > 1) return { error: "multiple" };
  if (matches.length === 0) {
    return openingCount > 0 || closingCount > 0 ? { error: "unterminated" } : {};
  }
  if (openingCount !== 1 || closingCount !== 1) return { error: "unterminated" };
  const plan = matches[0]?.[1]?.trim() ?? "";
  return plan ? { plan } : { error: "empty" };
}
