const VOICE_APP_URL =
  (import.meta.env.VITE_VOICE_APP_URL as string | undefined)?.trim() || 'http://localhost:3100'

export default function Voice() {
  return (
    <div className="voice-embed">
      <iframe
        className="voice-embed-frame"
        title="Voice"
        src={VOICE_APP_URL}
        allow="clipboard-read; clipboard-write"
      />
    </div>
  )
}
