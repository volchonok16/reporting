type MaintenanceBannerProps = {
  message: string
  compact?: boolean
}

export default function MaintenanceBanner({ message, compact }: MaintenanceBannerProps) {
  const text = message.trim()
  if (!text) return null
  return (
    <div
      className={`maintenance-banner${compact ? ' maintenance-banner-compact' : ''}`}
      role="status"
    >
      <strong>Технические работы</strong>
      <p>{text}</p>
    </div>
  )
}
