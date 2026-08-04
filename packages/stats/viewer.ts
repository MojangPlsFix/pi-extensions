import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  type KeybindingsManager,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { ReportMode } from "./stats.js";

type ViewerTui = {
  terminal: { rows: number };
  requestRender(): void;
};

type ViewerTheme = Pick<Theme, "fg" | "bold">;

/** Interactive modal report viewer used by the TUI stats command. */
export class StatsViewer {
  private lines: string[];
  private offset = 0;
  private loading = false;
  private disposed = false;

  constructor(
    private readonly tui: ViewerTui,
    private readonly theme: ViewerTheme,
    private readonly keybindings: KeybindingsManager,
    private mode: ReportMode,
    report: string,
    private readonly done: () => void,
    private readonly navigate: (delta: number) => Promise<string>,
    private readonly changeMode: (mode: ReportMode) => Promise<string>,
  ) {
    this.lines = report.split("\n");
  }

  private pageSize(): number {
    // Leave room for the modal frame, title, footer, and margins.
    return Math.max(1, Math.floor((this.tui.terminal.rows || 24) * 0.8) - 6);
  }

  private async movePeriod(delta: number): Promise<void> {
    if (this.loading || this.disposed) return;
    this.loading = true;
    this.offset = 0;
    this.tui.requestRender();
    try {
      this.lines = (await this.navigate(delta)).split("\n");
    } finally {
      this.loading = false;
      this.tui.requestRender();
    }
  }

  private async switchMode(mode: ReportMode): Promise<void> {
    if (this.loading || this.disposed || this.mode === mode) return;
    this.loading = true;
    this.offset = 0;
    this.tui.requestRender();
    try {
      this.lines = (await this.changeMode(mode)).split("\n");
      this.mode = mode;
    } finally {
      this.loading = false;
      this.tui.requestRender();
    }
  }

  private close(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.done();
  }

  handleInput(data: string): void {
    const pageSize = this.pageSize();
    const maxOffset = Math.max(0, this.lines.length - pageSize);
    const up = this.keybindings.matches(data, "tui.select.up") || matchesKey(data, Key.up);
    const down = this.keybindings.matches(data, "tui.select.down") || matchesKey(data, Key.down);
    const previousPeriod = matchesKey(data, Key.left);
    const nextPeriod = matchesKey(data, Key.right);
    const pageUp = this.keybindings.matches(data, "tui.select.pageUp");
    const pageDown = this.keybindings.matches(data, "tui.select.pageDown");

    if (matchesKey(data, Key.escape) || data === "q") {
      this.close();
      return;
    }
    if (data === "m") {
      void this.switchMode("month");
      return;
    }
    if (data === "w") {
      void this.switchMode("workweek");
      return;
    }
    if (previousPeriod) {
      void this.movePeriod(-1);
      return;
    }
    if (nextPeriod) {
      void this.movePeriod(1);
      return;
    }
    if (up) this.offset = Math.max(0, this.offset - 1);
    else if (down) this.offset = Math.min(maxOffset, this.offset + 1);
    else if (pageUp) this.offset = Math.max(0, this.offset - pageSize);
    else if (pageDown) this.offset = Math.min(maxOffset, this.offset + pageSize);
    else if (matchesKey(data, Key.home)) this.offset = 0;
    else if (matchesKey(data, Key.end)) this.offset = maxOffset;
    else return;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const pageSize = this.pageSize();
    const maxOffset = Math.max(0, this.lines.length - pageSize);
    this.offset = Math.min(this.offset, maxOffset);
    const visible = this.loading
      ? [this.theme.fg("dim", `Loading ${this.mode === "month" ? "month" : "week"}…`)]
      : this.lines.slice(this.offset, this.offset + pageSize).map((line) => {
          if (/^Pi usage/.test(line)) return this.theme.fg("accent", this.theme.bold(line));
          if (/^(SUMMARY|DAILY|WEEKLY|MODELS|PROJECTS)$/.test(line)) {
            return this.theme.fg("accent", this.theme.bold(line));
          }
          if (/^ {2}(Day|Week)\s/.test(line)) return this.theme.fg("dim", this.theme.bold(line));
          if (/^Scanned /.test(line)) return this.theme.fg("dim", line);
          return line;
        });

    const innerWidth = Math.max(1, width - 2);
    const border = (text: string): string => this.theme.fg("borderMuted", text);
    const frame = (line: string): string => {
      const truncated = truncateToWidth(line, innerWidth, "");
      return (
        border("│") +
        truncated +
        " ".repeat(Math.max(0, innerWidth - visibleWidth(truncated))) +
        border("│")
      );
    };
    const title = this.theme.fg("accent", this.theme.bold(" Pi usage "));
    const periodName = this.mode === "month" ? "month" : "week";
    const viewHint = this.mode === "month" ? "w work week" : "m month";
    const footer = this.theme.fg(
      "dim",
      `↑↓ scroll · ${viewHint} · ← previous ${periodName} · → next ${periodName} · Home/End · Esc/q close${maxOffset ? ` · ${this.offset + 1}-${Math.min(this.offset + pageSize, this.lines.length)}/${this.lines.length}` : ""}`,
    );
    const top = border(`┌${"─".repeat(innerWidth)}┐`);
    const bottom = border(`└${"─".repeat(innerWidth)}┘`);
    return [top, frame(title), ...visible.map(frame), frame(footer), bottom].map((line) =>
      truncateToWidth(line, width, ""),
    );
  }

  dispose(): void {
    this.disposed = true;
  }

  invalidate(): void {
    this.tui.requestRender();
  }
}

export default StatsViewer;
