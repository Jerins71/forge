Forking creates a copy of a session so you can take the conversation in a different direction without losing the original.

## How to fork

Right-click a session in the sidebar and choose **Fork**. A dialog opens where you can give the fork a name (optional, Forge auto-generates one if you leave it blank).

## Full fork

By default, forking copies the entire conversation history into a new session.

## Partial fork

You can also fork from a specific message. When triggered from a message context, the fork dialog shows which message it will fork from. Only messages up to that point are copied. Everything after is left behind.

The forked session's memory header records where the fork happened, so the boundary with the parent session is explicit.

Either way, the fork copies the source session's stored model. Later project-default changes do not cascade into the fork.

## Fork point and model

On an environment that supports context transfers, the fork dialog opened from a message adds two choices:

- **Fork from** selects where the fork's context ends: **This message**, or the **Latest stable point** of the session.
- **Model** starts the fork on a different provider or model. Leave it as **Same as this session** to keep the source model.

On an environment that has not been updated, both choices are disabled with the reason, and the fork copies history up to the selected message as before.

## Handing a session to another provider

Choosing a model from a different provider in the composer's model picker asks you to confirm a handoff. This is the same session, not a new chat: the conversation so far is handed to the new provider as context. Credentials and tool grants are not transferred. Changing to another model on the same provider needs no handoff.

## Merging a fork back

Open the session's **More actions** menu and choose **Merge back into** the parent. What the fork added since it branched is handed to the parent session as context. The fork stays as it is, and nothing in the parent is replaced.

## Continuing a finished worker

Right-click a worker that is no longer running and choose **Continue as conversation**. Forge opens a normal session that carries on from the worker's work.

## Lineage

A session that was forked, continued from a worker, or handed to another provider shows a lineage marker next to its title, such as "Forked from Builder at message …" or "Switched from codex-native". Select it to see each context handoff: how many entries were included, omitted or truncated, how much of the context budget was used, and how the handoff was rendered.

Merge back, worker continuation and provider handoff are disabled with the reason when the environment or the provider cannot perform them. Forge never substitutes a different action.

## What gets copied

- **Conversation history** (all messages, or up to the selected message for partial forks).
- The source session's **stored model**. Later project-default changes do not cascade into the fork.
- A fresh **session memory** is created with a fork header noting the parent session.

## What does not get copied

- The original session is unchanged. Forking is non-destructive.
- Session memory content from the parent is not carried over. The new session starts with its own empty memory (plus the fork header).
- Cursor SDK runtime state and usage records are not copied, so forks do not leak SDK resume state or double-count usage.
- A source session's initial Pi model-input record is not copied. A Pi-backed fork records its own initial input when it makes its first model request.
- Pi response-throughput measurements are not copied, so the fork starts its own response-throughput history.
- Historical Codex sidecar display cards are not copied.
- Workers from the parent session are not duplicated.

## Side chats

Type `/side` in a Builder session's composer to ask a quick side question without interrupting the main conversation. Any text after `/side` becomes the side chat's first message.

A side chat is a temporary fork of the current session from its latest message, so it has the same context. It opens in a panel next to the main chat, which stays usable. Side chats support follow-up messages but cannot delegate to workers, schedule tasks, message other sessions, or write memory.

Side chats never appear in the sidebar. Each session has at most one side chat, so starting a new one replaces the previous one. Choose **Discard** in the panel header to delete it, or hide the panel and reopen it later from the **Side chat** button.

## When to use it

Fork when you want to try an alternative approach, preserve a checkpoint before a risky change, or branch a conversation into two tracks.
