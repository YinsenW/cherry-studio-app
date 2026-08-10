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
  private lastActivityAt: number | null = null
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

    this.resetWindow()
  }

  recordActivity(): void {
    if (!this.running || this.timedOut || this.pauseReasons.size > 0) return

    // Do not clear and recreate a native timer for every token. Provider
    // streams can deliver hundreds of parts per second on a fast model; a
    // timestamp write keeps that hot path constant-time. The existing timer
    // checks the timestamp at its deadline and reschedules only when needed.
    this.lastActivityAt = Date.now()
  }

  setIdleTimeoutMs(timeoutMs: number): void {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new Error('Agent inactivity timeout must be a positive finite number.')
    }

    this.idleTimeoutMs = timeoutMs
    if (this.running && !this.timedOut && this.pauseReasons.size === 0) {
      this.resetWindow()
    }
  }

  pause(reason: string): void {
    if (!this.running || this.timedOut) return
    this.pauseReasons.add(reason)
    this.clearTimer()
    this.lastActivityAt = null
  }

  resume(reason: string): void {
    if (!this.running || this.timedOut) return
    if (!this.pauseReasons.delete(reason) || this.pauseReasons.size > 0) return

    // Time spent paused is intentionally excluded from the inactivity
    // window. Resume with a full fresh budget.
    this.resetWindow()
  }

  dispose(): void {
    this.running = false
    this.clearTimer()
    this.subscription?.remove()
    this.subscription = null
    this.pauseReasons.clear()
    this.lastActivityAt = null
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

  private resetWindow(): void {
    this.lastActivityAt = Date.now()
    this.arm(this.idleTimeoutMs)
  }

  private arm(delayMs: number): void {
    this.clearTimer()
    this.timer = setTimeout(() => {
      if (!this.running || this.timedOut || this.pauseReasons.size > 0) return

      const lastActivityAt = this.lastActivityAt ?? Date.now()
      const remainingMs = this.idleTimeoutMs - (Date.now() - lastActivityAt)
      if (remainingMs > 0) {
        this.arm(remainingMs)
        return
      }

      this.timedOut = true
      this.timer = null
      this.onTimeout()
    }, delayMs)
  }

  private clearTimer(): void {
    if (this.timer === null) return
    clearTimeout(this.timer)
    this.timer = null
  }
}
