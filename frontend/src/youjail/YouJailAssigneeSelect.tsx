import { useEffect, useMemo, useState } from 'react'
import { getJson } from '../api'
import OrgPhoto from '../org/OrgPhoto'
import type { Employee } from '../org/types'

type YouJailAssigneeSelectProps = {
  value: number | null | undefined
  disabled?: boolean
  onChange: (employeeId: number | null) => void
}

export default function YouJailAssigneeSelect({
  value,
  disabled = false,
  onChange,
}: YouJailAssigneeSelectProps) {
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    void getJson<Employee[]>('/api/org/employees')
      .then((items) => {
        if (!cancelled) {
          setEmployees(items.filter((item) => item.isActive))
        }
      })
      .catch(() => {
        if (!cancelled) setEmployees([])
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const selected = useMemo(
    () => employees.find((employee) => employee.id === value) ?? null,
    [employees, value],
  )

  return (
    <div className="youjail-assignee-select">
      {selected ? (
        <OrgPhoto
          url={selected.photoUrl}
          name={selected.fullName}
          className="youjail-assignee-photo"
          placeholderClassName="youjail-assignee-photo youjail-assignee-photo--placeholder"
        />
      ) : (
        <div className="youjail-assignee-photo youjail-assignee-photo--placeholder" aria-hidden="true">
          ?
        </div>
      )}
      <select
        className="youjail-assignee-picker"
        value={value ?? ''}
        disabled={disabled || loading}
        onChange={(event) => {
          const next = event.target.value ? Number(event.target.value) : null
          onChange(next)
        }}
      >
        <option value="">Не назначен</option>
        {employees.map((employee) => (
          <option key={employee.id} value={employee.id}>
            {employee.fullName}
          </option>
        ))}
      </select>
    </div>
  )
}
