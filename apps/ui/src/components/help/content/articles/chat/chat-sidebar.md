The sidebar on the left is your main navigation for everything in Forge. The new project view is on by default. Use **Settings → General → Sidebar → Use new project view** to keep it, or turn it off to roll back to Classic. It opens in **Inbox**, with **Projects** keeping the familiar project/session tree.

Use the Archive view from the sidebar to review archived projects and directly archived sessions. Archive entries are sorted by last user-message activity and show the last-used date. Restore and reopen them when needed. The Archive view is separate from the active session list. Other system profiles remain hidden from the sidebar/profile lists.

## Inbox

Inbox is the default new project view. It lists:

- **Needs you** — server-issued work-lifecycle attention. Unread badges and error dots do not create these items. An unanswered **Input requested** pending choice raises **Needs you** even while work still runs or follow-ups are queued; answering or cancelling retracts that item without marking the session complete, so remaining work can stay **Active**. The UI does not synthesize **Needs you** from local badges.
- **Active** — currently working sessions, capped at five, with **N more** opening Projects.
- **Recent** — idle sessions updated in the last 7 days, excluding **Needs you** and **Active**. Inbox initially shows five rows; **Show N more** expands the remaining matching rows inline, and **Show less** collapses back to five without switching to Projects.
- **Projects** — the same project/session tree as Projects mode, shown inline after those sections. Drag project headers to reorder them the same way as in Projects.

**Done** and **Clear** dismiss the exact **Needs you** items they target. Muting a session only hides it from **Needs you** and the Inbox badge; it does not dismiss the attention. Right-click a **Needs you**, **Active**, or **Recent** session for the same session actions as Projects.

## Projects

Each **profile** is a collapsible group. Inside each profile are its **sessions**. Inside each session, you can expand to see active **workers**. Click a session or worker to switch to it. Project headers expand or collapse their nested sessions; they do not select a conversation.

Project agents appear pinned at the top of each profile section with a badge, above regular sessions. Session pinning in the sidebar is separate from message pinning inside a conversation.

## Search

The search bar at the top filters sessions and workers by name in one result set. Prefix shortcuts remain available in Projects:

- `s:` searches only session names.
- `w:` searches only worker names.

## Profile actions

For a Builder project, right-click its header and choose **Project Settings**. You can also hover the header, or focus its actions button, then open the **…** menu. The page stays scoped to that selected project and provides its name, working directory, default model and reasoning level, Context management, Project secrets, and Repository resources `.forge` controls. Context management is the project default for Summary vs experimental Context v2.

The direct header context-menu shortcuts remain: New Session, Create Project Agent, Rename, Change Default Model, Change Working Directory, Project Secrets, Mark All as Read, Mute/Unmute All Sessions, Archive Project, and Delete Manager. Changing the default model updates the project default for new conversations only; existing sessions retain their stored model. Changing the working directory updates the CWD for all sessions in the profile — active workers keep their old CWD, but new spawns inherit the new path. Archiving a project marks only the profile as archived, not each session individually, but the whole project becomes read-only and unusable until restored.

You can drag project headers into one shared order in Inbox or Projects. Forge saves that order on the Builder instance, so browsers and the desktop app connected to the same Forge use the same layout. Ordering is only presentation state. Archived and client-unseen projects keep their positions, and deleted projects can remain as harmless hidden anchors. The **+** button on a profile header creates a new session.

## Session actions

Right-click any session to access: Copy session data path, Rename, Fork, Override Session Model, Use Project Default, Stop, Resume, Archive, Restore, Mark as Unread, Mute/Unmute, or Delete. The Main (default) session in each profile cannot be deleted or archived directly. Muting a session suppresses notification sounds while keeping the unread badge visible. In Inbox, mute also hides that session from **Needs you** and the Inbox badge without dismissing the server attention. Override Session Model opens a one-screen dialog for picking a concrete model, and Use Project Default copies the current project default onto that one session. Later project-default changes do not cascade. Every session, including the root session, can override its stored model or copy the current project default onto itself. Archived sessions are read-only and unavailable for chat, model, CWD, project-agent reference edits, and terminal use until restored. Archive entries are sorted by last user-message activity and show the last-used date. Restore can open the restored target immediately when requested.

## Workers

Sessions with active workers show a numbered amber badge. Sessions in compaction or context recovery show a violet pulsing `C` badge. If both are active, the worker-count badge and `C` badge appear side by side. Expand the session to see individual workers with their status dots and specialist badges. Right-click a worker to stop, resume, or delete it.

## Mobile

On smaller screens, the sidebar is hidden by default. Tap the hamburger menu in the header to open it. An unread badge shows on the menu button when there are unread messages.
