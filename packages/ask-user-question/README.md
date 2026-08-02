# Ask User Question

Registers `ask_user_question`, a compact structured dialog for decisions that should not be guessed.

The tool supports one-choice and multi-select questions, optional free-form answers, review before submission, and cancellation. It returns structured answers to the model. If Pi has no interactive UI (for example a non-interactive RPC client), it returns a clear `no_ui` result instead of blocking or failing startup.

Plan Mode can refer to this tool when it is installed, but Plan Mode remains usable when this feature is disabled.
