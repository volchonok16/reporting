import { useEffect, useState, type FormEvent } from 'react'
import { apiFetch, getJson, readApiError, setSessionId } from './api'

type AuthDefaults = {
  baseUrl: string
  project: string
  projectId?: string | null
}

type LoginProps = {
  onSuccess: () => void
}

export default function Login({ onSuccess }: LoginProps) {
  const [baseUrl, setBaseUrl] = useState('https://tfs.t2.ru/tfs/Main')
  const [project, setProject] = useState('Tele2')
  const [projectId, setProjectId] = useState('')
  const [pat, setPat] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

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
    if (!pat.trim()) {
      setError('Введите PAT-токен TFS.')
      return
    }
    setLoading(true)
    setError(null)
    try {
      const response = await apiFetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          baseUrl: baseUrl.trim(),
          project: project.trim(),
          projectId: projectId.trim() || null,
          pat: pat.trim(),
        }),
      })
      if (!response.ok) {
        throw new Error(await readApiError(response))
      }
      const payload = (await response.json()) as { sessionId: string }
      setSessionId(payload.sessionId)
      onSuccess()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось войти')
    } finally {
      setLoading(false)
    }
  }

  return (
    <main className="login-page">
      <section className="login-panel">
        <h1>Reporting</h1>
        <p className="login-subtitle">Вход по PAT-токену TFS</p>
        <form onSubmit={submit}>
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
            <input
              type="password"
              value={pat}
              onChange={(e) => setPat(e.target.value)}
              placeholder="Personal Access Token"
              autoComplete="off"
            />
          </label>
          {error && <p className="error">{error}</p>}
          <button type="submit" disabled={loading}>
            {loading ? 'Проверка…' : 'Войти'}
          </button>
        </form>
      </section>
    </main>
  )
}
