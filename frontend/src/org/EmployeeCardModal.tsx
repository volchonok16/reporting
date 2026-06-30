import { useEffect, useState } from 'react'
import { getJson } from '../api'
import type { EmployeeDetail } from './types'
import OrgPhoto from './OrgPhoto'

type EmployeeCardModalProps = {
  employeeId: number
  canManage: boolean
  onClose: () => void
  onEdit?: (employee: EmployeeDetail) => void
  onOpenEmployee: (employeeId: number) => void
}

export default function EmployeeCardModal({
  employeeId,
  canManage,
  onClose,
  onEdit,
  onOpenEmployee,
}: EmployeeCardModalProps) {
  const [employee, setEmployee] = useState<EmployeeDetail | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    void getJson<EmployeeDetail>(`/api/org/employees/${employeeId}`)
      .then((data) => {
        if (!cancelled) setEmployee(data)
      })
      .catch((err) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Ошибка загрузки')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [employeeId])

  return (
    <div className="org-modal-backdrop" onClick={onClose}>
      <div className="org-modal org-employee-card-modal" onClick={(e) => e.stopPropagation()}>
        <header className="org-modal-header">
          <h2>{employee?.fullName ?? 'Карточка сотрудника'}</h2>
          <div className="org-modal-header-actions">
            {canManage && employee && onEdit ? (
              <button type="button" className="btn-ghost" onClick={() => onEdit(employee)}>
                Редактировать
              </button>
            ) : null}
            <button type="button" className="btn-ghost" onClick={onClose}>
              Закрыть
            </button>
          </div>
        </header>

        {loading ? <p>Загрузка…</p> : null}
        {error ? <p className="org-error">{error}</p> : null}

        {employee ? (
          <div className="org-employee-card">
            <div className="org-employee-card-header">
              <div className="org-employee-card-photo">
                <OrgPhoto
                  url={employee.photoUrl}
                  name={employee.fullName}
                  className="org-employee-card-photo-img"
                  placeholderClassName="org-profile-photo-placeholder"
                />
              </div>
              <div className="org-employee-card-summary">
                <div className="org-employee-card-name">{employee.fullName}</div>
                {employee.position ? (
                  <div className="org-employee-card-position">{employee.position}</div>
                ) : null}
                {!employee.isActive ? <span className="org-badge org-badge-muted">Неактивен</span> : null}
              </div>
            </div>

            <dl className="org-readonly org-employee-card-fields">
              <dt>Email</dt>
              <dd>{employee.email ?? '—'}</dd>
              <dt>Руководитель</dt>
              <dd>
                {employee.managerId && employee.managerName ? (
                  <button
                    type="button"
                    className="org-employee-link"
                    onClick={() => onOpenEmployee(employee.managerId!)}
                  >
                    {employee.managerName}
                  </button>
                ) : (
                  '—'
                )}
              </dd>
              <dt>Рабочих часов в день</dt>
              <dd>{employee.dailyWorkHours}</dd>
            </dl>

            {employee.expertises.length > 0 ? (
              <section className="org-employee-card-section">
                <h3>Экспертиза</h3>
                <table className="org-table org-table-compact">
                  <thead>
                    <tr>
                      <th>Направление</th>
                      <th>Уровень</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employee.expertises.map((item) => (
                      <tr key={item.id}>
                        <td>{item.directionName}</td>
                        <td>{item.level ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : (
              <section className="org-employee-card-section">
                <h3>Экспертиза</h3>
                <p className="org-hint">Не указана</p>
              </section>
            )}

            {employee.departments.length > 0 || employee.headedDepartments.length > 0 ? (
              <section className="org-employee-card-section">
                <h3>Отделы</h3>
                <table className="org-table org-table-compact">
                  <thead>
                    <tr>
                      <th>Отдел</th>
                      <th>Роль</th>
                      <th>Должность</th>
                      <th>Руководитель</th>
                      <th>Email</th>
                    </tr>
                  </thead>
                  <tbody>
                    {employee.departments.map((item) => (
                      <tr key={item.departmentId}>
                        <td>{item.departmentName}</td>
                        <td>{item.teamRoleName ?? '—'}</td>
                        <td>{item.displayPosition ?? '—'}</td>
                        <td>{item.managerName ?? '—'}</td>
                        <td>{item.displayEmail ?? '—'}</td>
                      </tr>
                    ))}
                    {employee.headedDepartments.map((item) => (
                      <tr key={`head-${item.id}`}>
                        <td>{item.name}</td>
                        <td colSpan={4}>Руководитель отдела</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            ) : null}

            <section className="org-employee-card-section">
              <h3>Подчинённые</h3>
              {employee.subordinates.length > 0 ? (
                <ul className="org-employee-subordinates">
                  {employee.subordinates.map((subordinate) => (
                    <li key={subordinate.id}>
                      <button
                        type="button"
                        className="org-employee-link"
                        onClick={() => onOpenEmployee(subordinate.id)}
                      >
                        {subordinate.fullName}
                      </button>
                      {subordinate.position ? (
                        <span className="org-employee-subordinate-position">{subordinate.position}</span>
                      ) : null}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="org-hint">Нет прямых подчинённых</p>
              )}
            </section>
          </div>
        ) : null}
      </div>
    </div>
  )
}
