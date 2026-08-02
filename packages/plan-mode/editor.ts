import { CustomEditor, type KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { sliceByColumn, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

const label = " Plan Mode ";

export function renderPlanModeBorder(
  lines: string[],
  width: number,
  isPlanMode: boolean,
  borderColor: (text: string) => string,
): string[] {
  const rendered = [...lines];
  if (!isPlanMode || rendered.length === 0 || width < 4) return rendered;
  const renderedLabel = truncateToWidth(label, Math.max(0, width - 2), "");
  const labelWidth = visibleWidth(renderedLabel);
  if (labelWidth === 0) return rendered;
  const topBorder = rendered[0] ?? "";
  const before = sliceByColumn(topBorder, 0, 1);
  const afterStart = Math.min(width, 1 + labelWidth);
  const after = sliceByColumn(topBorder, afterStart, Math.max(0, width - afterStart));
  rendered[0] = `${before}${borderColor(renderedLabel)}${after}`;
  return rendered;
}

/** Preserves Pi's concrete editor and its inherited keybinding behavior. */
export class PlanModeEditor extends CustomEditor {
  constructor(
    tui: TUI,
    theme: EditorTheme,
    keybindings: KeybindingsManager,
    private readonly isPlanMode: () => boolean,
  ) {
    super(tui, theme, keybindings);
  }

  override render(width: number): string[] {
    return renderPlanModeBorder(super.render(width), width, this.isPlanMode(), (text) =>
      this.borderColor(text),
    );
  }
}
