# Migrate to Hackler v2

Hackler v2 does not read the version 1 schema. It does not register the version 1 tools.

## 1. Stop active children

Close every version 1 child before you update the extension.

Keep old transcript directories if you need their reports. Stats can still read the legacy transcript location.

## 2. Back up the old configuration

Back up this file:

```text
~/.pi/agent/subagents/config.json
```

Do not add `schemaVersion: 2` to the old object. Version 2 rejects old keys such as `agents`, `defaults`, and `resources`.

## 3. Create the version 2 configuration

Start with this file:

```json
{
  "schemaVersion": 2,
  "runtime": {
    "maxActive": 4,
    "maxSharedWriters": 1,
    "maxDepth": 2
  },
  "retention": {
    "days": 30,
    "entries": 200
  },
  "models": {
    "default": {
      "model": "inherit",
      "thinking": "low"
    },
    "overrides": {
      "worker": {
        "model": "inherit",
        "thinking": "high"
      }
    }
  },
  "capabilities": {},
  "runners": {},
  "herdr": {
    "direction": "right",
    "maxOutputBytes": 1000000
  },
  "profiles": {}
}
```

Move each old role model setting into `models.overrides`.

Omit `herdr.enabled` to auto-enable display-only transcript inspection when the complete Herdr environment is present. Set it to `false` to disable Herdr explicitly.

Replace optional resource switches with named capabilities. Do not copy old extension paths into a project file.

## 4. Replace custom agent files

Version 2 profile files require these fields:

```md
---
schemaVersion: 2
name: example-reviewer
description: Review one assigned code angle.
class: review
runner: native
tools: [read, grep, find, ls]
capabilities: []
skills: []
defaultContext: fresh
allowedNestedProfiles: []
maxDepth: 0
workspace: read-only
infer: true
hidden: false
---
Review the assigned angle. Cite exact evidence. Do not edit files.
```

Replace the old `mode` field with `class`.

Use these classes:

- `read`
- `write`
- `review`
- `advisory`
- `orchestrator`

User profiles remain in this directory:

```text
~/.pi/agent/subagents/agents/
```

Trusted project profiles use this directory:

```text
<project>/.pi/agents/
```

Pi must mark the project as trusted before Hackler reads project profiles.

## 5. Replace tool names

Replace version 1 tool calls as follows:

| Version 1 | Version 2 |
| --- | --- |
| `subagent_spawn` | `subagent_dispatch` |
| `subagent_list` | `subagent_status` |
| `subagent_read` | `subagent_collect` |
| `subagent_wait` | `subagent_collect` with `wait` |
| `subagent_send` | `subagent_steer` |
| `subagent_interrupt` | `subagent_stop` |
| `subagent_close` | No replacement. Runs park automatically. |

Version 2 does not provide compatibility aliases.

## 6. Check Plan Mode configuration

Remove old tool names from custom Plan Mode allowlists.

Version 2 permits its five control tools in Plan Mode. The Hackler manager blocks write profiles while Plan Mode is active.

## 7. Check Herdr settings

Version 2 does not run children through Herdr.

Set `herdr.enabled` to `true` only if you want display-only transcript panes. Herdr no longer owns child lifecycle state.

## 8. Verify the migration

1. Reload Pi.
2. Run `/agents doctor`.
3. Fix every path-specific diagnostic.
4. Run `/agents doctor --json`.
5. Start one Scout task.
6. Confirm that the task does not appear in shell history.
7. Confirm that the task starts without a manual Enter key.
8. Wait for the Scout to park.
9. Open `/agents` and inspect its report.
10. Start one isolated Worker test in a clean Git checkout.
11. Apply or keep its candidate through the Inbox.

Do not enable workplace write capabilities until read-only profiles pass these checks.
