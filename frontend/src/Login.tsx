import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { apiFetch, getJson, HttpError, readApiError, setSessionId } from './api'
import { notifyProblem, notifySuccess, notifyWarning } from './toast'
import PasswordInput from './org/PasswordInput'
import ThemeToggle from './ThemeToggle'
import BrandLogo from './BrandLogo'
import MaintenanceBanner from './MaintenanceBanner'

type AuthDefaults = {
  baseUrl: string
  project: string
  projectId?: string | null
  maintenanceEnabled?: boolean
  maintenanceMessage?: string
}

function ResetCodeCells({
  value,
  onChange,
}: {
  value: string
  onChange: (value: string) => void
}) {
  const refs = useRef<Array<HTMLInputElement | null>>([])
  const digits = Array.from({ length: 6 }, (_, index) => value[index] ?? '')

  useEffect(() => {
    refs.current[0]?.focus()
  }, [])

  const focusAt = (index: number) => {
    refs.current[Math.max(0, Math.min(index, 5))]?.focus()
  }

  const writeAt = (index: number, digit: string) => {
    const next =
      index < value.length
        ? value.slice(0, index) + digit + value.slice(index + 1)
        : (value + digit).slice(0, 6)
    onChange(next.slice(0, 6))
    if (digit) focusAt(index + 1)
  }

  const onKeyDown = (index: number, event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Backspace') {
      event.preventDefault()
      if (digits[index]) {
        onChange(value.slice(0, index) + value.slice(index + 1))
        return
      }
      if (index > 0) {
        onChange(value.slice(0, index - 1) + value.slice(index))
        focusAt(index - 1)
      }
      return
    }
    if (event.key === 'ArrowLeft') focusAt(index - 1)
    if (event.key === 'ArrowRight') focusAt(index + 1)
  }

  return (
    <div className="login-code-cells" role="group" aria-label="Код из письма">
      {digits.map((digit, index) => (
        <input
          key={index}
          ref={(node) => {
            refs.current[index] = node
          }}
          className="login-code-cell"
          inputMode="numeric"
          autoComplete={index === 0 ? 'one-time-code' : 'off'}
          aria-label={`Цифра ${index + 1}`}
          value={digit}
          onChange={(event) => {
            const raw = event.target.value.replace(/\D/g, '')
            if (!raw) {
              onChange(value.slice(0, index) + value.slice(index + 1))
              return
            }
            if (raw.length > 1) {
              const merged = (value.slice(0, index) + raw).slice(0, 6)
              onChange(merged)
              focusAt(merged.length >= 6 ? 5 : merged.length)
              return
            }
            writeAt(index, raw)
          }}
          onKeyDown={(event) => onKeyDown(index, event)}
          onPaste={(event) => {
            const raw = event.clipboardData.getData('text').replace(/\D/g, '').slice(0, 6)
            if (!raw) return
            event.preventDefault()
            const merged = (value.slice(0, index) + raw).slice(0, 6)
            onChange(merged)
            focusAt(merged.length >= 6 ? 5 : merged.length)
          }}
          onFocus={(event) => event.target.select()}
        />
      ))}
    </div>
  )
}

type LoginProps = {
  onSuccess: () => void
  maintenanceEnabled?: boolean
  maintenanceMessage?: string
}

export default function Login({
  onSuccess,
  maintenanceEnabled: maintenanceEnabledProp,
  maintenanceMessage: maintenanceMessageProp,
}: LoginProps) {
  const [baseUrl, setBaseUrl] = useState('https://tfs.t2.ru/tfs/Main')
  const [project, setProject] = useState('Tele2')
  const [projectId, setProjectId] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [maintenanceEnabled, setMaintenanceEnabled] = useState(Boolean(maintenanceEnabledProp))
  const [maintenanceMessage, setMaintenanceMessage] = useState(maintenanceMessageProp ?? '')
  const [resetStep, setResetStep] = useState<'login' | 'email' | 'code' | 'credentials'>('login')
  const [resetEmail, setResetEmail] = useState('')
  const [resetCode, setResetCode] = useState('')
  const [newLogin, setNewLogin] = useState('')
  const [newPassword, setNewPassword] = useState('')
  const [newPasswordRepeat, setNewPasswordRepeat] = useState('')

  useEffect(() => {
    void getJson<AuthDefaults>('/api/auth/defaults')
      .then((payload) => {
        setBaseUrl(payload.baseUrl)
        setProject(payload.project)
        setProjectId(payload.projectId ?? '')
        if (maintenanceEnabledProp == null) {
          setMaintenanceEnabled(Boolean(payload.maintenanceEnabled))
          setMaintenanceMessage(payload.maintenanceMessage ?? '')
        }
      })
      .catch(() => undefined)
  }, [maintenanceEnabledProp])

  useEffect(() => {
    if (maintenanceEnabledProp != null) {
      setMaintenanceEnabled(Boolean(maintenanceEnabledProp))
      setMaintenanceMessage(maintenanceMessageProp ?? '')
    }
  }, [maintenanceEnabledProp, maintenanceMessageProp])

  const requestReset = async (event: FormEvent) => {
    event.preventDefault()
    const email = resetEmail.trim()
    if (!email) {
      notifyWarning('Укажите почту учётной записи.')
      return
    }
    setLoading(true)
    try {
      const response = await apiFetch('/api/auth/password-reset/request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      if (!response.ok) {
        throw new HttpError(await readApiError(response), response.status)
      }
      const payload = (await response.json()) as { message: string }
      notifySuccess(payload.message)
      setResetStep('code')
    } catch (err) {
      notifyProblem(err, 'Не удалось отправить код')
    } finally {
      setLoading(false)
    }
  }

  const verifyResetCode = async (event: FormEvent) => {
    event.preventDefault()
    if (resetCode.trim().length !== 6) {
      notifyWarning('Введите шестизначный код из письма.')
      return
    }
    setLoading(true)
    try {
      const response = await apiFetch('/api/auth/password-reset/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: resetEmail.trim(), code: resetCode.trim() }),
      })
      if (!response.ok) {
        throw new HttpError(await readApiError(response), response.status)
      }
      setNewLogin(resetEmail.trim())
      setResetStep('credentials')
    } catch (err) {
      notifyProblem(err, 'Не удалось подтвердить код')
    } finally {
      setLoading(false)
    }
  }

  const confirmReset = async (event: FormEvent) => {
    event.preventDefault()
    if (!newLogin.trim()) {
      notifyWarning('Укажите новый логин.')
      return
    }
    if (newPassword !== newPasswordRepeat) {
      notifyWarning('Пароли не совпадают.')
      return
    }
    if (newPassword.trim().length < 8) {
      notifyWarning('Новый пароль должен быть не короче 8 символов.')
      return
    }
    setLoading(true)
    try {
      const response = await apiFetch('/api/auth/password-reset/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: resetEmail.trim(),
          code: resetCode.trim(),
          newLogin: newLogin.trim(),
          newPassword,
          newPasswordRepeat,
        }),
      })
      if (!response.ok) {
        throw new HttpError(await readApiError(response), response.status)
      }
      const payload = (await response.json()) as { message: string }
      notifySuccess(payload.message)
      setUsername(newLogin.trim())
      setPassword('')
      setNewLogin('')
      setNewPassword('')
      setNewPasswordRepeat('')
      setResetCode('')
      setResetStep('login')
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить логин и пароль')
    } finally {
      setLoading(false)
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!username.trim() || !password) {
      notifyWarning('Введите логин и пароль.')
      return
    }

    setLoading(true)
    try {
      const body = {
        baseUrl: baseUrl.trim(),
        project: project.trim(),
        projectId: projectId.trim() || null,
        username: username.trim(),
        password,
      }

      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        throw new HttpError(await readApiError(response), response.status)
      }
      const payload = (await response.json()) as { sessionId: string }
      setSessionId(payload.sessionId)
      onSuccess()
    } catch (err) {
      notifyProblem(err, 'Не удалось войти')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <ThemeToggle className="login-theme-switch" />
      <section className="login-panel">
        <div className="login-brand">
          <BrandLogo height={44} />
        </div>
        <h1 className="login-app-title">Reporting</h1>
        <p className="login-subtitle">Вход в отчётность по ЗНИ</p>

        {maintenanceEnabled ? <MaintenanceBanner message={maintenanceMessage} /> : null}

        {resetStep !== 'login' ? (
          <form
            onSubmit={
              resetStep === 'email' ? requestReset : resetStep === 'code' ? verifyResetCode : confirmReset
            }
          >
            <h2 className="login-reset-title">Сброс пароля</h2>
            {resetStep === 'email' ? (
              <>
                <p className="login-hint">Сначала проверим, что учётка есть, и отправим код на её почту.</p>
                <label>
                  Логин
                  <input
                    type="email"
                    value={resetEmail}
                    onChange={(e) => setResetEmail(e.target.value)}
                    autoComplete="username"
                    required
                  />
                </label>
                <button type="submit" disabled={loading}>
                  {loading ? 'Проверка…' : 'Получить код'}
                </button>
              </>
            ) : resetStep === 'code' ? (
              <>
                <p className="login-hint">Код отправлен на {resetEmail}. Введите шесть цифр из письма.</p>
                <div className="login-code-field">
                  <span>Код из письма</span>
                  <ResetCodeCells value={resetCode} onChange={setResetCode} />
                </div>
                <button type="submit" disabled={loading}>
                  {loading ? 'Проверка…' : 'Подтвердить код'}
                </button>
              </>
            ) : (
              <>
                <p className="login-hint">Код подтверждён. Задайте новый логин и пароль.</p>
                <label>
                  Новый логин
                  <input
                    type="email"
                    value={newLogin}
                    onChange={(e) => setNewLogin(e.target.value)}
                    autoComplete="username"
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
                  Подтверждение пароля
                  <PasswordInput
                    value={newPasswordRepeat}
                    onChange={setNewPasswordRepeat}
                    autoComplete="new-password"
                    required
                  />
                </label>
                <button type="submit" disabled={loading}>
                  {loading ? 'Сохранение…' : 'Сохранить'}
                </button>
              </>
            )}
            <button
              type="button"
              className="btn-ghost login-reset-back"
              onClick={() => setResetStep('login')}
            >
              Назад ко входу
            </button>
          </form>
        ) : (
        <form onSubmit={submit}>
          <label>
            Логин
            <input
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="username"
            />
          </label>
          <label>
            Пароль
            <PasswordInput
              value={password}
              onChange={setPassword}
              autoComplete="current-password"
            />
          </label>
          <p className="login-hint">Выгрузка из TFS выполняется серверным токеном.</p>
          <button
            type="button"
            className="btn-ghost login-reset-back"
            onClick={() => {
              setResetEmail(username.trim())
              setResetStep('email')
            }}
          >
            Забыли пароль?
          </button>
          <button type="submit" disabled={loading}>
            {loading ? 'Проверка…' : 'Войти'}
          </button>
        </form>
        )}
      </section>
    </main>
  )
}
