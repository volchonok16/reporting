import { useEffect, useState } from 'react'
import { getJson, patchJson, postForm, postJson } from '../api'
import { notifyError, notifyProblem, notifySuccess } from '../toast'
import type { ProfileData } from './types'
import OrgPhoto from './OrgPhoto'
import PasswordInput from './PasswordInput'
import ProfileOfficeCalendar from './ProfileOfficeCalendar'

type EmployeeProfileProps = {
  onClose: () => void
}

export default function EmployeeProfile({ onClose }: EmployeeProfileProps) {
  const [profile, setProfile] = useState<ProfileData | null>(null)
  const [fullName, setFullName] = useState('')
  const [currentPassword, setCurrentPassword] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('')
  const [loading, setLoading] = useState(true)

  const loadProfile = async () => {
    setLoading(true)
    try {
      const data = await getJson<ProfileData>('/api/profile')
      setProfile(data)
      setFullName(data.employee?.fullName ?? '')
    } catch (err) {
      notifyError(err, 'Ошибка загрузки профиля')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void loadProfile()
  }, [])

  const handleProfileSave = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      const data = await patchJson<ProfileData>('/api/profile', { fullName })
      setProfile(data)
      notifySuccess('Профиль сохранён.')
    } catch (err) {
      notifyProblem(err, 'Ошибка сохранения')
    }
  }

  const handlePhoto = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    if (!file) return
    const form = new FormData()
    form.append('file', file)
    try {
      const data = await postForm<ProfileData>('/api/profile/photo', form)
      setProfile(data)
      notifySuccess('Фото обновлено.')
    } catch (err) {
      notifyProblem(err, 'Ошибка загрузки фото')
    }
  }

  const handlePasswordSave = async (event: React.FormEvent) => {
    event.preventDefault()
    try {
      await postJson('/api/profile/password', {
        currentPassword,
        newPassword,
        newPasswordRepeat,
      })
      setCurrentPassword('')
      setNewPassword('')
      setNewPasswordRepeat('')
      notifySuccess('Пароль изменён.')
    } catch (err) {
      notifyProblem(err, 'Ошибка смены пароля')
    }
  }

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

        {profile ? (
          <div className="org-profile-grid">
            <section className="org-panel">
              <h3>Профиль</h3>
              <div className="org-profile-photo">
                <OrgPhoto
                  url={profile.employee?.photoUrl}
                  name={profile.employee?.fullName ?? profile.email}
                  className="org-profile-photo-img"
                  placeholderClassName="org-profile-photo-placeholder"
                />
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
                    onChange={setNewPassword}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <label>
                  Повторите пароль
                  <PasswordInput
                    value={newPasswordRepeat}
                    onChange={setNewPasswordRepeat}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button type="submit" className="btn-primary">
                  Сохранить пароль
                </button>
              </form>
            </section>

            <ProfileOfficeCalendar enabled={Boolean(profile.employee)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
