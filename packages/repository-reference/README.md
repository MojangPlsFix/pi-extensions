# Repository Reference

`repository_reference` provides a narrow, managed way to inspect another Git repository without placing it in the project workspace.

## Operations

- `clone`: validate a network remote and optional revision, then clone it without a shell into a private temporary directory and check out the revision detached. The result includes the managed `id`, path, requested revision, and resolved commit. Clone phases and Git progress are streamed in the tool row. Pass `verbose: true` for more bounded, sanitized diagnostics. Cloning works with or without an interactive UI.
- `list`: show references still managed by this extension.
- `remove`: delete one reference by its returned id.
- `cleanup`: delete every valid reference managed by this extension.

The managed root is `${TMPDIR}/pi-repository-references`. The extension creates it with private permissions and never accepts a destination path. `remove` and `cleanup` only delete directories with the extension's metadata marker under that root; arbitrary paths and symlinks are ignored.

Remote values must be network Git remotes using `https`, `http`, `ssh`, or `git` URLs (or the standard `user@host:path` Git form); local `file:` remotes are rejected. Revisions are limited to a single validated branch, tag, ref, or commit token. Git is invoked with Node's argument array and `shell: false`; user input is never interpolated into a command.

Press **Ctrl+O** to expand the tool output. The expanded view shows recent progress, attempted revision refs, and bounded diagnostics. Escape cancels an active clone; the Git process is terminated and any incomplete managed directory is removed. Clone failures include sanitized Git diagnostics and distinguish cancellation and timeout where possible. Credentials, URL query tokens, and fragments are redacted from displayed output.

Git authentication must be available through the normal Git credential helper or SSH configuration. Interactive Git prompts are disabled. The default clone timeout is ten minutes for the complete clone operation. Verbose mode enables additional Git tracing, but does not enable HTTP credential tracing.

This extension uses only Node and Git. Context Mode is optional and is not loaded or required. The tool manages temporary reference state only; it does not modify the current project checkout.
