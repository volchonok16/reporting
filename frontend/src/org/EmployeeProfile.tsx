import { useEffect, useState } from 'react'
import { getJson, patchJson, postForm, postJson } from '../api'
import type { ProfileData } from './types'

type EmployeeProfileProps = {
  onClose: () => void
}

export default function EmployeeProfile({ onClose }: EmployeeProfileProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [fullName, setFullName] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const loadProfile = async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await getJson<ProfileData>('/api/profile')
      setProfile(data)
      setFullName(data.employee?.fullName ?? '')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки профиля')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProfile()
  }, [])

  const handleProfileSave = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setMessage(null)
    try {
      const data = await patchJson<ProfileData>('/api/profile', { fullName })
      setProfile(data)
      setMessage('Профиль сохранён.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка сохранения')
    }
  }

  const handlePhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    setError(null)
    setMessage(null)
    const form = new FormData()
    form.append('file', file)
    try {
      const data = await postForm<ProfileData>('/api/profile/photo', form)
      setProfile(data)
      setMessage('Фото обновлено.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки фото')
    }
  }

  const handlePasswordSave = async (event: React.FormEvent) => {
    event.preventDefault()
    setError(null)
    setMessage(null)
    try {
      await postJson('/api/profile/password', {
        currentPassword,
        newPassword,
        newPasswordRepeat,
      })
      setCurrentPassword('')
      setNewPassword('')
      setNewPasswordRepeat('')
      setMessage('Пароль изменён.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка смены пароля')
    }
  }

  const initials =
    profile?.employee?.fullName
      ?.split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? '')
      .join('') ||
    profile?.email.slice(0, 2).toUpperCase() ||
    '?'

  return (
    <div className="org-modal-backdrop" onClick={onClose}>
      <div className="org-modal org-profile-modal" onClick={(e) => e.stopPropagation()}>
        <header className="org-modal-header">
          <h2>Личный кабинет</h2>
          <button type="button" className="btn-ghost" onClick={onClose}>
            Закрыть
          </button>
        </header>

        {loading ? <p>Загрузка…</p> : null}
        {error ? <p className="org-error">{error}</p> : null}
        {message ? <p className="org-success">{message}</p> : null}

        {profile ? (
          <div className="org-profile-grid">
            <section className="org-panel">
              <h3>Профиль</h3>
              <div className="org-profile-photo">
                {profile.employee?.photoUrl ? (
                  <img src={profile.employee.photoUrl} alt="" />
                ) : (
                  <div className="org-profile-photo-placeholder">{initials}</div>
                )}
              </div>

              {profile.employee ? (
                <form onSubmit={(e) => void handleProfileSave(e)} className="org-form">
                  <label>
                    ФИО
                    <input value={fullName} onChange={(e) => setFullName(e.target.value)} required />
                  </label>
                  <label>
                    Фото
                    <input
                      type="file"
                      accept="image/png,image/jpeg,image/webp"
                      onChange={(e) => void handlePhoto(e)}
                    />
                  </label>
                  <dl className="org-readonly">
                    <dt>Email</dt>
                    <dd>{profile.email}</dd>
                    {profile.employee.position ? (
                      <>
                        <dt>Должность</dt>
                        <dd>{profile.employee.position}</dd>
                      </>
                    ) : null}
                    <dt>Роль</dt>
                    <dd>{profile.role}</dd>
                  </dl>
                  <button type="submit" className="btn-primary">
                    Сохранить профиль
                  </button>
                </form>
              ) : (
                <dl className="org-readonly">
                  <dt>Email</dt>
                  <dd>{profile.email}</dd>
                  <dt>Роль</dt>
                  <dd>{profile.role}</dd>
                </dl>
              )}
              {!profile.employee ? (
                <p className="org-hint">
                  Редактирование ФИО и фото доступно при привязке учётной записи к карточке сотрудника.
                </p>
              ) : null}
            </section>

            <section className="org-panel">
              <h3>Смена пароля</h3>
              <form onSubmit={(e) => void handlePasswordSave(e)} className="org-form">
                <label>
                  Текущий пароль
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    autoComplete="current-password"
                    required
                  />
                </label>
                <label>
                  Новый пароль
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label>
                  Повторите пароль
                  <input
                    type="password"
                    value={newPasswordRepeat}
                    onChange={(e) => setNewPasswordRepeat(e.target.value)}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button type="submit" className="btn-primary">
                  Сохранить пароль
                </button>
              </form>
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}
