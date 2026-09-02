let audioContext: AudioContext | null = null

function getAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null
  const AudioContextCtor = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioContextCtor) return null
  if (!audioContext) {
    audioContext = new AudioContextCtor()
  }
  return audioContext
}

function playTone(frequency: number, durationMs: number, volume: number): void {
  const ctx = getAudioContext()
  if (!ctx) return
  void ctx.resume().catch(() => undefined)

  const oscillator = ctx.createOscillator()
  const gain = ctx.createGain()
  oscillator.type = 'sine'
  oscillator.frequency.value = frequency
  gain.gain.setValueAtTime(volume, ctx.currentTime)
  gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + durationMs / 1000)
  oscillator.connect(gain)
  gain.connect(ctx.destination)
  oscillator.start()
  oscillator.stop(ctx.currentTime + durationMs / 1000)
}

export function playNotificationSound(kind: 'inbox' | 'popup' = 'inbox'): void {
  try {
    if (kind === 'popup') {
      playTone(880, 180, 0.07)
      window.setTimeout(() => playTone(1175, 220, 0.06), 120)
      return
    }
    playTone(740, 160, 0.05)
  } catch {
    /* браузер может заблокировать звук до жеста пользователя */
  }
}
