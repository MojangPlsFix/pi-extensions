export interface ProposedPlanParseResult {
  plan?: string;
  error?: "empty" | "multiple" | "unterminated";
}

const standaloneOpening = /^\s*<proposed_plan>\s*$/iu;
const standaloneClosing = /^\s*<\/proposed_plan>\s*$/iu;
const fence = /^\s*(```+|~~~+)(?:[A-Za-z0-9_-]+|\s.*)?$/u;

/**
 * Accept exactly one non-empty proposed-plan block.
 *
 * Proposal markers are deliberately structural: they must occupy their own line and cannot be
 * inside a fenced code example. Inline documentation and examples therefore remain ordinary
 * assistant prose rather than accidentally becoming executable plans.
 */
export function extractProposedPlan(text: string): ProposedPlanParseResult {
  const lines = text.split("\n");
  let fenced = false;
  let openingLine = -1;
  let closingLine = -1;
  let openings = 0;
  let closings = 0;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const fenceMatch = fence.exec(line);
    if (fenceMatch) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (standaloneOpening.test(line)) {
      openings += 1;
      openingLine = openingLine < 0 ? index : openingLine;
    }
    if (standaloneClosing.test(line)) {
      closings += 1;
      closingLine = closingLine < 0 ? index : closingLine;
    }
  }

  if (openings > 1 || closings > 1) return { error: "multiple" };
  if (openings === 0 && closings === 0) return {};
  if (openings !== 1 || closings !== 1 || openingLine >= closingLine)
    return { error: "unterminated" };

  const plan = lines
    .slice(openingLine + 1, closingLine)
    .join("\n")
    .trim();
  return plan ? { plan } : { error: "empty" };
}
