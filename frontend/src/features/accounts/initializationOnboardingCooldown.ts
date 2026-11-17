const INTRO_DISMISSED_AT_KEY = 'weft.initializationIntroDismissedAt'
const INTRO_COOLDOWN_MS = 14 * 24 * 60 * 60 * 1_000

let fallbackDismissedAt: number | null = null
let storageUnavailable = false

function currentTimestamp(value: number | null, now: number): boolean {
  return value !== null && Number.isFinite(value) && value > 0 && value <= now
}

function cooldownElapsed(dismissedAt: number | null, now: number): boolean {
  return !currentTimestamp(dismissedAt, now) || now - (dismissedAt ?? 0) >= INTRO_COOLDOWN_MS
}

function timestampFromStorage(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null
  const timestamp = Number(value)
  return Number.isSafeInteger(timestamp) ? timestamp : null
}

export function initializationIntroIsDue(): boolean {
  const now = Date.now()
  if (storageUnavailable) return cooldownElapsed(fallbackDismissedAt, now)
  try {
    const dismissedAt = timestampFromStorage(localStorage.getItem(INTRO_DISMISSED_AT_KEY))
    return cooldownElapsed(dismissedAt, now)
  } catch {
    storageUnavailable = true
    return cooldownElapsed(fallbackDismissedAt, now)
  }
}

export function dismissInitializationIntro(): void {
  const dismissedAt = Date.now()
  fallbackDismissedAt = dismissedAt
  if (storageUnavailable) return
  try {
    localStorage.setItem(INTRO_DISMISSED_AT_KEY, String(dismissedAt))
  } catch {
    storageUnavailable = true
  }
}

export function resetInitializationIntroCooldown(): void {
  fallbackDismissedAt = null
  if (storageUnavailable) return
  try {
    localStorage.removeItem(INTRO_DISMISSED_AT_KEY)
  } catch {
    storageUnavailable = true
  }
}
