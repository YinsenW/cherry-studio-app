import { AppState, type AppStateStatus } from 'react-native'

type AppStateSubscription = {
  remove: () => void
}

export type AgentAppState = {
  currentState: AppStateStatus | null
  addEventListener: (type: 'change', listener: (state: AppStateStatus) => void) => AppStateSubscription
}

export type AgentActivityWatchdogOptions = {
  idleTimeoutMs: number
  onTimeout: () => void
  onBackground?: () => void
  appState?: AgentAppState
}

/**
 * An inactivity watchdog for a single Agent run.
 *
 * Unlike a wall-clock session timeout, every observable Agent event renews
 * the deadline. Background and approval time can be excluded explicitly so
 * a suspended JS runtime never wakes up into an already-expired timer.
 */
export class AgentActivityWatchdog {
  private readonly appState: AgentAppState
  private readonly onTimeout: () => void
  private readonly onBackground?: () => void
  private idleTimeoutMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private subscription: AppStateSubscription | null = null
  private readonly pauseReasons = new Set<string>()
  private running = false
  private timedOut = false

  constructor(options: AgentActivityWatchdogOptions) {
    if (!Number.isFinite(options.idleTimeoutMs) || options.idleTimeoutMs <= 0) {
      throw new Error('Agent inactivity timeout must be a positive finite number.')
    }
    this.idleTimeoutMs = options.idleTimeoutMs
    this.onTimeout = options.onTimeout
    this.onBackground = options.onBackground
    this.appState = options.appState ?? AppState
  }

  start(): void {
    if (this.running) return

    this.running = true
    this.subscription = this.appState.addEventListener('change', this.handleAppStateChange)

    if (this.appState.currentState && this.appState.currentState !== 'active') {
      this.pauseReasons.add('app-background')
      this.onBackground?.()
      return
    }

    this.arm()
  }

  recordActivity(): void {
    if (!this.running || this.timedOut || this.pauseReasons.size > 0) return
    this.arm()
  }

  setIdleTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Agent inactivity timeout must be a positive finite number.')
    }

    this.idleTimeoutMs = timeoutMs
    this.recordActivity()
  }

  pause(reason: string): void {
    if (!this.running || this.timedOut) return
    this.pauseReasons.add(reason)
    this.clearTimer()
  }

  resume(reason: string): void {
    if (!this.running || this.timedOut) return
    if (!this.pauseReasons.delete(reason) || this.pauseReasons.size > 0) return

    // Time spent paused is intentionally excluded from the inactivity
    // window. Resume with a full fresh budget.
    this.arm()
  }

  dispose(): void {
    this.running = false
    this.clearTimer()
    this.subscription?.remove()
    this.subscription = null
    this.pauseReasons.clear()
  }

  private readonly handleAppStateChange = (nextState: AppStateStatus): void => {
    if (nextState === 'active') {
      this.resume('app-background')
      return
    }

    const wasAlreadyBackgrounded = this.pauseReasons.has('app-background')
    this.pause('app-background')
    if (!wasAlreadyBackgrounded) {
      this.onBackground?.()
    }
  }

  private arm(): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      if (!this.running || this.timedOut || this.pauseReasons.size > 0) return
      this.timedOut = true
      this.timer = null
      this.onTimeout()
    }, this.idleTimeoutMs)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
