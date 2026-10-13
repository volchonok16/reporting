import { useEffect, useState } from 'react'
import { getJson, patchJson, postJson } from './api'
import { notifyProblem, notifySuccess, notifyWarning } from './toast'
import './org/org.css'

type MaintenanceData = {
  enabled: boolean
  message: string
  allowAdmin: boolean
  sessionCount: number
}

type MaintenancePanelProps = {
  onClose: () => void
  onChanged: () => void
}

const DEFAULT_HINT =
  'Проводятся технические работы. Вход временно недоступен. Попробуйте позже.'

export default function MaintenancePanel({ onClose, onChanged }: MaintenancePanelProps) {
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [enabled, setEnabled] = useState(false)
  const [message, setMessage] = useState('')
  const [allowAdmin, setAllowAdmin] = useState(true)
  const [sessionCount, setSessionCount] = useState(0)

  const load = async () => {
    setLoading(true)
    try {
      const data = await getJson<MaintenanceData>('/api/admin/maintenance')
      setEnabled(Boolean(data.enabled))
      setMessage(data.message ?? '')
      setAllowAdmin(data.allowAdmin !== false)
      setSessionCount(typeof data.sessionCount === 'number' ? data.sessionCount : 0)
    } catch (err) {
      notifyProblem(err, 'Не удалось загрузить режим обслуживания')
      onClose()
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void load()
  }, [])

  const save = async (opts?: { revokeOtherSessions?: boolean }) => {
    setSaving(true)
    try {
      const data = await patchJson<MaintenanceData>('/api/admin/maintenance', {
        enabled,
        message,
        allowAdmin,
        revokeOtherSessions: Boolean(opts?.revokeOtherSessions),
      })
      setEnabled(Boolean(data.enabled))
      setMessage(data.message ?? '')
      setAllowAdmin(data.allowAdmin !== false)
      setSessionCount(typeof data.sessionCount === 'number' ? data.sessionCount : 0)
      notifySuccess(
        opts?.revokeOtherSessions
          ? 'Режим сохранён, остальные сессии завершены.'
          : 'Режим обслуживания сохранён.',
      )
      onChanged()
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить')
    } finally {
      setSaving(false)
    }
  }

  const revokeAll = async () => {
    if (
      !window.confirm(
        `Завершить все сессии кроме вашей? Сейчас активных сессий: ${sessionCount}.`,
      )
    ) {
      return
    }
    setSaving(true)
    try {
      const data = await postJson<{ revoked: number }>(
        '/api/admin/sessions/revoke-all?keepCurrent=true',
        {},
      )
      notifySuccess(`Завершено сессий: ${data.revoked}.`)
      await load()
      onChanged()
    } catch (err) {
      notifyProblem(err, 'Не удалось завершить сессии')
    } finally {
      setSaving(false)
    }
  }

  const enableAndKick = async () => {
    if (!enabled) {
      notifyWarning('Включите режим обслуживания или сохраните отдельно.')
    }
    if (
      !window.confirm(
        'Включить обслуживание и завершить сессии всех пользователей (кроме вас)?',
      )
    ) {
      return
    }
    setEnabled(true)
    setSaving(true)
    try {
      const data = await patchJson<MaintenanceData>('/api/admin/maintenance', {
        enabled: true,
        message: message.trim() || DEFAULT_HINT,
        allowAdmin,
        revokeOtherSessions: true,
      })
      setEnabled(Boolean(data.enabled))
      setMessage(data.message ?? '')
      setAllowAdmin(data.allowAdmin !== false)
      setSessionCount(typeof data.sessionCount === 'number' ? data.sessionCount : 0)
      notifySuccess('Обслуживание включено, пользователи разлогинены.')
      onChanged()
    } catch (err) {
      notifyProblem(err, 'Не удалось включить обслуживание')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="org-modal-backdrop" onClick={onClose}>
      <div className="org-modal maintenance-panel-modal" onClick={(e) => e.stopPropagation()}>
        <header className="org-modal-header">
          <h2>Обслуживание</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Закрыть
          </button>
        </header>

        {loading ? (
          <p>Загрузка…</p>
        ) : (
          <div className="org-form">
            <p className="org-hint">
              Активных сессий: <strong>{sessionCount}</strong>. Сообщение видят все на экране входа
              и при блокировке. Админы могут входить, если разрешено ниже.
            </p>

            <label className="org-checkbox">
              <input
                type="checkbox"
                checked={enabled}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              Запретить авторизацию обычным пользователям
            </label>

            <label className="org-checkbox">
              <input
                type="checkbox"
                checked={allowAdmin}
                onChange={(e) => setAllowAdmin(e.target.checked)}
              />
              Разрешить вход администраторам
            </label>

            <label>
              Сообщение пользователям
              <textarea
                rows={4}
                value={message}
                placeholder={DEFAULT_HINT}
                onChange={(e) => setMessage(e.target.value)}
              />
            </label>

            <footer className="org-modal-actions maintenance-panel-actions">
              <button
                type="button"
                className="btn-primary"
                disabled={saving}
                onClick={() => void save()}
              >
                {saving ? 'Сохранение…' : 'Сохранить'}
              </button>
              <button
                type="button"
                className="btn-secondary"
                disabled={saving}
                onClick={() => void enableAndKick()}
              >
                Включить и разлогинить всех
              </button>
              <button
                type="button"
                className="btn-ghost"
                disabled={saving}
                onClick={() => void revokeAll()}
              >
                Только массовый logout
              </button>
            </footer>
          </div>
        )}
      </div>
    </div>
  )
}
