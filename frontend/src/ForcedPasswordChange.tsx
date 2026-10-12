import { useState } from 'react'
import { postJson } from './api'
import { notifyProblem, notifySuccess } from './toast'
import PasswordInput from './org/PasswordInput'
import './org/org.css'

const TEMPORARY_PASSWORD = '12345678'

type ForcedPasswordChangeProps = {
  onCompleted: () => void
}

export default function ForcedPasswordChange({ onCompleted }: ForcedPasswordChangeProps) {
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('')
  const [saving, setSaving] = useState(false)
  const [localError, setLocalError] = useState<string | null>(null)

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (saving) return

    const next = newPassword.trim()
    if (!next) {
      setLocalError('Задайте новый пароль.')
      return
    }
    if (next === TEMPORARY_PASSWORD) {
      setLocalError('Нельзя оставить временный пароль 12345678. Задайте другой пароль.')
      return
    }
    if (newPassword !== newPasswordRepeat) {
      setLocalError('Новые пароли не совпадают.')
      return
    }
    if (next.length < 8) {
      setLocalError('Новый пароль должен быть не короче 8 символов.')
      return
    }

    setLocalError(null)
    setSaving(true)
    try {
      await postJson('/api/profile/password', {
        currentPassword,
        newPassword,
        newPasswordRepeat,
      })
      notifySuccess('Пароль изменён.')
      onCompleted()
    } catch (err) {
      notifyProblem(err, 'Ошибка смены пароля')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="org-modal-backdrop forced-password-backdrop" role="dialog" aria-modal="true">
      <div className="org-modal forced-password-modal" onClick={(e) => e.stopPropagation()}>
        <header className="org-modal-header">
          <h2>Смена пароля обязательна</h2>
        </header>
        <p className="org-hint">
          Администратор запросил смену пароля. Пока новый пароль не задан (и он не равен{' '}
          <strong>12345678</strong>), продолжить работу нельзя.
        </p>
        <form className="org-form" onSubmit={(e) => void handleSubmit(e)}>
          <label>
            Текущий пароль
            <PasswordInput
              value={currentPassword}
              onChange={setCurrentPassword}
              autoComplete="current-password"
              required
            />
          </label>
          <label>
            Новый пароль
            <PasswordInput
              value={newPassword}
              onChange={(value) => {
                setNewPassword(value)
                setLocalError(null)
              }}
              autoComplete="new-password"
              required
            />
          </label>
          <label>
            Повторите пароль
            <PasswordInput
              value={newPasswordRepeat}
              onChange={(value) => {
                setNewPasswordRepeat(value)
                setLocalError(null)
              }}
              autoComplete="new-password"
              required
            />
          </label>
          {localError ? <p className="org-form-error">{localError}</p> : null}
          <footer className="org-modal-actions">
            <button type="submit" className="btn-primary" disabled={saving}>
              {saving ? 'Сохранение…' : 'Сменить пароль'}
            </button>
          </footer>
        </form>
      </div>
    </div>
  )
}
