import { useEffect } from 'react'
import {
  boardNameLabel,
  businessGoalParagraphs,
  customerNameParts,
  formatEctReservation,
  formatLinkedEnvironmentStatus,
  formatPlannedDate,
} from './zniDisplay'
import type { ChangeRequest } from './zniTypes'

type ZniDetailModalProps = {
  item: ChangeRequest | null
  onClose: () => void
}

function BusinessGoalText({ text }: { text: string }) {
  const paragraphs = businessGoalParagraphs(text)
  return (
    <div className="zni-detail-text">
      {paragraphs.map((paragraph, index) => (
        <p key={index} className="zni-detail-paragraph">
          {paragraph}
        </p>
      ))}
    </div>
  )
}

export default function ZniDetailModal({ item, onClose }: ZniDetailModalProps) {
  useEffect(() => {
    if (!item) return
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [item, onClose])

  if (!item) return null

  const customerParts = customerNameParts(item.customerName)
  const boardStatus = item.boardColumn?.trim() || null
  const workflowStatus = item.status?.trim() || null

  return (
    <div className="zni-modal-overlay" onClick={onClose}>
      <div
        className="zni-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="zni-modal-title"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="zni-modal-header">
          <div>
            <p className="zni-modal-kicker">Карточка ЗНИ</p>
            <h2 id="zni-modal-title" className="zni-modal-title">
              {item.url ? (
                <a className="zni-link" href={item.url} target="_blank" rel="noreferrer">
                  {item.number}
                </a>
              ) : (
                item.number
              )}
            </h2>
          </div>
          <button type="button" className="zni-modal-close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        <div className="zni-modal-body">
          <div className="zni-modal-grid">
            <div className="zni-modal-field">
              <div className="zni-detail-label">Доска</div>
              <div className="zni-detail-value">{boardNameLabel(item.boardName, item.boardCode)}</div>
            </div>
            <div className="zni-modal-field zni-modal-field-wide">
              <div className="zni-detail-label">ЗНИ</div>
              <div className="zni-detail-value">{item.title}</div>
            </div>
            <div className="zni-modal-field zni-modal-field-wide">
              <div className="zni-detail-label">Цель и бизнес-смысл доработки</div>
              <div className="zni-detail-value">
                {item.businessGoal?.trim() ? <BusinessGoalText text={item.businessGoal} /> : '—'}
              </div>
            </div>
            <div className="zni-modal-field">
              <div className="zni-detail-label">Ценность для бизнеса</div>
              <div className="zni-detail-value">
                {item.businessValue != null ? item.businessValue : '—'}
              </div>
            </div>
            <div className="zni-modal-field">
              <div className="zni-detail-label">План. дата</div>
              <div className="zni-detail-value">{formatPlannedDate(item)}</div>
            </div>
            <div className="zni-modal-field">
              <div className="zni-detail-label">План квартала</div>
              <div className="zni-detail-value">{item.planQuarter || '—'}</div>
            </div>
            <div className="zni-modal-field">
              <div className="zni-detail-label">Бронь ЕЦТ</div>
              <div
                className={`zni-detail-value${
                  item.ectResourceReservation ? ' cell-reservation-yes' : ' cell-reservation-no'
                }`}
              >
                {formatEctReservation(item.ectResourceReservation)}
              </div>
            </div>
            <div className="zni-modal-field">
              <div className="zni-detail-label">Заказчик</div>
              <div className="zni-detail-value">
                {customerParts.length > 0 ? (
                  <span className="customer-name-stack">
                    {customerParts.map((part, index) => (
                      <span key={index} className="customer-name-line">
                        {part}
                      </span>
                    ))}
                  </span>
                ) : (
                  '—'
                )}
              </div>
            </div>
            <div className="zni-modal-field">
              <div className="zni-detail-label">Статус</div>
              <div className="zni-detail-value cell-status">
                <span className="status-board">{boardStatus || workflowStatus || '—'}</span>
                {boardStatus && workflowStatus && boardStatus !== workflowStatus ? (
                  <span className="status-workflow">{workflowStatus}</span>
                ) : null}
              </div>
            </div>
            {(item.linkedEnvironments?.length ?? 0) > 0 ? (
              <div className="zni-modal-field zni-modal-field-wide">
                <div className="zni-detail-label">Окружения</div>
                <div className="zni-detail-value">
                  <ul className="zni-linked-environments">
                    {item.linkedEnvironments!.map((env) => (
                      <li key={`${env.key}-${env.zniId}`}>
                        <span className="zni-linked-environment-label">{env.label}:</span>{' '}
                        {env.url ? (
                          <a className="zni-link" href={env.url} target="_blank" rel="noreferrer">
                            {env.zniId}
                          </a>
                        ) : (
                          env.zniId
                        )}
                        {' — '}
                        {formatLinkedEnvironmentStatus(env)}
                      </li>
                    ))}
                  </ul>
                </div>
              </div>
            ) : null}
          </div>

          {item.errors.length > 0 ? (
            <section className="zni-modal-errors">
              <h3 className="zni-detail-label">Ошибки</h3>
              <ul className="zni-modal-errors-list">
                {item.errors.map((error) => (
                  <li key={error.id}>
                    {error.url ? (
                      <a className="zni-link" href={error.url} target="_blank" rel="noreferrer">
                        {error.id}
                      </a>
                    ) : (
                      error.id
                    )}
                    {' — '}
                    {error.title}
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </div>
      </div>
    </div>
  )
}
