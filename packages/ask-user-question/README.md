# Ask User Question

`ask_user_question` gives the model a structured dialog for decisions that it should not guess.

The tool supports one-choice, multi-select, and custom questions. It supports review before submission and cancellation. In the TUI, one wizard handles all questions. Use Tab to add details to the highlighted option. Use Enter to submit. Use left and right to move between questions while Pi keeps selections and custom drafts.

When you skip a question, the review screen offers Go back or Proceed. Predefined answers keep their option label. Custom details return in a separate field. A custom-only answer uses `kind: "custom"`. A multi-select answer uses `selected` and an optional `custom` field.

Non-TUI modes use the select and editor fallback. A client without interactive UI, such as a non-interactive RPC client, receives a clear `no_ui` result. The tool does not block or fail startup.

Plan Mode can reference this tool when it is installed. Plan Mode remains usable when this feature is disabled.
