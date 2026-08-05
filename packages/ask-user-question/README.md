# Ask User Question

Registers `ask_user_question`, a compact structured dialog for decisions that should not be guessed.

The tool supports one-choice and multi-select questions, optional free-form answers, review before submission, and cancellation. In the TUI it uses one wizard for all questions: Tab opens details for the highlighted option, Enter commits, and left/right moves between questions while preserving selections and custom drafts. If a question was skipped, the review screen offers Go back or Proceed. Predefined answers retain their option label while custom details are returned separately; choosing only a custom answer retains `kind: "custom"`, and multi-select answers retain `selected` plus optional `custom`. Non-TUI UI modes keep the select/editor fallback. If Pi has no interactive UI (for example a non-interactive RPC client), it returns a clear `no_ui` result instead of blocking or failing startup.

Plan Mode can refer to this tool when it is installed, but Plan Mode remains usable when this feature is disabled.
