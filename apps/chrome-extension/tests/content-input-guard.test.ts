import { describe, expect, it } from 'vitest'
import {
  ExactSyntheticInputGuard,
  installExactTrustedInputListeners,
  type SyntheticTrustedEventSignature,
  type TrustedEventLike,
} from '../src/runtime/human-control.js'

class TrustedEventTargetFixture {
  private readonly listeners = new Map<string, Set<(event: Event) => void>>()

  addEventListener(type: string, listener: (event: Event) => void): void {
    const listeners = this.listeners.get(type) ?? new Set()
    listeners.add(listener)
    this.listeners.set(type, listeners)
  }

  removeEventListener(type: string, listener: (event: Event) => void): void {
    this.listeners.get(type)?.delete(listener)
  }

  dispatch(event: TrustedEventLike): void {
    for (const listener of this.listeners.get(event.type) ?? []) listener(event as unknown as Event)
  }
}

const noModifiers = { altKey: false, ctrlKey: false, metaKey: false, shiftKey: false }
const pointerSequence: SyntheticTrustedEventSignature[] = [
  {
    kind: 'pointer', phase: 'pointermove', clientX: 20, clientY: 30, button: -1, buttons: 0,
    pointerType: 'mouse', isPrimary: true, ...noModifiers,
  },
  {
    kind: 'pointer', phase: 'pointerdown', clientX: 20, clientY: 30, button: 0, buttons: 1,
    pointerType: 'mouse', isPrimary: true, ...noModifiers,
  },
  {
    kind: 'pointer', phase: 'pointerup', clientX: 20, clientY: 30, button: 0, buttons: 0,
    pointerType: 'mouse', isPrimary: true, ...noModifiers,
  },
]

function event(signature: SyntheticTrustedEventSignature, overrides: Record<string, unknown> = {}): TrustedEventLike {
  return { ...signature, type: signature.phase, isTrusted: true, ...overrides }
}

describe('singleton content-bridge trusted-input listeners', () => {

  it('interrupts immediately on coordinate/button mismatch and trusted interleaving', () => {
    const target = new TrustedEventTargetFixture()
    const guard = new ExactSyntheticInputGuard()
    const interrupted: string[] = []
    installExactTrustedInputListeners(target, guard, (input) => interrupted.push(input.type))

    guard.start('coordinate-mismatch', 2, pointerSequence)
    target.dispatch(event(pointerSequence[0]!, { clientX: 21 }))
    expect(interrupted).toEqual(['pointermove'])

    guard.start('interleaved-key', 3, pointerSequence)
    target.dispatch({
      type: 'keydown', isTrusted: true, key: 'x', code: 'KeyX', location: 0, repeat: false, ...noModifiers,
    })
    expect(interrupted).toEqual(['pointermove', 'keydown'])
  })
})
