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

type TeamPanelTab = 'members' | 'boards'

export default function YouJailTeamsPanel({
  canManageOrg,
  activeBoard,
  onBoardTeamsUpdated,
}: YouJailTeamsPanelProps) {
  const [open, setOpen] = useState(false)
  const [teams, setTeams] = useState<YouJailTeam[]>([])
  const [boards, setBoards] = useState<YouJailBoardMeta[]>([])
  const [employees, setEmployees] = useState<Employee[]>([])
  const [loading, setLoading] = useState(false)
  const [newTeamName, setNewTeamName] = useState('')
  const [selectedTeamId, setSelectedTeamId] = useState<number | null>(null)
  const [panelTab, setPanelTab] = useState<TeamPanelTab>('members')
  const [memberQuery, setMemberQuery] = useState('')
  const [teamBoardIds, setTeamBoardIds] = useState<number[]>([])
  const [savingBoards, setSavingBoards] = useState(false)

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
      void getJson<YouJailBoardMeta[]>('/api/youjail/boards')
        .then((items) => setBoards(items))
        .catch(() => setBoards([]))
      void getJson<Employee[]>('/api/org/employees')
        .then((items) => setEmployees(items.filter((item) => item.isActive)))
        .catch(() => setEmployees([]))
    }
  }, [canManageOrg, loadTeams, open])

  const selectedTeam = teams.find((team) => team.id === selectedTeamId) ?? null

  useEffect(() => {
    setTeamBoardIds(selectedTeam?.boardIds ?? [])
  }, [selectedTeam?.boardIds])

  useEffect(() => {
    setMemberQuery('')
    setPanelTab('members')
  }, [selectedTeamId])

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

  const addMember = async (employeeId: number) => {
    if (!selectedTeamId) return
    try {
      const updated = await postJson<YouJailTeam>(`/api/youjail/teams/${selectedTeamId}/members`, {
        employeeId,
      })
      setTeams((current) => current.map((team) => (team.id === updated.id ? updated : team)))
      setMemberQuery('')
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

  const saveTeamBoards = async () => {
    if (!selectedTeamId) return
    setSavingBoards(true)
    try {
      const updated = await putJson<YouJailTeam>(`/api/youjail/teams/${selectedTeamId}/boards`, {
        boardIds: teamBoardIds,
      })
      setTeams((current) => current.map((team) => (team.id === updated.id ? updated : team)))
      if (activeBoard) {
        const refreshedBoards = await getJson<YouJailBoardMeta[]>('/api/youjail/boards')
        const refreshedBoard = refreshedBoards.find((item) => item.id === activeBoard.id)
        if (refreshedBoard) onBoardTeamsUpdated(refreshedBoard)
      }
      notifySuccess('Доступ к доскам сохранён')
    } catch (err) {
      notifyProblem(err, 'Не удалось сохранить доступ к доскам')
    } finally {
      setSavingBoards(false)
    }
  }

  const toggleTeamBoard = (boardId: number) => {
    setTeamBoardIds((current) =>
      current.includes(boardId) ? current.filter((id) => id !== boardId) : [...current, boardId],
    )
  }

  const teamAssignableBoards = boards.filter((board) => !board.isPersonal)
  const availableEmployees = employees.filter(
    (employee) => !selectedTeam?.members.some((member) => member.employeeId === employee.id),
  )
  const memberSuggestions = availableEmployees
    .filter((employee) => {
      const needle = memberQuery.trim().toLowerCase()
      return !needle || employee.fullName.toLowerCase().includes(needle)
    })
    .slice(0, 10)

  if (!canManageOrg) return null

  return (
    <div className="youjail-teams-panel">
      <button type="button" className="btn-secondary" onClick={() => setOpen((current) => !current)}>
        Команды
      </button>
      {open ? (
        <div className="youjail-teams-popover">
          <div className="youjail-teams-popover-head">
            <div>
              <h3>Команды YouJail</h3>
              <p className="youjail-muted youjail-teams-help">
                Участники команды видят только отмеченные доски. Добавляйте людей через поиск, удаляйте кнопкой ✕.
              </p>
            </div>
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
              {teams.length === 0 ? <p className="youjail-muted">Команд пока нет</p> : null}
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
                <div className="youjail-team-tabs" role="tablist" aria-label="Настройки команды">
                  <button
                    type="button"
                    role="tab"
                    className={`youjail-team-tab${panelTab === 'members' ? ' is-active' : ''}`}
                    aria-selected={panelTab === 'members'}
                    onClick={() => setPanelTab('members')}
                  >
                    Участники
                  </button>
                  <button
                    type="button"
                    role="tab"
                    className={`youjail-team-tab${panelTab === 'boards' ? ' is-active' : ''}`}
                    aria-selected={panelTab === 'boards'}
                    onClick={() => setPanelTab('boards')}
                  >
                    Доски
                  </button>
                </div>

                {panelTab === 'members' ? (
                  <>
                    <div className="youjail-team-members">
                      {selectedTeam.members.length === 0 ? (
                        <p className="youjail-muted">Участников пока нет — найдите сотрудника ниже</p>
                      ) : (
                        selectedTeam.members.map((member) => (
                          <div key={member.id} className="youjail-team-member-row">
                            <OrgPhoto
                              url={member.employeePhotoUrl}
                              name={member.employeeName}
                              className="youjail-team-member-photo"
                              placeholderClassName="youjail-team-member-photo youjail-team-member-photo--placeholder"
                            />
                            <span className="youjail-team-member-name">{member.employeeName}</span>
                            <button
                              type="button"
                              className="youjail-team-member-remove"
                              title={`Убрать ${member.employeeName} из команды`}
                              onClick={() => void removeMember(member.employeeId)}
                            >
                              Убрать
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                    <div className="youjail-team-add-member">
                      <input
                        type="search"
                        value={memberQuery}
                        onChange={(event) => setMemberQuery(event.target.value)}
                        placeholder="Найти сотрудника для добавления…"
                      />
                      {memberQuery.trim() ? (
                        <div className="youjail-team-member-suggestions">
                          {memberSuggestions.length === 0 ? (
                            <p className="youjail-muted">Никого не найдено</p>
                          ) : (
                            memberSuggestions.map((employee) => (
                              <button
                                key={employee.id}
                                type="button"
                                className="youjail-team-member-suggestion"
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
                      ) : null}
                    </div>
                  </>
                ) : (
                  <section className="youjail-team-boards">
                    <p className="youjail-muted">
                      Отметьте доски, к которым у команды «{selectedTeam.name}» есть доступ.
                    </p>
                    <div className="youjail-team-boards-checks">
                      {teamAssignableBoards.length === 0 ? (
                        <p className="youjail-muted">Общих досок пока нет</p>
                      ) : null}
                      {teamAssignableBoards.map((board) => (
                        <label key={board.id} className="youjail-team-board-check">
                          <input
                            type="checkbox"
                            checked={teamBoardIds.includes(board.id)}
                            onChange={() => toggleTeamBoard(board.id)}
                          />
                          <span>{board.name}</span>
                        </label>
                      ))}
                    </div>
                    <button
                      type="button"
                      className="btn-primary"
                      disabled={savingBoards}
                      onClick={() => void saveTeamBoards()}
                    >
                      {savingBoards ? 'Сохранение…' : 'Сохранить доски'}
                    </button>
                  </section>
                )}
              </div>
            ) : (
              <div className="youjail-team-detail">
                <p className="youjail-muted">Выберите команду слева или создайте новую</p>
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  )
}
