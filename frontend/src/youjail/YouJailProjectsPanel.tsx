import { useState, type FormEvent } from 'react'
import { postJson } from '../api'
import { notifyProblem, notifySuccess } from '../toast'
import type { YouJailProject } from './types'

type YouJailProjectsPanelProps = {
  onCreated: (project: YouJailProject) => void
}

export default function YouJailProjectsPanel({ onCreated }: YouJailProjectsPanelProps) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [contextMd, setContextMd] = useState('')
  const [saving, setSaving] = useState(false)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      const project = await postJson<YouJailProject>('/api/youjail/projects', {
        name: name.trim(),
        slug: slug.trim() || undefined,
        repoPath: repoPath.trim() || null,
        contextMd,
      })
      onCreated(project)
      setName('')
      setSlug('')
      setRepoPath('')
      setContextMd('')
      setOpen(false)
      notifySuccess('Проект создан')
    } catch (err) {
      notifyProblem(err, 'Не удалось создать проект')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="youjail-projects-panel">
      <button type="button" className="btn-ghost" onClick={() => setOpen((value) => !value)}>
        {open ? 'Скрыть проекты' : 'Проекты'}
      </button>
      {open ? (
        <form className="youjail-projects-form" onSubmit={(event) => void submit(event)}>
          <input
            type="text"
            placeholder="Название проекта"
            value={name}
            onChange={(event) => setName(event.target.value)}
          />
          <input
            type="text"
            placeholder="slug (опционально)"
            value={slug}
            onChange={(event) => setSlug(event.target.value)}
          />
          <input
            type="text"
            placeholder="Путь к git-репозиторию"
            value={repoPath}
            onChange={(event) => setRepoPath(event.target.value)}
          />
          <textarea
            placeholder="Контекст проекта (markdown)"
            value={contextMd}
            onChange={(event) => setContextMd(event.target.value)}
          />
          <button type="submit" className="btn-secondary" disabled={saving || !name.trim()}>
            {saving ? 'Сохранение…' : 'Добавить проект'}
          </button>
        </form>
      ) : null}
    </div>
  )
}
