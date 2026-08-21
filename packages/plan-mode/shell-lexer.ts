export type ShellLexRejectionCode =
  | "control-character"
  | "comment"
  | "operator"
  | "expansion"
  | "glob"
  | "brace-expansion"
  | "tilde-expansion"
  | "unsupported-quote"
  | "unterminated-quote"
  | "trailing-escape";

export type ShellLexRejection = {
  code: ShellLexRejectionCode;
  index: number;
  message: string;
};

export type ShellLexResult =
  | { ok: true; argv: string[] }
  | { ok: false; rejection: ShellLexRejection };

type Quote = "single" | "double" | undefined;

function rejected(code: ShellLexRejectionCode, index: number, message: string): ShellLexResult {
  return { ok: false, rejection: { code, index, message } };
}

/**
 * Decode one literal shell command without accepting shell composition or expansion.
 * The accepted quoting and escaping rules are the relevant Bash word rules only.
 */
export function lexShellCommand(command: string): ShellLexResult {
  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (character === "\0" || character === "\r" || character === "\n") {
      return rejected(
        "control-character",
        index,
        "NUL and line breaks are not allowed in Plan Mode Bash commands.",
      );
    }
  }

  const argv: string[] = [];
  let argument = "";
  let wordStarted = false;
  let quote: Quote;
  let quoteStart = -1;

  const finishWord = (): void => {
    if (!wordStarted) return;
    argv.push(argument);
    argument = "";
    wordStarted = false;
  };

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index]!;

    if (quote === "single") {
      if (character === "'") quote = undefined;
      else argument += character;
      continue;
    }

    if (quote === "double") {
      if (character === '"') {
        quote = undefined;
        continue;
      }
      if (character === "\\") {
        if (index + 1 >= command.length) {
          return rejected(
            "trailing-escape",
            index,
            "A trailing backslash is not allowed in a Plan Mode Bash command.",
          );
        }
        const next = command[index + 1]!;
        if (next === '"' || next === "\\" || next === "$" || next === "`") {
          argument += next;
          index += 1;
        } else {
          // Bash keeps this backslash when the next character is not special in double quotes.
          argument += `\\${next}`;
          index += 1;
        }
        continue;
      }
      if (character === "$" || character === "`") {
        return rejected(
          "expansion",
          index,
          "Active shell expansion is not allowed in Plan Mode Bash commands.",
        );
      }
      argument += character;
      continue;
    }

    if (character === " " || character === "\t") {
      finishWord();
      continue;
    }
    if (character === "'") {
      quote = "single";
      quoteStart = index;
      wordStarted = true;
      continue;
    }
    if (character === '"') {
      quote = "double";
      quoteStart = index;
      wordStarted = true;
      continue;
    }
    if (character === "\\") {
      if (index + 1 >= command.length) {
        return rejected(
          "trailing-escape",
          index,
          "A trailing backslash is not allowed in a Plan Mode Bash command.",
        );
      }
      argument += command[index + 1]!;
      wordStarted = true;
      index += 1;
      continue;
    }
    if (character === "#" && !wordStarted) {
      return rejected(
        "comment",
        index,
        "Active shell comments are not allowed in Plan Mode Bash commands.",
      );
    }
    if ("|;&<>()".includes(character)) {
      return rejected(
        "operator",
        index,
        "Shell composition, redirection, and grouping are not allowed in Plan Mode Bash commands.",
      );
    }
    if (character === "$" || character === "`") {
      const next = command[index + 1];
      return rejected(
        next === "'" || next === '"' ? "unsupported-quote" : "expansion",
        index,
        next === "'" || next === '"'
          ? "Dollar-prefixed Bash quoting is not allowed in Plan Mode Bash commands."
          : "Active shell expansion is not allowed in Plan Mode Bash commands.",
      );
    }
    if (character === "*" || character === "?" || character === "[" || character === "]") {
      return rejected(
        "glob",
        index,
        "Unquoted shell glob expansion is not allowed in Plan Mode Bash commands.",
      );
    }
    if (character === "{" || character === "}") {
      return rejected(
        "brace-expansion",
        index,
        "Unquoted brace expansion is not allowed in Plan Mode Bash commands.",
      );
    }
    const assignmentTilde =
      character === "~" &&
      /^[A-Za-z_][A-Za-z0-9_]*\+?=/u.test(argument) &&
      (argument.endsWith("=") || argument.endsWith(":"));
    if (character === "~" && (!wordStarted || assignmentTilde)) {
      return rejected(
        "tilde-expansion",
        index,
        "Unquoted active tilde expansion is not allowed in Plan Mode Bash commands.",
      );
    }

    argument += character;
    wordStarted = true;
  }

  if (quote) {
    return rejected(
      "unterminated-quote",
      quoteStart,
      `An unterminated ${quote}-quoted string is not allowed in a Plan Mode Bash command.`,
    );
  }
  finishWord();
  return { ok: true, argv };
}

/** Compatibility name for callers that emphasize the literal-only grammar. */
export const lexLiteralCommand = lexShellCommand;
