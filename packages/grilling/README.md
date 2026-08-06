# Grilling

The Grilling skills test a plan, decision, or idea before the model acts.

## Skills

### `grilling`

Use `/skill:grilling` to start the design-tree interview. The skill finds the current decision frontier and works through it in rounds.

When `ask_user_question` is available, the skill uses the existing structured question dialog. It asks up to three related questions in one call. It gives options, marks a recommended answer, and allows custom details.

When the tool or a user interface is not available, the skill asks concise questions in ordinary English. It does not use a custom question format.

### `grill-me`

Use `/skill:grill-me` to start an explicit `grilling` session. This skill does not start by itself.

## Rules

The skill finds facts with tools. It does not ask the user for facts that it can inspect.

The skill waits for each answer before it asks a dependent question. It does not guess after a cancelled question.

The session ends after the frontier is empty and the user confirms shared understanding.
