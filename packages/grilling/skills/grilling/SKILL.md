---
name: grilling
description: Interview the user to test a plan, decision, or idea. Use during Plan Mode or when the user asks for a grilling session.
---

# Grilling

Interview the user until you reach shared understanding.

Build a design tree. Each decision branches into decisions that depend on it.

Work in rounds:

1. Explore the environment before you ask about facts.
2. Find the frontier. The frontier contains decisions whose prerequisites are settled.
3. Ask the whole frontier before you ask a dependent question.
4. Wait for the user response.
5. Recompute the frontier.
6. Repeat until all material decisions are settled.

When `ask_user_question` is available, use it for the frontier. Use one call when the frontier has three or fewer questions. If it has more questions, use more calls in the same round. Do not ask a dependent question until its prerequisites are settled.

For each question:

- Give two to four useful options.
- Mark one option as the recommended answer.
- Use `multiSelect` when more than one option can apply.
- Allow custom details for constraints and exceptions.
- Keep the question concise.

If `ask_user_question` is unavailable or the session has no UI, ask concise questions in ordinary English. Do not use a custom question format.

Facts are your responsibility. Use the available tools to find facts instead of asking the user for facts that you can inspect.

If the user cancels a question, do not guess the answer. Keep the decision unresolved and do not finish the design until the user resolves it.

Finish only when the frontier is empty and the user confirms shared understanding. In Plan Mode, do not act on the design before Plan Mode ends.
