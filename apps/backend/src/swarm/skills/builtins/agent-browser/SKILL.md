---
name: agent-browser
description: Headless agent-browser CLI for agents without Forge browser_* tools (such as workers). If browser_open is available, use it instead; the user sees those tabs in the Browser panel.
---

# Agent Browser

Use this skill for browser tasks only when the Forge `browser_*` tools are not available to you. When they are, use them: the user watches those tabs live in the Browser panel, and logins persist per project.

Run the `agent-browser` CLI directly. This skill is documentation-only and does not provide wrapper scripts.

## Install

Global install (recommended):

```bash
npm install -g agent-browser
agent-browser install
```

Quick start without install:

```bash
npx agent-browser install
npx agent-browser open https://example.com
```

Project-local install:

```bash
npm install agent-browser
npx agent-browser install
```

## Core Workflow

```bash
agent-browser open https://example.com
agent-browser snapshot -i --json
agent-browser click @e2
agent-browser fill @e3 "hello"
agent-browser snapshot -i --json
agent-browser close
```

Use refs (`@e1`, `@e2`, ...) from `snapshot` output for deterministic interactions.

## Common Commands

Navigation and session:

```bash
agent-browser open <url>
agent-browser back
agent-browser forward
agent-browser reload
agent-browser tab
agent-browser session
agent-browser session list
agent-browser close
```

Interaction:

```bash
agent-browser click <selector-or-ref>
agent-browser dblclick <selector-or-ref>
agent-browser focus <selector-or-ref>
agent-browser type <selector-or-ref> "<text>"
agent-browser fill <selector-or-ref> "<text>"
agent-browser press Enter
agent-browser hover <selector-or-ref>
agent-browser select <selector-or-ref> "<value>"
agent-browser check <selector-or-ref>
agent-browser uncheck <selector-or-ref>
agent-browser upload <selector-or-ref> "<path>"
agent-browser drag <source> <target>
agent-browser scroll down 500
agent-browser scrollintoview <selector-or-ref>
```

Semantic finding (no fragile CSS required):

```bash
agent-browser find role button click --name "Submit"
agent-browser find text "Sign in" click
agent-browser find label "Email" fill "test@example.com"
```

Waiting:

```bash
agent-browser wait 1000
agent-browser wait --load networkidle
agent-browser wait --text "Welcome"
agent-browser wait --url "**/dashboard"
agent-browser wait --fn "window.ready === true"
```

Extraction:

```bash
agent-browser get text <selector-or-ref>
agent-browser get html <selector-or-ref>
agent-browser get value <selector-or-ref>
agent-browser get attr <selector-or-ref> <attribute>
agent-browser get title
agent-browser get url
agent-browser get count <selector>
agent-browser snapshot -i --json
```

Capture and comparison:

```bash
agent-browser screenshot page.png
agent-browser screenshot --annotate
agent-browser screenshot --full fullpage.png
agent-browser pdf page.pdf
agent-browser diff snapshot
agent-browser diff screenshot --baseline before.png -o diff.png
agent-browser diff url https://v1.example https://v2.example
```

State and persistence:

```bash
agent-browser --session <name> open <url>
agent-browser --session-name <name> open <url>
agent-browser --profile <path> open <url>
agent-browser state save <path>
agent-browser state load <path>
agent-browser state list
```

Machine-readable output:

```bash
agent-browser snapshot --json
agent-browser get text @e1 --json
```

## Usage Notes

- Prefer `snapshot -i --json` + refs (`@eN`) before interacting.
- Re-run `snapshot` after any action that may change the page.
- Use `--session`/`--profile` when isolation or persistence is needed.
- Use `agent-browser close` at the end of tasks to shut down the browser cleanly.
