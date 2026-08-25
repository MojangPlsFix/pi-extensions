# Working Indicator

Working Indicator keeps Pi's native working spinner visible while Hackler runs child sessions.
It uses `ctx.ui.setWorkingMessage()` for the label, so Pi owns the spinner animation and styling.
The extension does not install a custom indicator or the former triangle animation.

## Working messages

- `Hackler hackeln...` appears while foreground Hackler runs.
- `Subagents waiting for input...` appears when a foreground run blocks.
- `Hackler wrapping up` marks an active run while it prepares its final report.
- An empty foreground set calls `setWorkingMessage()` with no argument. Pi then restores its default
  working message.

## Compact activity widget

The extension registers a compact `SubagentActivityComponent` above the editor. It shows the
foreground Hackler rows, elapsed time, status, and recent safe activity details. The widget updates
from the shared `subagentsStatus` event and refreshes elapsed time while foreground work exists.

Acknowledged terminal runs are history-only and produce no widget rows. The widget also stays empty
when no foreground run exists. Pi sanitizes terminal output before it reaches the display. Narrow terminals truncate rows to their
available width.

Pi removes the widget when the session shuts down. Working Indicator only handles presentation.
Hackler owns child-session state, and Pi owns the parent turn's native spinner.
