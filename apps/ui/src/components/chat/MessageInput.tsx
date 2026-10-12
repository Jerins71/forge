import { forwardRef, useCallback, useId, useImperativeHandle, type KeyboardEvent } from 'react'
import { ALargeSmall, ArrowUp, List, ListOrdered, Loader2, Mic, Paperclip, Square } from 'lucide-react'
import { AttachedFiles } from '@/components/chat/AttachedFiles'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { findMentionContaining } from './message-input/mention-utils'
import { toggleBulletList, toggleNumberedList } from './message-input/format-utils'
import { SlashCommandMenu } from './message-input/SlashCommandMenu'
import { MentionMenu } from './message-input/MentionMenu'
import { mentionMenuActiveDescendantId } from './message-input/mention-menu-a11y'
import { VoiceRecordingBar } from './message-input/VoiceRecordingBar'
import { ComposerTextarea } from './message-input/ComposerTextarea'
import { SecureSessionPicker } from './message-input/SecureSessionPicker'
import { SessionModelPicker } from './message-input/SessionModelPicker'
import { SessionContextModePicker } from './message-input/SessionContextModePicker'
import { useDraft } from './message-input/hooks/use-draft'
import { useSlashCommands } from './message-input/hooks/use-slash-commands'
import { useMentions } from './message-input/hooks/use-mentions'
import { useVoiceInput } from './message-input/hooks/use-voice-input'
import { useAttachments } from './message-input/hooks/use-attachments'
import { useComposer } from './message-input/hooks/use-composer'
import { useSessionReferences } from './message-input/hooks/use-session-references'
import { ReplyPreview } from './message-list/ReplyPreview'

// Re-export public types for external consumers
export type {
  ProjectAgentSuggestion,
  MessageInputHandle,
  MessageInputProps,
  SecureSessionPickerConfig,
  SessionContextModePickerConfig,
  SessionModelPickerConfig,
} from './message-input/types'
import type { MessageInputHandle, MessageInputProps } from './message-input/types'

export const MessageInput = forwardRef<MessageInputHandle, MessageInputProps>(function MessageInput(
  {
    onSend,
    onSubmitted,
    isLoading,
    onStop,
    disabled = false,
    placeholderOverride,
    agentLabel = 'agent',
    allowWhileLoading = false,
    environmentClient,
    agentId,
    draftKey,
    slashCommands,
    projectAgents,
    enableCodexMention = false,
    managerAgentId,
    replyTarget,
    onClearReplyTarget,
    sessionModelPicker,
    sessionContextModePicker,
    secureSessionPicker,
  },
  ref,
) {
  const blockedByLoading = isLoading && !allowWhileLoading
  const mentionListboxId = useId()

  // --- Draft persistence ---
  const {
    input,
    setInputWithDraft,
    attachedFiles,
    setAttachedFilesWithDraft,
    inputRef,
    attachedFilesRef,
  } = useDraft({ draftKey: draftKey ?? agentId })

  // --- Voice input ---
  const appendTranscription = useCallback(
    (transcribedText: string): boolean => {
      const trimmedText = transcribedText.trim()
      if (!trimmedText) return false

      const previousInput = inputRef.current
      let next: string
      if (!previousInput.trim()) {
        next = trimmedText
      } else {
        const separator = previousInput.endsWith('\n') || previousInput.endsWith(' ') ? '' : '\n'
        next = `${previousInput}${separator}${trimmedText}`
      }

      setInputWithDraft(next)
      return true
    },
    [inputRef, setInputWithDraft],
  )

  const voice = useVoiceInput({
    disabled,
    blockedByLoading,
    onTranscription: appendTranscription,
  })

  const isRecording = voice.isRecording
  const isTranscribingVoice = voice.isTranscribingVoice

  // --- Session references (sidebar drops) ---
  const { addSessionReference, resolveSessionReferenceAgentIds } = useSessionReferences({
    draftKey: draftKey ?? agentId,
    inputRef,
    setInputWithDraft,
  })

  // --- Composer (textarea, format mode, submit) ---
  const {
    textareaRef,
    overlayRef,
    fileInputRef,
    formatMode,
    toggleFormatMode,
    applyListFormatting,
    submitMessage,
    handleSubmit,
    syncOverlayScroll,
    canSubmit,
    restoreLastSubmission,
  } = useComposer({
    input,
    attachedFiles,
    disabled,
    blockedByLoading,
    isRecording,
    isTranscribingVoice,
    onSend,
    onSubmitted,
    setInputWithDraft,
    setAttachedFilesWithDraft,
    replyTarget,
    onAccepted: onClearReplyTarget,
    resolveSessionReferenceAgentIds,
  })

  // --- Slash commands ---
  const slash = useSlashCommands({
    slashCommands,
    setInputWithDraft,
    textareaRef,
  })

  // --- Mentions ---
  const mentions = useMentions({
    projectAgents,
    enableCodexMention,
    managerAgentId: managerAgentId ?? agentId,
    environmentClient,
    input,
    setInputWithDraft,
    textareaRef,
  })

  // --- Attachments ---
  const attachments = useAttachments({
    disabled,
    isRecording,
    attachedFilesRef,
    setAttachedFilesWithDraft,
    textareaRef,
  })

  // --- Imperative ref ---
  useImperativeHandle(
    ref,
    () => ({
      setInput: (value: string) => {
        setInputWithDraft(value)
        requestAnimationFrame(() => textareaRef.current?.focus())
      },
      focus: () => {
        textareaRef.current?.focus()
      },
      addFiles: attachments.addFiles,
      addTerminalContext: attachments.addTerminalContext,
      restoreLastSubmission,
      addSessionReference: (reference) => addSessionReference(reference, textareaRef.current),
    }),
    [
      attachments.addFiles,
      attachments.addTerminalContext,
      restoreLastSubmission,
      addSessionReference,
      setInputWithDraft,
      textareaRef,
    ],
  )

  // --- Mention cursor snap ---
  const snapCursorOutOfMention = useCallback(() => {
    const textarea = textareaRef.current
    if (!textarea) return
    const { selectionStart, selectionEnd } = textarea
    if (selectionStart !== selectionEnd) return
    const mention = findMentionContaining(input, selectionStart)
    if (mention && selectionStart > mention.start && selectionStart < mention.end) {
      const snapTo =
        selectionStart - mention.start <= mention.end - selectionStart
          ? mention.start
          : mention.end
      textarea.setSelectionRange(snapTo, snapTo)
    }
  }, [input, textareaRef])

  // --- Input change handler ---
  const handleInputChange = useCallback(
    (value: string) => {
      setInputWithDraft(value)

      // Check slash trigger first
      if (slash.checkSlashTrigger(value)) {
        mentions.setIsMentionMenuOpen(false)
        return
      }

      // Then check mention trigger
      mentions.checkMentionTrigger(value)
    },
    [setInputWithDraft, slash, mentions],
  )

  // --- Keyboard handler ---
  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    // @mention autocomplete keyboard handling
    if (mentions.isMentionMenuOpen) {
      if (mentions.mentionMenuStatus === 'list' && mentions.filteredMentions.length > 0) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          mentions.moveMentionSelection(1)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          mentions.moveMentionSelection(-1)
          return
        }
        if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
          event.preventDefault()
          const selected = mentions.filteredMentions[mentions.mentionSelectedIndex]
          if (selected) mentions.selectMention(selected)
          return
        }
      }

      if (
        event.key === 'Tab' ||
        (event.key === 'Enter' && !event.shiftKey && mentions.mentionMenuBlocksQuickSend)
      ) {
        event.preventDefault()
        return
      }

      if (event.key === 'Escape') {
        event.preventDefault()
        mentions.setIsMentionMenuOpen(false)
        return
      }
    }

    // Atomic backspace/delete for mention tokens
    if (mentions.hasMentionTokens && (event.key === 'Backspace' || event.key === 'Delete')) {
      const textarea = textareaRef.current
      if (textarea && textarea.selectionStart === textarea.selectionEnd) {
        const pos = textarea.selectionStart
        const mention = findMentionContaining(input, pos)
        if (mention) {
          const shouldDelete =
            event.key === 'Backspace' ? pos > mention.start : pos < mention.end
          if (shouldDelete) {
            event.preventDefault()
            const newValue = input.slice(0, mention.start) + input.slice(mention.end)
            setInputWithDraft(newValue)
            requestAnimationFrame(() => {
              textarea.setSelectionRange(mention.start, mention.start)
            })
            return
          }
        }
      }
    }

    // Slash command autocomplete keyboard handling
    if (slash.isSlashMenuOpen && slash.filteredSlashCommands.length > 0) {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        slash.setSlashSelectedIndex(
          (slash.slashSelectedIndex + 1) % slash.filteredSlashCommands.length,
        )
        return
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault()
        slash.setSlashSelectedIndex(
          (slash.slashSelectedIndex - 1 + slash.filteredSlashCommands.length) %
            slash.filteredSlashCommands.length,
        )
        return
      }
      if (event.key === 'Tab' || (event.key === 'Enter' && !event.shiftKey)) {
        event.preventDefault()
        const selected = slash.filteredSlashCommands[slash.slashSelectedIndex]
        if (selected) slash.selectSlashCommand(selected)
        return
      }
    }
    if (slash.isSlashMenuOpen && event.key === 'Escape') {
      event.preventDefault()
      slash.setIsSlashMenuOpen(false)
      return
    }

    // With no menu to close, Escape stops the running turn.
    if (event.key === 'Escape' && isLoading && onStop) {
      event.preventDefault()
      onStop()
      return
    }

    // Toggle format mode: Shift+Cmd+X (Mac) / Shift+Ctrl+X (Windows/Linux)
    if (event.key.toLowerCase() === 'x' && event.shiftKey && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      toggleFormatMode()
      return
    }

    if (formatMode) {
      // Format mode: Enter inserts newline (default), Ctrl/Cmd+Enter sends
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
        event.preventDefault()
        submitMessage()
      }
    } else {
      // Quick-send mode: Enter sends, Shift+Enter inserts newline
      if (event.key === 'Enter' && !event.shiftKey && !mentions.mentionMenuBlocksQuickSend) {
        event.preventDefault()
        submitMessage()
      }
    }
  }

  const mentionActiveDescendantId =
    mentions.mentionMenuStatus === 'list'
      ? mentionMenuActiveDescendantId(mentionListboxId, 'list', mentions.mentionSelectedIndex)
      : undefined

  const placeholder = placeholderOverride ?? (
    disabled
      ? 'Waiting for connection...'
      : allowWhileLoading && isLoading
        ? `Send another message to ${agentLabel}...`
        : `Message ${agentLabel}...`
  )

  return (
    <form onSubmit={handleSubmit} className="content-gutter sticky bottom-0 shrink-0 bg-transparent pb-3 pt-2 md:pb-4" data-tour="chat-input">
      <div className="content-column">
      {/* Slash command autocomplete dropdown */}
      {slash.isSlashMenuOpen ? (
        <SlashCommandMenu
          menuRef={slash.slashMenuRef}
          commands={slash.filteredSlashCommands}
          selectedIndex={slash.slashSelectedIndex}
          onSelect={slash.selectSlashCommand}
          onHover={slash.setSlashSelectedIndex}
          showEmpty={!!(slashCommands && slashCommands.length > 0 && slash.filteredSlashCommands.length === 0)}
        />
      ) : null}

      {/* @mention autocomplete dropdown */}
      {mentions.isMentionMenuOpen && mentions.mentionMenuStatus ? (
        <MentionMenu
          menuRef={mentions.mentionMenuRef}
          listboxId={mentionListboxId}
          status={mentions.mentionMenuStatus}
          mentions={mentions.filteredMentions}
          selectedIndex={mentions.mentionSelectedIndex}
          onSelect={mentions.selectMention}
          onHover={mentions.setMentionSelectedIndex}
          enableCodexMention={enableCodexMention}
          codexToolPicker={mentions.codexToolMode}
          codexCatalogErrorMessage={mentions.codexCatalogErrorMessage}
        />
      ) : null}

      <div className="glass-strong overflow-hidden rounded-[18px] transition-colors duration-150 focus-within:border-ring/50">
        {replyTarget ? (
          <div className="border-b border-hairline p-2 pb-1.5">
            <ReplyPreview target={replyTarget} onClear={onClearReplyTarget} />
          </div>
        ) : null}
        <AttachedFiles attachments={attachedFiles} onRemove={attachments.removeAttachment} />

        <div className="group flex flex-col">
          {formatMode && !isRecording ? (
            <div className="flex items-center gap-0.5 border-b border-hairline px-2 py-1">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-[30px] rounded-lg text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                onClick={() => applyListFormatting(toggleBulletList)}
                disabled={disabled}
                aria-label="Bullet list"
              >
                <List className="size-3.5" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-[30px] rounded-lg text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                onClick={() => applyListFormatting(toggleNumberedList)}
                disabled={disabled}
                aria-label="Numbered list"
              >
                <ListOrdered className="size-3.5" />
              </Button>
            </div>
          ) : null}

          {isRecording ? (
            <VoiceRecordingBar
              durationMs={voice.voiceRecordingDurationMs}
              waveformBars={voice.recordingWaveformBars}
              onStop={() => void voice.stopAndTranscribeRecording()}
              disabled={voice.voiceButtonDisabled}
            />
          ) : (
            <ComposerTextarea
              textareaRef={textareaRef}
              overlayRef={overlayRef}
              value={input}
              placeholder={placeholder}
              disabled={disabled}
              formatMode={formatMode}
              hasMentionTokens={mentions.hasMentionTokens}
              mentionAutocompleteOpen={mentions.isMentionMenuOpen}
              mentionListboxId={mentionListboxId}
              mentionActiveDescendantId={mentionActiveDescendantId}
              onChange={handleInputChange}
              onKeyDown={handleKeyDown}
              onPaste={attachments.handlePaste}
              onScroll={syncOverlayScroll}
              onSelect={mentions.hasMentionTokens ? snapCursorOutOfMention : undefined}
            />
          )}

          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={attachments.handleFileSelect}
            aria-label="Attach files"
          />

          <div className="@container/composer flex items-center justify-between gap-1.5 px-2.5 pb-2.5 pt-1.5">
            {/* One row. Secondary controls drop to icons below 50rem; send actions stay pinned right. */}
            <div className="flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {secureSessionPicker ? <SecureSessionPicker config={secureSessionPicker} /> : null}
              {sessionContextModePicker
                ? <SessionContextModePicker config={sessionContextModePicker} />
                : null}
              {sessionModelPicker ? <SessionModelPicker config={sessionModelPicker} /> : null}
            </div>

            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-[9px] transition-colors duration-150',
                  formatMode
                    ? 'bg-primary/10 text-primary hover:bg-primary/20 hover:text-primary'
                    : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                )}
                onClick={toggleFormatMode}
                disabled={disabled || isRecording}
                aria-label={formatMode ? 'Switch to quick-send mode' : 'Switch to format mode'}
                title={formatMode ? 'Quick-send mode (Enter to send)' : 'Format mode (Enter for new line)'}
              >
                <ALargeSmall className="size-4" strokeWidth={1.75} />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="size-8 rounded-[9px] text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground"
                onClick={() => fileInputRef.current?.click()}
                disabled={disabled || isRecording}
                aria-label="Attach files"
              >
                <Paperclip className="size-4" strokeWidth={1.75} />
              </Button>

              <Button
                type="button"
                variant="ghost"
                size="icon"
                className={cn(
                  'size-8 rounded-[9px] transition-colors duration-150',
                  isRecording
                    ? 'text-danger hover:bg-danger/10 hover:text-danger'
                    : 'text-muted-foreground hover:bg-foreground/[0.05] hover:text-foreground',
                )}
                onClick={voice.handleVoiceButtonClick}
                disabled={voice.voiceButtonDisabled}
                aria-label={isRecording ? 'Stop recording and transcribe' : 'Record voice input'}
              >
                {voice.isRequestingMicrophone || isTranscribingVoice ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : isRecording ? (
                  <Square className="size-3.5 fill-current" />
                ) : (
                  <Mic className="size-4" strokeWidth={1.75} />
                )}
              </Button>

              {isLoading && onStop ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="ml-1 size-[34px] shrink-0 rounded-[10px] bg-foreground/[0.08] text-foreground transition-colors duration-150 hover:bg-foreground/[0.14] active:scale-95"
                  onClick={onStop}
                  aria-label="Stop"
                  title="Stop (Esc)"
                >
                  <Square className="size-3.5 fill-current" />
                </Button>
              ) : null}

              <Button
                type="submit"
                disabled={!canSubmit}
                size="icon"
                className={cn(
                  'ml-1 size-[34px] shrink-0 rounded-[10px] transition-all duration-150',
                  canSubmit
                    ? 'bg-primary text-primary-foreground shadow-[inset_0_0_0_1px_rgb(255_255_255/0.12),0_8px_24px_-8px_var(--primary)] hover:bg-primary/90 active:scale-95'
                    : 'cursor-default bg-foreground/[0.06] text-subtle-foreground',
                )}
                aria-label="Send message"
              >
                <ArrowUp className="size-4" strokeWidth={2.2} />
              </Button>
            </div>
          </div>

          {voice.voiceError ? <p className="px-4 pb-2 text-xs text-danger">{voice.voiceError}</p> : null}
        </div>
      </div>

      <div
        className="mt-2 hidden justify-center px-1.5 font-mono text-[11px] text-subtle-foreground sm:flex"
        aria-hidden="true"
      >
        <span>
          {formatMode
            ? `${navigator.platform?.toLowerCase().includes('mac') ? '⌘' : 'Ctrl'}⏎ send · ⏎ newline`
            : '⏎ send · ⇧⏎ newline'}{' '}
          · / commands · @ mention
        </span>
      </div>
      </div>
    </form>
  )
})
