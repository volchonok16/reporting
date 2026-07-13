import { useEffect, useMemo, useState } from 'react'
import { apiFetch, getJson, postJson } from '../api'
import { notifyProblem, notifySuccess } from '../toast'
import OrgPhoto from '../org/OrgPhoto'
import type { Employee } from '../org/types'
import type { YouJailBoardMember, YouJailBoardMeta } from './types'

type YouJailBoardAccessPanelProps = {
  board: YouJailBoardMeta
  onUpdated: (board: YouJailBoardMeta) => void
}

export default function YouJailBoardAccessPanel({ board, onUpdated }: YouJailBoardAccessPanelProps) {
  const [open, setOpen] = useState(false)
  const [employees, setEmployees] = useState<Employee[]>([])
  const [memberQuery, setMemberQuery] = useState('')
  const [memberRole, setMemberRole] = useState<'admin' | 'member'>('member')
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!open) return
    void getJson<Employee[]>('/api/org/employees')
      .then((items) => setEmployees(items.filter((item) => item.isActive)))
      .catch(() => setEmployees([]))
  }, [open])

  const members = board.members ?? []
  const memberIds = useMemo(() => new Set(members.map((member) => member.employeeId)), [members])

  const suggestions = employees
    .filter((employee) => !memberIds.has(employee.id))
    .filter((employee) => {
      const needle = memberQuery.trim().toLowerCase()
      return !needle || employee.fullName.toLowerCase().includes(needle)
    })
    .slice(0, 8)

  const addMember = async (employeeId: number) => {
    setSaving(true)
    try {
      const updated = await postJson<YouJailBoardMeta>(`/api/youjail/boards/${board.id}/members`, {
        employeeId,
        role: memberRole,
      })
      onUpdated(updated)
      setMemberQuery('')
      notifySuccess('Доступ выдан')
    } catch (err) {
      notifyProblem(err, 'Не удалось выдать доступ')
    } finally {
      setSaving(false)
    }
  }

  const removeMember = async (employeeId: number) => {
    setSaving(true)
    try {
      const response = await apiFetch(`/api/youjail/boards/${board.id}/members/${employeeId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error('Не удалось убрать доступ')
      }
      const updated = (await response.json()) as YouJailBoardMeta
      onUpdated(updated)
      notifySuccess('Доступ убран')
    } catch (err) {
      notifyProblem(err, 'Не удалось убрать доступ')
    } finally {
      setSaving(false)
    }
  }

  const changeRole = async (member: YouJailBoardMember, role: 'admin' | 'member') => {
    if (member.isOwner || member.role === role) return
    setSaving(true)
    try {
      const updated = await postJson<YouJailBoardMeta>(`/api/youjail/boards/${board.id}/members`, {
        employeeId: member.employeeId,
        role,
      })
      onUpdated(updated)
      notifySuccess('Роль обновлена')
    } catch (err) {
      notifyProblem(err, 'Не удалось обновить роль')
    } finally {
      setSaving(false)
    }
  }

  if (!board.canManage) return null

  return (
    <div className="youjail-board-access-panel">
      <button type="button" className="btn-secondary" onClick={() => setOpen((current) => !current)}>
        {open ? 'Скрыть доступ' : 'Доступ'}
      </button>
      {open ? (
        <div className="youjail-board-access-popover">
          <div className="youjail-board-access-head">
            <div>
              <h3>Кто видит доску</h3>
              <p className="youjail-muted">
                {board.isPersonal
                  ? 'Личная доска: по умолчанию видна только вам. Добавьте коллег, чтобы работать вместе.'
                  : 'Админы настраивают колонки и участников. Участники создают и двигают карточки.'}
              </p>
            </div>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)} aria-label="Закрыть">
              ×
            </button>
          </div>

          <div className="youjail-board-access-members">
            {members.length === 0 ? (
              <p className="youjail-muted">Пока только вы. Найдите сотрудника ниже, чтобы открыть доступ.</p>
            ) : null}
            {members.map((member) => (
              <div key={member.employeeId} className="youjail-board-access-row">
                <OrgPhoto
                  url={member.employeePhotoUrl}
                  name={member.employeeName}
                  className="youjail-team-member-photo"
                  placeholderClassName="youjail-team-member-photo youjail-team-member-photo--placeholder"
                />
                <span className="youjail-board-access-name">{member.employeeName}</span>
                {member.isOwner ? (
                  <span className="youjail-board-access-role is-owner">Владелец</span>
                ) : (
                  <select
                    className="youjail-board-access-role-select"
                    value={member.role}
                    disabled={saving}
                    onChange={(event) =>
                      void changeRole(member, event.target.value as 'admin' | 'member')
                    }
                  >
                    <option value="admin">Админ</option>
                    <option value="member">Участник</option>
                  </select>
                )}
                {!member.isOwner ? (
                  <button
                    type="button"
                    className="youjail-team-member-remove"
                    disabled={saving}
                    onClick={() => void removeMember(member.employeeId)}
                  >
                    Убрать
                  </button>
                ) : null}
              </div>
            ))}
          </div>

          <div className="youjail-board-access-add">
            <div className="youjail-board-access-add-controls">
              <input
                type="search"
                value={memberQuery}
                onChange={(event) => setMemberQuery(event.target.value)}
                placeholder="Найти сотрудника…"
                disabled={saving}
              />
              <select
                value={memberRole}
                onChange={(event) => setMemberRole(event.target.value as 'admin' | 'member')}
                disabled={saving}
              >
                <option value="member">Участник</option>
                <option value="admin">Админ</option>
              </select>
            </div>
            {memberQuery.trim() ? (
              <div className="youjail-team-member-suggestions">
                {suggestions.length === 0 ? (
                  <p className="youjail-muted">Никого не найдено — попробуйте другое имя</p>
                ) : (
                  suggestions.map((employee) => (
                    <button
                      key={employee.id}
                      type="button"
                      className="youjail-team-member-suggestion"
                      disabled={saving}
                      onClick={() => void addMember(employee.id)}
                    >
                      <OrgPhoto
                        url={employee.photoUrl}
                        name={employee.fullName}
                        className="youjail-mention-photo"
                        placeholderClassName="youjail-mention-photo youjail-mention-photo--placeholder"
                      />
                      <span>{employee.fullName}</span>
                    </button>
                  ))
                )}
              </div>
            ) : (
              <p className="youjail-muted youjail-board-access-search-hint">
                Введите имя сотрудника, чтобы добавить его на доску
              </p>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
