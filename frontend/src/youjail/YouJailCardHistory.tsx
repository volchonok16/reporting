import OrgPhoto from '../org/OrgPhoto'
import type { YouJailCardEvent } from './types'

type YouJailCardHistoryProps = {
  events: YouJailCardEvent[]
}

export default function YouJailCardHistory({ events }: YouJailCardHistoryProps) {
  return (
    <details className="youjail-history-panel" open>
      <summary className="youjail-history-summary">
        <span>История изменений</span>
        <span className="youjail-history-count">{events.length}</span>
      </summary>
      {events.length === 0 ? (
        <p className="youjail-muted youjail-history-empty">Пока нет записей</p>
      ) : (
        <ol className="youjail-history-list">
          {events.map((event) => (
            <li key={event.id} className="youjail-history-item">
              <div className="youjail-history-item-head">
                <OrgPhoto
                  url={event.actorPhotoUrl}
                  name={event.actorName ?? '—'}
                  className="youjail-history-photo"
                  placeholderClassName="youjail-history-photo youjail-history-photo--placeholder"
                />
                <div className="youjail-history-item-main">
                  <p className="youjail-history-actor">{event.actorName ?? 'Система'}</p>
                  <p className="youjail-history-text">{event.summary}</p>
                </div>
                <time className="youjail-history-time" dateTime={event.createdAt}>
                  {new Date(event.createdAt).toLocaleString('ru-RU')}
                </time>
              </div>
            </li>
          ))}
        </ol>
      )}
    </details>
  )
}
