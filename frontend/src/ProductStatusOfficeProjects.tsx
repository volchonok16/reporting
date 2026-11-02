import { useEffect, useState } from 'react'
import { apiFetch, getJson, readApiError } from './api'
import { notifyProblem, notifySuccess } from './toast'
import type { ProjectPriorityRangesMap } from './productStatusCoordination'

type OfficeProject = {
  id?: number | null
  name: string
  sortOrder: number
  rangeFrom: number
  rangeTo: number
  isActive: boolean
}

type OfficeProjectsResponse = {
  gid: string
  name: string
  projects: OfficeProject[]
}

type ProductStatusOfficeProjectsProps = {
  apiBase: string
  gid: string
  officeName: string
  onSaved?: (meta: {
    projects: string[]
    projectPriorityRanges: ProjectPriorityRangesMap
  }) => void
}

function emptyProject(sortOrder: number): OfficeProject {
  return {
    id: null,
    name: '',
    sortOrder,
    rangeFrom: 1,
    rangeTo: 49,
    isActive: true,
  }
}

export default function ProductStatusOfficeProjects({
  apiBase,
  gid,
  officeName,
  onSaved,
}: ProductStatusOfficeProjectsProps) {
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [projects, setProjects] = useState<OfficeProject[]>([])

  useEffect(() => {
    setOpen(false)
  }, [gid])

  useEffect(() => {
    if (!open) return
    let cancelled = false
    setLoading(true)
    void (async () => {
      try {
        const payload = await getJson<OfficeProjectsResponse>(
          `${apiBase}/offices/${encodeURIComponent(gid)}/projects`,
        )
        if (cancelled) return
        const active = (payload.projects || []).filter((item) => item.isActive !== false)
        setProjects(
          active.length > 0
            ? active.map((item, index) => ({
                id: item.id,
                name: item.name,
                sortOrder: item.sortOrder ?? (index + 1) * 10,
                rangeFrom: item.rangeFrom,
                rangeTo: item.rangeTo,
                isActive: true,
              }))
            : [emptyProject(10)],
        )
      } catch (err) {
        if (!cancelled) notifyProblem(err, 'Не удалось загрузить проекты офиса')
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [apiBase, gid, open])

  function updateProject(index: number, patch: Partial<OfficeProject>) {
    setProjects((current) =>
      current.map((item, itemIndex) => (itemIndex === index ? { ...item, ...patch } : item)),
    )
  }

  function addProject() {
    setProjects((current) => [...current, emptyProject((current.length + 1) * 10)])
  }

  function removeProject(index: number) {
    setProjects((current) => {
      const next = current.filter((_, itemIndex) => itemIndex !== index)
      return next.length > 0 ? next : [emptyProject(10)]
    })
  }

  async function save() {
    setSaving(true)
    try {
      const body = {
        projects: projects
          .map((item, index) => ({
            id: item.id ?? null,
            name: item.name.trim(),
            sortOrder: (index + 1) * 10,
            rangeFrom: Number(item.rangeFrom),
            rangeTo: Number(item.rangeTo),
            isActive: true,
          }))
          .filter((item) => item.name.length > 0),
      }
      const response = await apiFetch(`${apiBase}/offices/${encodeURIComponent(gid)}/projects`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(await readApiError(response))
      const saved = (await response.json()) as OfficeProjectsResponse
      const active = (saved.projects || []).filter((item) => item.isActive !== false)
      setProjects(
        active.length > 0
          ? active.map((item, index) => ({
              id: item.id,
              name: item.name,
              sortOrder: item.sortOrder ?? (index + 1) * 10,
              rangeFrom: item.rangeFrom,
              rangeTo: item.rangeTo,
              isActive: true,
            }))
          : [emptyProject(10)],
      )
      const projectPriorityRanges: ProjectPriorityRangesMap = {}
      for (const item of active) {
        projectPriorityRanges[item.name] = {
          rangeFrom: item.rangeFrom,
          rangeTo: item.rangeTo,
        }
      }
      onSaved?.({
        projects: active.map((item) => item.name),
        projectPriorityRanges,
      })
      notifySuccess('Проекты офиса сохранены')
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить проекты офиса')
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="product-status-office-access product-status-office-projects">
      <button
        type="button"
        className="btn-secondary product-status-toolbar-btn"
        onClick={() => setOpen((current) => !current)}
      >
        Проекты офиса
      </button>
      {open ? (
        <div className="product-status-office-access-panel product-status-office-projects-panel">
          <p className="product-status-office-access-note">
            {officeName}. Справочник «Проект координация» и диапазоны «Приоритет» для этого
            продуктового офиса. Диапазоны активных проектов не должны пересекаться.
          </p>
          {loading ? <p className="product-status-office-access-selected">Загрузка…</p> : null}
          <ul className="product-status-office-projects-list">
            {projects.map((project, index) => (
              <li key={project.id ?? `new-${index}`} className="product-status-office-projects-row">
                <input
                  className="product-status-office-projects-name"
                  value={project.name}
                  onChange={(event) => updateProject(index, { name: event.target.value })}
                  placeholder="Название проекта"
                  aria-label={`Название проекта ${index + 1}`}
                />
                <label className="product-status-office-projects-range">
                  <span>от</span>
                  <input
                    type="number"
                    min={1}
                    value={project.rangeFrom}
                    onChange={(event) =>
                      updateProject(index, { rangeFrom: Number(event.target.value) || 1 })
                    }
                    aria-label={`Приоритет от, проект ${index + 1}`}
                  />
                </label>
                <label className="product-status-office-projects-range">
                  <span>до</span>
                  <input
                    type="number"
                    min={1}
                    value={project.rangeTo}
                    onChange={(event) =>
                      updateProject(index, { rangeTo: Number(event.target.value) || 1 })
                    }
                    aria-label={`Приоритет до, проект ${index + 1}`}
                  />
                </label>
                <button
                  type="button"
                  className="btn-ghost product-status-office-projects-remove"
                  onClick={() => removeProject(index)}
                  disabled={saving}
                  title="Убрать из справочника"
                >
                  Убрать
                </button>
              </li>
            ))}
          </ul>
          <div className="product-status-office-projects-actions">
            <button
              type="button"
              className="btn-secondary product-status-toolbar-btn"
              onClick={addProject}
              disabled={saving || loading}
            >
              Добавить проект
            </button>
            <button
              type="button"
              className="btn-primary product-status-toolbar-btn"
              onClick={() => void save()}
              disabled={saving || loading}
            >
              Сохранить
            </button>
          </div>
        </div>
      ) : null}
    </section>
  )
}
