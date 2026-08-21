import { useCallback, useEffect, useRef, useState } from 'react'
import { getJson, postJson } from './api'
import { notifyInfo, notifyProblem, notifySuccess, notifyWarning } from './toast'
import type { Department } from './org/types'

type AppNotification = {
  id: number
  title: string
  body: string
  audience: 'all' | 'users' | 'departments'
  createdAt: string
  readAt?: string | null
  isRead: boolean
}

type OrgUserOption = {
  id: number
  email: string
  employeeName?: string | null
  status: string
}

type NotificationBellProps = {
  canManageOrg: boolean
  enabled: boolean
}

type Audience = 'all' | 'users' | 'departments'

const POLL_MS = 30000

function formatWhen(value: string): string {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return date.toLocaleString('ru-RU', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

export default function NotificationBell({ canManageOrg, enabled }: NotificationBellProps) {
  const [open, setOpen] = useState(false)
  const [composeOpen, setComposeOpen] = useState(false)
  const [items, setItems] = useState<AppNotification[]>([])
  const [unread, setUnread] = useState(0)
  const [loading, setLoading] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [audience, setAudience] = useState<Audience>('all')
  const [users, setUsers] = useState<OrgUserOption[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [selectedUserIds, setSelectedUserIds] = useState<number[]>([])
  const [selectedDepartmentIds, setSelectedDepartmentIds] = useState<number[]>([])
  const [sending, setSending] = useState(false)
  const [pickerLoading, setPickerLoading] = useState(false)

  const refreshUnread = useCallback(async () => {
    if (!enabled) return
    try {
      const data = await getJson<{ count: number }>('/api/notifications/unread-count')
      setUnread(data.count)
    } catch {
      /* тихий poll */
    }
  }, [enabled])

  const claimPopups = useCallback(async () => {
    if (!enabled) return
    try {
      const popups = await getJson<AppNotification[]>('/api/notifications/popup')
      for (const item of popups) {
        notifyInfo(`${item.title}: ${item.body}`)
      }
      if (popups.length > 0) {
        await refreshUnread()
      }
    } catch {
      /* тихий poll */
    }
  }, [enabled, refreshUnread])

  const loadInbox = useCallback(async () => {
    if (!enabled) return
    setLoading(true)
    try {
      const data = await getJson<AppNotification[]>('/api/notifications?limit=40')
      setItems(data)
      setUnread(data.filter((item) => !item.isRead).length)
    } catch (err) {
      notifyProblem(err, 'Не удалось загрузить уведомления')
    } finally {
      setLoading(false)
    }
  }, [enabled])

  useEffect(() => {
    if (!enabled) {
      setUnread(0)
      setItems([])
      return
    }
    void refreshUnread()
    void claimPopups()
    const timer = window.setInterval(() => {
      void refreshUnread()
      void claimPopups()
    }, POLL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, refreshUnread, claimPopups])

  useEffect(() => {
    if (!open || !enabled) return
    void loadInbox()
  }, [open, enabled, loadInbox])

  useEffect(() => {
    if (!open) return
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false)
      }
    }
    document.addEventListener('mousedown', onPointerDown)
    return () => document.removeEventListener('mousedown', onPointerDown)
  }, [open])

  useEffect(() => {
    if (!composeOpen || !canManageOrg) return
    setPickerLoading(true)
    void Promise.all([
      getJson<OrgUserOption[]>('/api/org/users'),
      getJson<Department[]>('/api/org/departments'),
    ])
      .then(([userRows, deptRows]) => {
        setUsers(userRows.filter((row) => row.status === 'active'))
        setDepartments(deptRows.filter((row) => row.isActive))
      })
      .catch((err) => notifyProblem(err, 'Не удалось загрузить получателей'))
      .finally(() => setPickerLoading(false))
  }, [composeOpen, canManageOrg])

  const markOneRead = async (item: AppNotification) => {
    if (item.isRead) return
    try {
      const updated = await postJson<AppNotification>(`/api/notifications/${item.id}/read`, {})
      setItems((current) => current.map((row) => (row.id === updated.id ? updated : row)))
      setUnread((count) => Math.max(0, count - 1))
    } catch (err) {
      notifyProblem(err, 'Не удалось отметить прочитанным')
    }
  }

  const markAll = async () => {
    try {
      await postJson<{ updated: number }>('/api/notifications/read-all', {})
      setItems((current) =>
        current.map((row) => ({ ...row, isRead: true, readAt: row.readAt ?? new Date().toISOString() })),
      )
      setUnread(0)
    } catch (err) {
      notifyProblem(err, 'Не удалось отметить все прочитанными')
    }
  }

  const toggleId = (list: number[], id: number): number[] =>
    list.includes(id) ? list.filter((value) => value !== id) : [...list, id]

  const sendNotification = async () => {
    if (!canManageOrg) {
      notifyWarning('Отправлять уведомления может только администратор')
      return
    }
    const trimmedTitle = title.trim()
    const trimmedBody = body.trim()
    if (!trimmedTitle || !trimmedBody) {
      notifyWarning('Заполните заголовок и текст')
      return
    }
    if (audience === 'users' && selectedUserIds.length === 0) {
      notifyWarning('Выберите хотя бы одного пользователя')
      return
    }
    if (audience === 'departments' && selectedDepartmentIds.length === 0) {
      notifyWarning('Выберите хотя бы один отдел')
      return
    }
    setSending(true)
    try {
      const result = await postJson<{ id: number; recipientCount: number }>('/api/notifications', {
        title: trimmedTitle,
        body: trimmedBody,
        audience,
        orgUserIds: audience === 'users' ? selectedUserIds : [],
        departmentIds: audience === 'departments' ? selectedDepartmentIds : [],
      })
      notifySuccess(`Отправлено получателям: ${result.recipientCount}`)
      setComposeOpen(false)
      setTitle('')
      setBody('')
      setAudience('all')
      setSelectedUserIds([])
      setSelectedDepartmentIds([])
      void claimPopups()
      void refreshUnread()
      if (open) void loadInbox()
    } catch (err) {
      notifyProblem(err, 'Не удалось отправить уведомление')
    } finally {
      setSending(false)
    }
  }

  if (!enabled) return null

  return (
    <>
      <div className={`notification-bell${open ? ' is-open' : ''}`} ref={rootRef}>
        <button
          type="button"
          className="notification-bell-btn"
          aria-expanded={open}
          aria-label={unread > 0 ? `Уведомления, непрочитанных: ${unread}` : 'Уведомления'}
          title="Уведомления"
          onClick={() => setOpen((current) => !current)}
        >
          <span className="notification-bell-icon" aria-hidden>
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8">
              <path d="M15 17H9a4 4 0 0 1-4-4V10a7 7 0 0 1 14 0v3a4 4 0 0 1-4 4Z" />
              <path d="M10 17a2 2 0 0 0 4 0" />
              <path d="M12 3v1" />
            </svg>
          </span>
          {unread > 0 ? <span className="notification-bell-badge">{unread > 99 ? '99+' : unread}</span> : null}
        </button>

        {open ? (
          <div className="notification-bell-panel" role="dialog" aria-label="Уведомления">
            <div className="notification-bell-panel-head">
              <strong>Уведомления</strong>
              <div className="notification-bell-panel-actions">
                {canManageOrg ? (
                  <button
                    type="button"
                    className="btn-ghost notification-bell-action"
                    onClick={() => {
                      setOpen(false)
                      setComposeOpen(true)
                    }}
                  >
                    Отправить
                  </button>
                ) : null}
                {unread > 0 ? (
                  <button type="button" className="btn-ghost notification-bell-action" onClick={() => void markAll()}>
                    Прочитать все
                  </button>
                ) : null}
              </div>
            </div>
            <div className="notification-bell-list">
              {loading && items.length === 0 ? <p className="notification-bell-empty">Загрузка…</p> : null}
              {!loading && items.length === 0 ? (
                <p className="notification-bell-empty">Пока нет сообщений</p>
              ) : null}
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className={`notification-bell-item${item.isRead ? '' : ' is-unread'}`}
                  onClick={() => void markOneRead(item)}
                >
                  <span className="notification-bell-item-title">{item.title}</span>
                  <span className="notification-bell-item-body">{item.body}</span>
                  <span className="notification-bell-item-meta">{formatWhen(item.createdAt)}</span>
                </button>
              ))}
            </div>
          </div>
        ) : null}
      </div>

      {composeOpen ? (
        <div className="notification-compose-backdrop" role="presentation" onClick={() => setComposeOpen(false)}>
          <div
            className="notification-compose-modal"
            role="dialog"
            aria-modal="true"
            aria-label="Отправить уведомление"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="notification-compose-head">
              <h2>Новое уведомление</h2>
              <button type="button" className="btn-ghost" onClick={() => setComposeOpen(false)}>
                Закрыть
              </button>
            </div>

            <label className="notification-compose-field">
              <span>Заголовок</span>
              <input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={255} />
            </label>

            <label className="notification-compose-field">
              <span>Текст</span>
              <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={4} maxLength={4000} />
            </label>

            <fieldset className="notification-compose-audience">
              <legend>Кому</legend>
              <label>
                <input
                  type="radio"
                  name="notification-audience"
                  checked={audience === 'all'}
                  onChange={() => setAudience('all')}
                />
                Всем пользователям
              </label>
              <label>
                <input
                  type="radio"
                  name="notification-audience"
                  checked={audience === 'users'}
                  onChange={() => setAudience('users')}
                />
                Выбранным пользователям
              </label>
              <label>
                <input
                  type="radio"
                  name="notification-audience"
                  checked={audience === 'departments'}
                  onChange={() => setAudience('departments')}
                />
                По отделам
              </label>
            </fieldset>

            {audience === 'users' ? (
              <div className="notification-compose-picker">
                {pickerLoading ? <p>Загрузка пользователей…</p> : null}
                {!pickerLoading && users.length === 0 ? <p>Нет активных пользователей</p> : null}
                {users.map((user) => (
                  <label key={user.id} className="notification-compose-option">
                    <input
                      type="checkbox"
                      checked={selectedUserIds.includes(user.id)}
                      onChange={() => setSelectedUserIds((current) => toggleId(current, user.id))}
                    />
                    <span>
                      {user.employeeName ? `${user.employeeName} · ` : ''}
                      {user.email}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}

            {audience === 'departments' ? (
              <div className="notification-compose-picker">
                {pickerLoading ? <p>Загрузка отделов…</p> : null}
                {!pickerLoading && departments.length === 0 ? <p>Нет активных отделов</p> : null}
                {departments.map((department) => (
                  <label key={department.id} className="notification-compose-option">
                    <input
                      type="checkbox"
                      checked={selectedDepartmentIds.includes(department.id)}
                      onChange={() =>
                        setSelectedDepartmentIds((current) => toggleId(current, department.id))
                      }
                    />
                    <span>
                      {department.name}
                      {department.memberCount ? ` (${department.memberCount})` : ''}
                    </span>
                  </label>
                ))}
              </div>
            ) : null}

            <div className="notification-compose-footer">
              <button type="button" className="btn-secondary" onClick={() => setComposeOpen(false)} disabled={sending}>
                Отмена
              </button>
              <button type="button" className="btn-primary" onClick={() => void sendNotification()} disabled={sending}>
                {sending ? 'Отправка…' : 'Отправить'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  )
}
