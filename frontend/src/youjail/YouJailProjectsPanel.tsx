import { useState, type FormEvent } from 'react'
import { patchJson, postJson } from '../api'
import { notifyProblem, notifySuccess } from '../toast'
import type { YouJailProject } from './types'

type YouJailProjectsPanelProps = {
  projects: YouJailProject[]
  onCreated: (project: YouJailProject) => void
  onUpdated: (project: YouJailProject) => void
}

type FormMode = { kind: 'create' } | { kind: 'edit'; projectId: number }

export default function YouJailProjectsPanel({ projects, onCreated, onUpdated }: YouJailProjectsPanelProps) {
  const [open, setOpen] = useState(false)
  const [mode, setMode] = useState<FormMode>({ kind: 'create' })
  const [name, setName] = useState('')
  const [slug, setSlug] = useState('')
  const [repoPath, setRepoPath] = useState('')
  const [contextMd, setContextMd] = useState('')
  const [instructionsMd, setInstructionsMd] = useState('')
  const [saving, setSaving] = useState(false)

  const resetCreateForm = () => {
    setMode({ kind: 'create' })
    setName('')
    setSlug('')
    setRepoPath('')
    setContextMd('')
    setInstructionsMd('')
  }

  const startEdit = (project: YouJailProject) => {
    setMode({ kind: 'edit', projectId: project.id })
    setName(project.name)
    setSlug(project.slug)
    setRepoPath(project.repoPath ?? '')
    setContextMd(project.contextMd)
    setInstructionsMd(project.instructionsMd)
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return
    setSaving(true)
    try {
      if (mode.kind === 'create') {
        const project = await postJson<YouJailProject>('/api/youjail/projects', {
          name: name.trim(),
          slug: slug.trim() || undefined,
          repoPath: repoPath.trim() || null,
          contextMd,
          instructionsMd,
        })
        onCreated(project)
        resetCreateForm()
        notifySuccess('Проект создан')
      } else {
        const project = await patchJson<YouJailProject>(`/api/youjail/projects/${mode.projectId}`, {
          name: name.trim(),
          repoPath: repoPath.trim() || null,
          contextMd,
          instructionsMd,
        })
        onUpdated(project)
        notifySuccess('Проект сохранён')
      }
    } catch (err) {
      notifyProblem(err, mode.kind === 'create' ? 'Не удалось создать проект' : 'Не удалось сохранить проект')
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
        <div className="youjail-projects-popover">
          {projects.length > 0 ? (
            <ul className="youjail-projects-list">
              {projects.map((project) => (
                <li key={project.id}>
                  <button
                    type="button"
                    className={`youjail-projects-list-item${
                      mode.kind === 'edit' && mode.projectId === project.id ? ' is-active' : ''
                    }`}
                    onClick={() => startEdit(project)}
                  >
                    <span>{project.name}</span>
                    {project.repoPath ? <span className="youjail-muted">{project.repoPath}</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="youjail-muted">Проектов пока нет</p>
          )}

          <form className="youjail-projects-form" onSubmit={(event) => void submit(event)}>
            <p className="youjail-projects-form-title">
              {mode.kind === 'create' ? 'Новый проект' : 'Редактирование'}
            </p>
            <input
              type="text"
              placeholder="Название проекта"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            {mode.kind === 'create' ? (
              <input
                type="text"
                placeholder="slug (опционально)"
                value={slug}
                onChange={(event) => setSlug(event.target.value)}
              />
            ) : null}
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
            <textarea
              placeholder="Инструкции для агента (markdown)"
              value={instructionsMd}
              onChange={(event) => setInstructionsMd(event.target.value)}
            />
            <div className="youjail-projects-form-actions">
              {mode.kind === 'edit' ? (
                <button type="button" className="btn-ghost" onClick={resetCreateForm}>
                  Новый
                </button>
              ) : null}
              <button type="submit" className="btn-secondary" disabled={saving || !name.trim()}>
                {saving ? 'Сохранение…' : mode.kind === 'create' ? 'Добавить' : 'Сохранить'}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </div>
  )
}
