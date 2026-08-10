import type { AppStateStatus } from 'react-native'

import { AgentActivityWatchdog, type AgentAppState } from '../AgentActivityWatchdog'

class FakeAppState implements AgentAppState {
  currentState: AppStateStatus | null = 'active'
  private readonly listeners = new Set<(state: AppStateStatus) => void>()

  addEventListener(_type: 'change', listener: (state: AppStateStatus) => void) {
    this.listeners.add(listener)
    return { remove: () => this.listeners.delete(listener) }
  }

  change(nextState: AppStateStatus): void {
    this.currentState = nextState
    for (const listener of this.listeners) listener(nextState)
  }
}

describe('AgentActivityWatchdog', () => {
  beforeEach(() => jest.useFakeTimers())
  afterEach(() => jest.useRealTimers())

  it('allows a long session to continue while Agent events keep arriving', () => {
    const onTimeout = jest.fn()
    const watchdog = new AgentActivityWatchdog({ idleTimeoutMs: 120_000, onTimeout, appState: new FakeAppState() })

    watchdog.start()
    for (let index = 0; index < 10; index += 1) {
      jest.advanceTimersByTime(110_000)
      watchdog.recordActivity()
    }

    expect(onTimeout).not.toHaveBeenCalled()
    jest.advanceTimersByTime(120_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })

  it('does not count time spent in the background as inactivity', () => {
    const appState = new FakeAppState()
    const onTimeout = jest.fn()
    const onBackground = jest.fn()
    const watchdog = new AgentActivityWatchdog({ idleTimeoutMs: 120_000, onTimeout, onBackground, appState })

    watchdog.start()
    jest.advanceTimersByTime(100_000)
    appState.change('background')
    jest.advanceTimersByTime(30 * 60_000)

    expect(onTimeout).not.toHaveBeenCalled()
    expect(onBackground).toHaveBeenCalledTimes(1)

    appState.change('active')
    jest.advanceTimersByTime(119_999)
    expect(onTimeout).not.toHaveBeenCalled()
    jest.advanceTimersByTime(1)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })

  it('supports nested pauses for background state and user approval', () => {
    const appState = new FakeAppState()
    const onTimeout = jest.fn()
    const watchdog = new AgentActivityWatchdog({ idleTimeoutMs: 1_000, onTimeout, appState })

    watchdog.start()
    watchdog.pause('approval')
    appState.change('background')
    appState.change('active')
    jest.advanceTimersByTime(10_000)
    expect(onTimeout).not.toHaveBeenCalled()

    watchdog.resume('approval')
    jest.advanceTimersByTime(1_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })

  it('uses the longer tool inactivity budget without creating a total runtime cap', () => {
    const onTimeout = jest.fn()
    const watchdog = new AgentActivityWatchdog({ idleTimeoutMs: 120_000, onTimeout, appState: new FakeAppState() })

    watchdog.start()
    watchdog.setIdleTimeoutMs(5 * 60_000)
    jest.advanceTimersByTime(4 * 60_000)
    expect(onTimeout).not.toHaveBeenCalled()

    watchdog.recordActivity()
    jest.advanceTimersByTime(4 * 60_000)
    expect(onTimeout).not.toHaveBeenCalled()
    jest.advanceTimersByTime(60_000)
    expect(onTimeout).toHaveBeenCalledTimes(1)
    watchdog.dispose()
  })
})
