import { useCallback, useMemo, useState } from 'react'
import { CheckSquare, CircleAlert, Square } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { cn } from '@/lib/utils'
import { validateChoiceAnswers, type ChoiceAnswer, type ChoiceQuestion } from '@forge/protocol'

interface ChoiceRequestCardProps {
  choiceId: string
  agentId: string
  questions: ChoiceQuestion[]
  onSubmit: (agentId: string, choiceId: string, answers: ChoiceAnswer[]) => void
  onCancel: (agentId: string, choiceId: string) => void
}

interface QuestionSelectionState {
  selectedOptionIds: string[]
  text: string
}

export function ChoiceRequestCard({
  choiceId,
  agentId,
  questions,
  onSubmit,
  onCancel,
}: ChoiceRequestCardProps) {
  const [selections, setSelections] = useState<Record<string, QuestionSelectionState>>(() => {
    const initial: Record<string, QuestionSelectionState> = {}
    for (const question of questions) {
      initial[question.id] = { selectedOptionIds: [], text: '' }
    }
    return initial
  })

  const toggleOption = useCallback(
    (questionId: string, optionId: string, multiSelect: boolean) => {
      setSelections((previous) => {
        const current = previous[questionId]
        if (!current) {
          return previous
        }

        let newIds: string[]
        if (multiSelect) {
          if (current.selectedOptionIds.includes(optionId)) {
            newIds = current.selectedOptionIds.filter((id) => id !== optionId)
          } else {
            const question = questions.find((q) => q.id === questionId)
            const max = question?.maxSelections
            if (max && current.selectedOptionIds.length >= max) {
              return previous
            }
            newIds = [...current.selectedOptionIds, optionId]
          }
        } else {
          // Single-select radio behavior: click selects, click again deselects, click different replaces
          newIds = current.selectedOptionIds.includes(optionId) ? [] : [optionId]
        }

        return {
          ...previous,
          [questionId]: {
            ...current,
            selectedOptionIds: newIds,
          },
        }
      })
    },
    [questions],
  )

  const setText = useCallback((questionId: string, text: string) => {
    setSelections((previous) => {
      const current = previous[questionId]
      if (!current) {
        return previous
      }

      return {
        ...previous,
        [questionId]: {
          ...current,
          text,
        },
      }
    })
  }, [])

  const [isSubmitting, setIsSubmitting] = useState(false)

  const answers = useMemo<ChoiceAnswer[]>(
    () => questions.map((question) => {
      const selection = selections[question.id] ?? { selectedOptionIds: [], text: '' }
      const isFreeformOnly = question.isOther || !question.options?.length
      return {
        questionId: question.id,
        selectedOptionIds: isFreeformOnly ? [] : selection.selectedOptionIds,
        text: selection.text.trim() || undefined,
      }
    }),
    [questions, selections],
  )

  const isValid = useMemo(
    () => validateChoiceAnswers(questions, answers) === null,
    [questions, answers],
  )

  const handleSubmit = useCallback(() => {
    if (isSubmitting || !isValid) return
    setIsSubmitting(true)

    onSubmit(agentId, choiceId, answers)
  }, [isSubmitting, isValid, agentId, choiceId, onSubmit, answers])

  return (
    <div className="glass rise-in max-w-2xl space-y-4 rounded-xl border-attention/25 bg-attention-surface p-4">
      <div className="flex items-center gap-2 text-attention">
        <CircleAlert className="size-[13px]" strokeWidth={2} aria-hidden="true" />
        <span className="eyebrow !text-attention">Decision needed</span>
      </div>

      {questions.map((question) => (
        <div key={question.id} className="space-y-2">
          {question.header ? (
            <h4 className="text-sm font-medium text-foreground">{question.header}</h4>
          ) : null}
          <p className="text-[14.5px] text-foreground">{question.question}</p>

          {question.multiSelect && (
            <span className="text-xs text-muted-foreground">
              Select {question.minSelections ? `at least ${question.minSelections}` : 'one or more'}
              {question.maxSelections ? `, up to ${question.maxSelections}` : ''}
            </span>
          )}

          {question.options && !question.isOther ? (
            <div className="flex flex-col gap-1.5">
              {question.options.map((option, optionIndex) => {
                const isSelected =
                  selections[question.id]?.selectedOptionIds.includes(option.id) ?? false

                return (
                  <button
                    key={option.id}
                    type="button"
                    aria-pressed={isSelected}
                    onClick={() =>
                      toggleOption(question.id, option.id, question.multiSelect ?? false)
                    }
                    className={cn(
                      'w-full rounded-[10px] border px-3 py-2.5 text-left text-sm transition-colors duration-150 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50',
                      isSelected
                        ? 'border-foreground/15 bg-foreground/[0.07] text-foreground shadow-[inset_0_1px_0_var(--glass-highlight)]'
                        : 'border-hairline bg-transparent hover:bg-foreground/[0.05]',
                    )}
                  >
                    <span className="flex items-center gap-3">
                      {question.multiSelect ? (
                        isSelected ? (
                          <CheckSquare className="size-4 shrink-0 text-primary" strokeWidth={1.75} />
                        ) : (
                          <Square className="size-4 shrink-0 text-subtle-foreground" strokeWidth={1.75} />
                        )
                      ) : (
                        <span aria-hidden="true" className="w-3.5 shrink-0 font-mono text-[11px] text-subtle-foreground">
                          {optionIndex + 1}
                        </span>
                      )}
                      <span className="font-medium text-foreground">{option.label}</span>
                      {option.recommended && (
                        <span className="ml-auto rounded-full bg-primary/15 px-2 py-0.5 text-[11px] font-normal text-primary">
                          Recommended
                        </span>
                      )}
                    </span>
                    {option.description ? (
                      <span
                        className={cn(
                          'mt-0.5 block text-xs text-muted-foreground',
                          question.multiSelect ? 'ml-7' : 'ml-[26px]',
                        )}
                      >
                        {option.description}
                      </span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}

          <Textarea
            placeholder={
              question.placeholder ??
              (question.isOther || !question.options?.length
                ? 'Type your answer...'
                : 'Add notes (optional)...')
            }
            value={selections[question.id]?.text ?? ''}
            onChange={(event) => setText(question.id, event.target.value)}
            className="min-h-[60px] text-sm"
          />
        </div>
      ))}

      <div className="flex gap-2">
        <Button size="sm" onClick={handleSubmit} disabled={!isValid || isSubmitting}>
          {isSubmitting ? 'Submitting\u2026' : 'Submit'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onCancel(agentId, choiceId)}
          disabled={isSubmitting}
        >
          Skip
        </Button>
      </div>
    </div>
  )
}
