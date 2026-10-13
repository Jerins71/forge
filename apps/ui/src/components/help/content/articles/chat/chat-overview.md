The chat interface is where you interact with Forge's manager agents. You send a message, the manager reads it, and it starts streaming a response in real time.

## Layout

The main view has three parts:

- **Sidebar** (left) for navigating managers, profiles, and sessions.
- **Message area** (center) showing the conversation transcript.
- **Browser panel** (globe button in the chat header) opens the session's browser to the right of the chat. Pages agents open appear there, and you can watch or step in. See *Browser panel*.
- **Desktop workspace rail** (left edge of the workspace) for Chat, Files, Source Control, Terminal, Cron/Schedules, and Artifacts/Dashboard. Chat returns to the current manager/session conversation, including from a selected worker route back to its parent manager thread. Files opens a resizable tree and tabbed file surface: single-click uses one replaceable preview tab, while double-click, first edit, and create make tabs sticky. Markdown defaults to rendered Preview with a Preview/Source toggle, and Files supports empty-file creation plus file/directory rename and delete. Opening another file, hiding Files, or entering Source Control preserves drafts without prompting; destructive path actions and matching Source Control write mutations guard affected dirty tabs. Source Control opens inline with Changes and History stacked in one explorer, plus Worktrees and Pull Requests shortcuts, and may quietly refresh stale origin data when opened. History shows connected commit refs and a compact graph for workspace repositories. **Publish Branch** appears only when the current branch has no upstream: it fetches origin and publishes without force. Forge refuses to overwrite when the same-named `origin/<branch>` has commits missing locally. If the remote branch is created but local upstream tracking cannot be set, publishing still succeeds, `origin/<branch>` remains the destination, and Forge shows a tracking warning. Once upstream tracking is configured, later updates use **Sync Changes**, which fetches origin, then pushes the current branch to its upstream when it is ahead and not behind. Selecting a worktree scopes Source Control and Files without changing the chat session's working directory. Files, Source Control, Artifacts/Dashboard, and Schedules switch mutually exclusively, while Terminal stays independent and persistent. Mobile keeps the header/drawer workspace behavior and file content remains read-only.

## Streaming and status

While a manager is responding, you'll see a green status dot in the header and the text "Streaming." The message appears incrementally as it's generated. When **Show response throughput in conversations** is enabled in **Settings → General**, an eligible local Pi-runtime model call gets a fixed response-throughput control in the manager header: it pulses while generating and shows the latest provider-final `tok/s` value based on the complete request duration, or `— tok/s` before one is available. Open the **Response Throughput** help article for availability, missing-data behavior, and the historical **Stats → Response throughput** view.

## Stopping a response

To stop a running response, open the **⋮ menu** in the header and choose **Stop All**. This terminates the manager and any active workers.

If an active manager stops making progress, amber System rows provide approximate escalation notices. If a response becomes repetitive or overlong, Forge stops it, keeps workers running, and explains the recovery in System rows. After a backend restart, Forge does not auto-resume; when recovery information is available, a banner below the header offers **Resume all** or **Dismiss**. Open the related **Stalls and restart recovery** article for stall notices, runaway recovery, and restart safety guidance.

## Channel views

The header has a **Web / All** toggle. For a manager, **Web** prioritizes the focused conversation transcript and pending choices you can answer. **All** adds manager-session activity, manager tool rows, and final results returned by workers; it does not inline the workers' internal tool history. Selecting a worker opens that worker's transcript and defaults its view to All.

Raw worker results remain inspectable in **All**. The manager treats them as evidence, performs the smallest focused acceptance check needed, and publishes an accepted result or material blocker.

For diagnostics and runtime internals, use **Session Audit Log** from the chat header menu. It reads the persisted session history directly from canonical JSONL files. The manager source shows the manager session log; selecting a worker source shows that worker's transcript and internal tool activity. On desktop, Session Audit uses a split list/detail inspector with a draggable, resizable divider. The list stays paginated with compact, clickable summaries and capped previews for performance. Select any row to automatically load the full canonical row into the detail pane, where you can switch between formatted/raw JSON, toggle wrapping, and copy the JSON. Detail fetch is capped at 8 MB per row; very large JSON falls back to a plain scrollable viewer so the audit UI stays responsive while copy still includes the fetched text. Rows include category/type filters, byte offsets, and hidden reasons. This audit surface is for inspection only and is not part of the normal chat transcript or model context.

Builder web also supports Codex app-server sidecars. A plain leading @Codex or [@Codex] starts or continues a direct sidecar text turn. Selector forms like @Codex -<plugin>, @Codex:<plugin>, and [@Codex:<plugin>] scope the turn to a plugin and delegate it through the visible Codex Plugin specialist worker. Direct sidecars show as worker-like external-thread cards and persist by default; plugin-scoped turns stay read-only/safety-gated with bounded redacted previews and metadata. Full connector exports appear as session artifacts rather than long chat output. This is Builder web only, text-only for the direct sidecar path, and allows one active direct Codex turn globally.

Mermaid code blocks also render inline as interactive diagrams, with controls to toggle source, copy the Mermaid text, export SVG or PNG, expand fullscreen, zoom, fit or reset the view, and drag to pan oversized diagrams.

## Replying

In normal Builder chat, hover a visible user or assistant message and click **Reply** to quote it in your next message. The composer shows a compact reply target preview; clear it to send without a quote, or choose Reply on another message to change the target. Sent replies show a compact quoted preview above the message. Click that quote to scroll back to the original when it is loaded in the current transcript. Async Project Agent delivery does not use this reply threading in v1.

## Context window

The ring icon next to the channel toggle shows how full the context window is. While a runtime is live, the live runtime status is authoritative for that meter. Green means plenty of room. Amber means it's getting full. Red means you're near the limit and should consider compacting. Compact context follows the session's effective context policy from **Project Settings** or the Send-adjacent **Context management** control. Open **Context Compaction** for Summary vs experimental Context v2 and agent-only history recall.

## Working plans

For substantial multi-step work, managers can publish a concise working plan. The card at the top of chat highlights the current work, and the header control opens the complete checklist. Plans use only Pending, In progress, and Completed states and can show multiple active steps during parallel work.

If you explicitly ask for sustained pursuit, the manager can instead keep one durable session goal across turns and multiple plans. Its compact bar remains below the header with pause, resume, edit, and cancel controls plus optional elapsed-time and token-budget details.

## Header controls

The chat header still shows the pin count badge, where you can move to the previous or next pin and the selected pin is auto-scrolled into view and highlighted. Desktop workspace buttons now live behind the activity rail instead of the header; mobile keeps the header workspace actions. Use the Chat rail item to jump back to the current manager/session chat, including from worker-route views back to the parent manager thread.
