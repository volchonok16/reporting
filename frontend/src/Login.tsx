import { useEffect, useState, type FormEvent } from 'react'
import { apiFetch, getJson, HttpError, readApiError, setSessionId } from './api'
import { notifyProblem, notifyWarning } from './toast'
import PasswordInput from './org/PasswordInput'
import ThemeToggle from './ThemeToggle'

type AuthDefaults = {
  baseUrl: string
  project: string
  projectId?: string | null
}

type LoginMode = 'account' | 'pat'

type LoginProps = {
  onSuccess: () => void
}

export default function Login({ onSuccess }: LoginProps) {
  const [mode, setMode] = useState<LoginMode>('account')
  const [baseUrl, setBaseUrl] = useState('https://tfs.t2.ru/tfs/Main')
  const [project, setProject] = useState('Tele2')
  const [projectId, setProjectId] = useState('')
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [pat, setPat] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    void getJson<AuthDefaults>('/api/auth/defaults')
      .then((payload) => {
        setBaseUrl(payload.baseUrl)
        setProject(payload.project)
        setProjectId(payload.projectId ?? '')
      })
      .catch(() => undefined)
  }, [])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (mode === 'account') {
      if (!username.trim() || !password) {
        notifyWarning('Введите логин и пароль.')
        return
      }
    } else if (!pat.trim()) {
      notifyWarning('Введите PAT-токен TFS.')
      return
    }

    setLoading(true)
    try {
      const body =
        mode === 'account'
          ? {
              baseUrl: baseUrl.trim(),
              project: project.trim(),
              projectId: projectId.trim() || null,
              username: username.trim(),
              password,
            }
          : {
              baseUrl: baseUrl.trim(),
              project: project.trim(),
              projectId: projectId.trim() || null,
              pat: pat.trim(),
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
        <h1>Reporting</h1>
        <p className="login-subtitle">Вход в отчётность по ЗНИ</p>

        <div className="login-tabs">
          <button
            type="button"
            className={mode === 'account' ? 'login-tab active' : 'login-tab'}
            onClick={() => setMode('account')}
          >
            Логин и пароль
          </button>
          <button
            type="button"
            className={mode === 'pat' ? 'login-tab active' : 'login-tab'}
            onClick={() => setMode('pat')}
          >
            PAT-токен
          </button>
        </div>

        <form onSubmit={submit}>
          {mode === 'account' ? (
            <>
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
            </>
          ) : (
            <>
              <label>
                URL TFS
                <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} />
              </label>
              <label>
                Проект (для проверки токена)
                <input value={project} onChange={(e) => setProject(e.target.value)} />
              </label>
              <label>
                PAT-токен
                <PasswordInput
                  value={pat}
                  onChange={setPat}
                  placeholder="Personal Access Token"
                  autoComplete="off"
                />
              </label>
            </>
          )}

          <button type="submit" disabled={loading}>
            {loading ? 'Проверка…' : 'Войти'}
          </button>
        </form>
      </section>
    </main>
  )
}
