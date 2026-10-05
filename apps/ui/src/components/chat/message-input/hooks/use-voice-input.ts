import { useCallback, useEffect, useRef, useState } from 'react'
import { MAX_VOICE_RECORDING_DURATION_MS, useVoiceRecorder } from '@/hooks/use-voice-recorder'
import { useEnvironmentSettingsClient } from '@/hooks/use-environment-settings-client'
import { useOptionalEnvironmentContext } from '@/lib/origin-store/environment-provider'
import type { SettingsApiClient } from '@/components/settings/settings-api-client'
import { transcribeVoice } from '@/lib/voice-transcription-client'
import { OPENAI_KEY_REQUIRED_MESSAGE } from '../types'

async function hasConfiguredOpenAiKey(client: SettingsApiClient): Promise<boolean> {
  try {
    const response = await client.fetch('/api/settings/auth')
    if (!response.ok) return false

    const payload = (await response.json()) as {
      providers?: Array<{
        provider?: unknown
        configured?: unknown
      }>
    }

    if (!payload || !Array.isArray(payload.providers)) return false

    return payload.providers.some((provider) => {
      if (!provider || typeof provider !== 'object') return false
      const providerId =
        typeof provider.provider === 'string' ? provider.provider.trim().toLowerCase() : ''
      const configured = provider.configured === true
      return configured && providerId === 'openai-codex'
    })
  } catch {
    return false
  }
}

interface UseVoiceInputOptions {
  disabled: boolean
  blockedByLoading: boolean
  /** Called with transcribed text to append to the input. Return true if text was appended. */
  onTranscription: (text: string) => boolean
}

interface UseVoiceInputReturn {
  isRecording: boolean
  isRequestingMicrophone: boolean
  isTranscribingVoice: boolean
  voiceError: string | null
  voiceRecordingDurationMs: number
  recordingWaveformBars: number[]
  voiceButtonDisabled: boolean
  handleVoiceButtonClick: () => void
  stopAndTranscribeRecording: () => Promise<void>
}

/** Voice transcription is app-level: it uses this machine's (the primary environment's) OpenAI key. */
export function useVoiceInput({
  disabled,
  blockedByLoading,
  onTranscription,
}: UseVoiceInputOptions): UseVoiceInputReturn {
  const [isTranscribingVoice, setIsTranscribingVoice] = useState(false)
  const [voiceError, setVoiceError] = useState<string | null>(null)

  const {
    isRecording,
    isRequestingPermission: isRequestingMicrophone,
    durationMs: voiceRecordingDurationMs,
    waveformBars: recordingWaveformBars,
    startRecording,
    stopRecording,
  } = useVoiceRecorder()

  const client = useEnvironmentSettingsClient(useOptionalEnvironmentContext()?.primaryEnvironmentId)

  // Keep a stable ref to onTranscription to avoid re-creating callbacks
  const onTranscriptionRef = useRef(onTranscription)
  onTranscriptionRef.current = onTranscription

  const stopAndTranscribeRecording = useCallback(async () => {
    const recording = await stopRecording()
    if (!recording) {
      setVoiceError('Recording failed. Could not capture audio. Please try again.')
      return
    }

    if (!client) {
      setVoiceError('Voice transcription is unavailable: this machine is not connected.')
      return
    }

    setIsTranscribingVoice(true)
    setVoiceError(null)

    try {
      const result = await transcribeVoice(client, recording.blob)
      const appended = onTranscriptionRef.current(result.text)
      if (!appended) {
        setVoiceError('No speech detected. Try speaking a little louder.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Voice transcription failed.'
      setVoiceError(message)
    } finally {
      setIsTranscribingVoice(false)
    }
  }, [client, stopRecording])

  useEffect(() => {
    if (!isRecording || isTranscribingVoice) return
    if (voiceRecordingDurationMs < MAX_VOICE_RECORDING_DURATION_MS) return
    void stopAndTranscribeRecording()
  }, [isRecording, isTranscribingVoice, stopAndTranscribeRecording, voiceRecordingDurationMs])

  const startInlineRecording = useCallback(async () => {
    const hasOpenAiKey = client ? await hasConfiguredOpenAiKey(client) : false
    if (!hasOpenAiKey) {
      setVoiceError(OPENAI_KEY_REQUIRED_MESSAGE)
      return
    }

    try {
      await startRecording()
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Could not access your microphone.'
      setVoiceError(message)
    }
  }, [client, startRecording])

  const handleVoiceButtonClick = useCallback(() => {
    if (disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice) return

    setVoiceError(null)

    if (isRecording) {
      void stopAndTranscribeRecording()
      return
    }

    void startInlineRecording()
  }, [
    blockedByLoading,
    disabled,
    isRecording,
    isRequestingMicrophone,
    isTranscribingVoice,
    startInlineRecording,
    stopAndTranscribeRecording,
  ])

  const voiceButtonDisabled =
    disabled || blockedByLoading || isRequestingMicrophone || isTranscribingVoice

  return {
    isRecording,
    isRequestingMicrophone,
    isTranscribingVoice,
    voiceError,
    voiceRecordingDurationMs,
    recordingWaveformBars,
    voiceButtonDisabled,
    handleVoiceButtonClick,
    stopAndTranscribeRecording,
  }
}
