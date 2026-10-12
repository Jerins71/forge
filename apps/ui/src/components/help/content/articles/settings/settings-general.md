General Settings covers editor integration, sidebar preferences, repository clone defaults, compaction, and telemetry. Appearance has its own **Settings > Appearance** pane, and diagnostic export controls live in **Settings > Observability**.

## Appearance

Open **Settings > Appearance** to choose Light, Dark, System, or a custom local appearance. Choose which code editor opens artifact file links from General. Supported editors are VS Code Insiders, VS Code, and Cursor.

## Repositories

Use **Settings > General > Repositories** to set a configured repository home for **Clone repository** during project creation. Precedence is: configured home → last successfully used clone base → your home directory. Clearing the configured home falls back to last-used or home. Private clones require ambient noninteractive Git/SSH credentials on the Builder host.

## Sidebar

Toggle **Show provider usage** to control whether the provider subscription usage widget appears in the sidebar toolbar. When enabled, you'll see compact usage gauges. Anthropic Claude exposes 5-hour and weekly windows. OpenAI Codex shows weekly when the provider reports it, and shows the 5-hour/Session gauge and detail card only when a session window is reported — never an empty Session card. True dual limits stay visible when both windows are present. A stored xAI OAuth credential adds a weekly-only `xAI` SuperGrok credits gauge. Click the widget to expand it for detailed metrics including reset remaining time and, where available, deficit/reserve pace and estimated runout times, and use the refresh button in the detail panel to re-poll immediately. Usage state is restored after backend restarts. OpenAI and Anthropic weekly estimates follow historical usage curves rather than simple linear interpolation; the xAI weekly gauge has no historical pace curve. Cursor SDK usage is not part of this widget — it appears in Stats token analytics and telemetry provider inference. xAI API-key-only or env-only `XAI_API_KEY` setups, and missing or unauthorized xAI OAuth, leave the xAI gauge absent without extra noise, and transient fetch failures keep the last good reading. Pooled OAuth usage polling refreshes tokens first, and pooled auth errors can suppress usage display. When OpenAI/Codex uses Forge Auth broker mode, broker-backed status and usage appear when the broker provides them. The setting is stored in your browser and applies immediately.

**Use new project view** is on by default. Leave it on for Inbox and Projects; turn it off to roll back to Classic. Inbox opens first and lists **Needs you**, **Active**, and **Recent**, then an inline Projects tree. **Needs you** is server-issued work-lifecycle attention. Unread and error badges do not create it, and the UI does not synthesize it from local badges. An unanswered **Input requested** pending choice raises **Needs you** even while work still runs or follow-ups are queued; answering or cancelling retracts that item without marking the session complete, so remaining work can stay **Active**. **Done** and **Clear** dismiss those exact items; mute only hides **Needs you** and the Inbox badge. Projects keeps the project/session tree, search prefixes, pins, and drag reorder.

## Working plans

Working plans and explicit session goals are always available to Builder managers and do not require a General Settings toggle.

## Compaction

Use **Settings > General > Compaction** to choose the model, reasoning level, and timeout Forge uses for automatic compaction and manual Compact context runs. These controls apply only to supported Pi-backed manager compaction runtimes: OpenAI/Codex and Anthropic. Cursor SDK, xAI/Grok, and user-added OpenRouter manager models are not eligible here; OpenRouter manager eligibility is a separate policy. The default is **GPT-5.5**, **Low** reasoning, and a **5 minute** timeout. If the configured provider or model is unavailable, Forge shows a warning here so you can fix auth or pick a different model before automatic compaction needs it.

This pane does not choose Summary vs Context v2. That project default lives in **Project Settings → Context management**, with an optional session inherit/override beside Send. Compact context still follows the effective policy: Summary compacts older context, while Context v2 continues from task notes and recoverable earlier history without an AI summarizing pass.

## Conversation Response Throughput

**Show response throughput in conversations** is off by default. Turn it on to show final Pi response throughput in manager headers, worker pills, and Worker Quick Look in Builder conversations. The rate uses provider-final output across the complete request duration. This browser setting applies immediately. Turning it off hides only those conversation controls: **Stats → Response throughput** continues collecting and showing historical response throughput.

## Prompt Cache Visualization

Use **Enable prompt cache visualization** to show a compact prompt-cache chip in manager chat headers for OpenAI/Codex Pi sessions. It is Builder-only and **off by default**.

When enabled, Forge captures provider-reported cached input token counts on eligible manager turns and summarizes hit, partial, and miss states in the header popover. While disabled, Forge does not collect new cache observations and hides the indicator. Observations from earlier enabled periods may appear after you turn this on and load session history.

Cached token counts come from the provider. OpenAI does not report specific miss or drop causes, and Forge does not infer them.

## Telemetry

Anonymous telemetry is enabled by default. It sends a random install identifier and report identifier; coarse environment metadata such as app and runtime versions, platform, architecture, Desktop status, and language; aggregate usage and feature-adoption counts; configured and used provider names; and the most-used catalog model ID. It does not send prompts or messages, code, file contents or paths, repository names, credentials, or secrets.

To opt out, set `FORGE_TELEMETRY=false` in your environment. There is no telemetry setting in the UI.

## Welcome Preferences

Edit the default preferences Forge shares with new manager sessions. These are the onboarding choices you made on first launch (name, technical level, workflow style). Forge saves them in its structured onboarding state, and changes apply to future manager sessions.

## Observability

Open **Settings > Observability** to export Builder-only Forge traces to a local Arize Phoenix OTLP endpoint. That pane includes status, test export, capture toggles, and privacy controls.

## System

The Reboot button restarts the Forge daemon and all active agents. Use it after configuration changes that require a full restart, or when the backend is in a bad state.
