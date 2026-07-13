import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { apiFetch, getJson, postJson, putJson } from '../api'
import { notifyError, notifyProblem, notifySuccess } from '../toast'
import OrgPhoto from '../org/OrgPhoto'
import type { Employee } from '../org/types'
import type { YouJailBoardMeta, YouJailTeam } from './types'

type YouJailTeamsPanelProps = {
  canManageOrg: boolean
  activeBoard: YouJailBoardMeta | null
  onBoardTeamsUpdated: (board: YouJailBoardMeta) => void
}

export default function YouJailTeamsPanel({
  canManageOrg,
  activeBoard,
  onBoardTeamsUpdated,
}: YouJailTeamsPanelProps) {
  const [open, setOpen] = useState(false)
  const [teams, setTeams] = useState<YouJailTeam[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null)
  const [memberEmployeeId, setMemberEmployeeId] = useState<number | ''>('')
  const [boardTeamIds, setBoardTeamIds] = useState<number[]>([])

  const loadTeams = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await getJson<YouJailTeam[]>('/api/youjail/teams?detailed=true')
      setTeams(payload)
      if (!selectedTeamId && payload.length > 0) {
        setSelectedTeamId(payload[0].id)
      }
    } catch (err) {
      notifyError(err, 'Не удалось загрузить команды')
    } finally {
      setLoading(false)
    }
  }, [selectedTeamId])

  useEffect(() => {
    if (!open) return
    void loadTeams()
    if (canManageOrg) {
      void getJson<Employee[]>('/api/org/employees')
        .then((items) => setEmployees(items.filter((item) => item.isActive)))
        .catch(() => setEmployees([]))
    }
  }, [canManageOrg, loadTeams, open])

  useEffect(() => {
    setBoardTeamIds(activeBoard?.teamIds ?? [])
  }, [activeBoard])

  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? null

  const createTeam = async (event: FormEvent) => {
    event.preventDefault()
    const name = newTeamName.trim()
    if (!name) return
    try {
      const created = await postJson<YouJailTeam>('/api/youjail/teams', { name })
      setNewTeamName('')
      setTeams((current) => [...current, created])
      setSelectedTeamId(created.id)
      notifySuccess('Команда создана')
    } catch (err) {
      notifyProblem(err, 'Не удалось создать команду')
    }
  }

  const addMember = async () => {
    if (!selectedTeamId || !memberEmployeeId) return
    try {
      const updated = await postJson<YouJailTeam>(`/api/youjail/teams/${selectedTeamId}/members`, {
        employeeId: memberEmployeeId,
      })
      setTeams((current) => current.map((team) => (team.id === updated.id ? updated : team)))
      setMemberEmployeeId('')
      notifySuccess('Участник добавлен')
    } catch (err) {
      notifyProblem(err, 'Не удалось добавить участника')
    }
  }

  const removeMember = async (employeeId: number) => {
    if (!selectedTeamId) return
    try {
      const response = await apiFetch(`/api/youjail/teams/${selectedTeamId}/members/${employeeId}`, {
        method: 'DELETE',
      })
      if (!response.ok) {
        throw new Error('Не удалось удалить участника')
      }
      notifySuccess('Участник удалён')
      await loadTeams()
    } catch (err) {
      notifyProblem(err, 'Не удалось удалить участника')
    }
  }

  const saveBoardTeams = async () => {
    if (!activeBoard) return
    try {
      const updated = await putJson<YouJailBoardMeta>(`/api/youjail/boards/${activeBoard.id}/teams`, {
        teamIds: boardTeamIds,
      })
      onBoardTeamsUpdated(updated)
      notifySuccess('Доступ к доске сохранён')
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить команды доски')
    }
  }

  const toggleBoardTeam = (teamId: number) => {
    setBoardTeamIds((current) =>
      current.includes(teamId) ? current.filter((id) => id !== teamId) : [...current, teamId],
    )
  }

  if (!canManageOrg) return null

  return (
    <div className="youjail-teams-panel">
      <button type="button" className="btn-secondary" onClick={() => setOpen((current) => !current)}>
        Команды
      </button>
      {open ? (
        <div className="youjail-teams-popover">
          <div className="youjail-teams-popover-head">
            <h3>Команды YouJail</h3>
            <button type="button" className="btn-ghost" onClick={() => setOpen(false)} aria-label="Закрыть">
              ×
            </button>
          </div>
          {loading ? <p className="youjail-muted">Загрузка…</p> : null}

          <form className="youjail-teams-create" onSubmit={(event) => void createTeam(event)}>
            <input
              type="text"
              value={newTeamName}
              onChange={(event) => setNewTeamName(event.target.value)}
              placeholder="Новая команда"
            />
            <button type="submit" className="btn-primary" disabled={!newTeamName.trim()}>
              Создать
            </button>
          </form>

          <div className="youjail-teams-layout">
            <div className="youjail-teams-list">
              {teams.map((team) => (
                <button
                  key={team.id}
                  type="button"
                  className={`youjail-team-item${selectedTeamId === team.id ? ' is-active' : ''}`}
                  onClick={() => setSelectedTeamId(team.id)}
                >
                  <span>{team.name}</span>
                  <span className="youjail-team-count">{team.memberCount}</span>
                </button>
              ))}
            </div>

            {selectedTeam ? (
              <div className="youjail-team-detail">
                <h4>{selectedTeam.name}</h4>
                <div className="youjail-team-members">
                  {selectedTeam.members.length === 0 ? (
                    <p className="youjail-muted">Участников пока нет</p>
                  ) : (
                    selectedTeam.members.map((member) => (
                      <div key={member.id} className="youjail-team-member-row">
                        <OrgPhoto
                          url={member.employeePhotoUrl}
                          name={member.employeeName}
                          className="youjail-team-member-photo"
                          placeholderClassName="youjail-team-member-photo youjail-team-member-photo--placeholder"
                        />
                        <span>{member.employeeName}</span>
                        <button
                          type="button"
                          className="btn-ghost"
                          onClick={() => void removeMember(member.employeeId)}
                        >
                          ✕
                        </button>
                      </div>
                    ))
                  )}
                </div>
                <div className="youjail-team-add-member">
                  <select
                    value={memberEmployeeId}
                    onChange={(event) =>
                      setMemberEmployeeId(event.target.value ? Number(event.target.value) : '')
                    }
                  >
                    <option value="">Добавить сотрудника…</option>
                    {employees
                      .filter(
                        (employee) =>
                          !selectedTeam.members.some((member) => member.employeeId === employee.id),
                      )
                      .map((employee) => (
                        <option key={employee.id} value={employee.id}>
                          {employee.fullName}
                        </option>
                      ))}
                  </select>
                  <button
                    type="button"
                    className="btn-secondary"
                    disabled={!memberEmployeeId}
                    onClick={() => void addMember()}
                  >
                    Добавить
                  </button>
                </div>
              </div>
            ) : null}
          </div>

          {activeBoard ? (
            <section className="youjail-board-teams">
              <h4>Доступ к доске «{activeBoard.name}»</h4>
              <p className="youjail-muted">Пользователи видят доску, если состоят хотя бы в одной из выбранных команд.</p>
              <div className="youjail-board-teams-checks">
                {teams.map((team) => (
                  <label key={team.id} className="youjail-board-team-check">
                    <input
                      type="checkbox"
                      checked={boardTeamIds.includes(team.id)}
                      onChange={() => toggleBoardTeam(team.id)}
                    />
                    <span>{team.name}</span>
                  </label>
                ))}
              </div>
              <button type="button" className="btn-primary" onClick={() => void saveBoardTeams()}>
                Сохранить доступ
              </button>
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
