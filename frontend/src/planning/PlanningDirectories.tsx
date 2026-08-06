import { useCallback, useEffect, useState } from 'react'
import { deleteJson, getJson, patchJson, postJson } from '../api'
import { notifyProblem } from '../toast'
import type { PlanningCustomerDepartment } from './types'

export default function PlanningDirectories() {
  const [rows, setRows] = useState<PlanningCustomerDepartment[]>([])
  const [loading, setLoading] = useState(true)
  const [name, setName] = useState('')
  const [editingId, setEditingId] = useState<number | null>(null)
  const [editName, setEditName] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const data = await getJson<PlanningCustomerDepartment[]>('/api/planning/customer-departments')
      setRows(data)
    } catch (error) {
      notifyProblem('Не удалось загрузить справочник департаментов заказчика', error)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const createRow = async () => {
    const trimmed = name.trim()
    if (!trimmed) {
      notifyProblem('Укажите название департамента заказчика')
      return
    }
    try {
      await postJson('/api/planning/customer-departments', { name: trimmed })
      setName('')
      await load()
    } catch (error) {
      notifyProblem('Не удалось добавить департамент заказчика', error)
    }
  }

  const saveEdit = async () => {
    if (editingId == null) return
    const trimmed = editName.trim()
    if (!trimmed) {
      notifyProblem('Укажите название департамента заказчика')
      return
    }
    try {
      await patchJson(`/api/planning/customer-departments/${editingId}`, { name: trimmed })
      setEditingId(null)
      setEditName('')
      await load()
    } catch (error) {
      notifyProblem('Не удалось сохранить департамент заказчика', error)
    }
  }

  const toggleActive = async (row: PlanningCustomerDepartment) => {
    try {
      await patchJson(`/api/planning/customer-departments/${row.id}`, { isActive: !row.isActive })
      await load()
    } catch (error) {
      notifyProblem('Не удалось изменить статус', error)
    }
  }

  const removeRow = async (row: PlanningCustomerDepartment) => {
    if (!window.confirm(`Удалить «${row.name}» из справочника?`)) return
    try {
      await deleteJson(`/api/planning/customer-departments/${row.id}`)
      await load()
    } catch (error) {
      notifyProblem('Не удалось удалить департамент заказчика', error)
    }
  }

  return (
    <section className="org-panel">
      <div className="org-panel-toolbar">
        <h2>Департамент заказчика</h2>
        <div className="org-panel-toolbar-actions">
          <button type="button" className="btn-ghost" onClick={() => void load()}>
            Обновить
          </button>
        </div>
      </div>

      <p className="org-hint">
        Отдельный справочник для планирования. Не связан с департаментами Staffing.
      </p>

      <div className="org-form planning-directory-form">
        <div className="org-form-row-2 org-form-row-align-end">
          <label>
            Новое значение
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void createRow()
                }
              }}
              placeholder="Название департамента заказчика"
            />
          </label>
          <button type="button" className="btn-primary" onClick={() => void createRow()}>
            Добавить
          </button>
        </div>
      </div>

      {loading ? <p className="org-hint">Обновление…</p> : null}

      <div className="planning-table-scroll">
        <table className="org-table">
          <thead>
            <tr>
              <th>Название</th>
              <th>Активен</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.id}>
                <td>
                  {editingId === row.id ? (
                    <input
                      value={editName}
                      onChange={(event) => setEditName(event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault()
                          void saveEdit()
                        }
                      }}
                    />
                  ) : (
                    row.name
                  )}
                </td>
                <td>{row.isActive ? 'Да' : 'Нет'}</td>
                <td className="org-table-actions">
                  {editingId === row.id ? (
                    <>
                      <button type="button" className="btn-primary" onClick={() => void saveEdit()}>
                        Сохранить
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          setEditingId(null)
                          setEditName('')
                        }}
                      >
                        Отмена
                      </button>
                    </>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          setEditingId(row.id)
                          setEditName(row.name)
                        }}
                      >
                        Изменить
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => void toggleActive(row)}>
                        {row.isActive ? 'Выключить' : 'Включить'}
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => void removeRow(row)}>
                        Удалить
                      </button>
                    </>
                  )}
                </td>
              </tr>
            ))}
            {!loading && rows.length === 0 ? (
              <tr>
                <td colSpan={3}>
                  <p className="org-hint">Справочник пуст — добавьте первое значение.</p>
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </section>
  )
}
