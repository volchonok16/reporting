import { useCallback, useEffect, useMemo, useState } from 'react'
import { getJson, postJson } from '../api'
import { notifyProblem, notifySuccess } from '../toast'
import YouJailTerminal from './YouJailTerminal'
import type { YouJailCard, YouJailExecution, YouJailExecutor } from './types'
import { YOUJAIL_EXECUTORS } from './types'

const EXECUTOR_LABELS: Record<YouJailExecutor, string> = {
  manual: 'Вручную',
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  pi: 'Pi',
  openclaw: 'OpenClaw',
  opencode: 'OpenCode',
}

const STATUS_LABELS: Record<string, string> = {
  idle: 'Ожидание',
  queued: 'В очереди',
  running: 'Выполняется',
  succeeded: 'Успех',
  failed: 'Ошибка',
}

type YouJailCardExecutionProps = {
  card: YouJailCard
  disabled?: boolean
  onRefreshCard: () => Promise<void>
}

export default function YouJailCardExecution({
  card,
  disabled = false,
  onRefreshCard,
}: YouJailCardExecutionProps) {
  const [executor, setExecutor] = useState<YouJailExecutor>((card.executor as YouJailExecutor) || 'claude')
  const [retryFeedback, setRetryFeedback] = useState('')
  const [running, setRunning] = useState(false)
  const [activeExecution, setActiveExecution] = useState<YouJailExecution | null>(card.latestExecution ?? null)
  const [history, setHistory] = useState<YouJailExecution[]>([])
  const [historyOpen, setHistoryOpen] = useState(false)

  const isLive = card.executionStatus === 'running' || card.executionStatus === 'queued'

  const loadHistory = useCallback(async () => {
    try {
      const items = await getJson<YouJailExecution[]>(`/api/youjail/cards/${card.id}/executions`)
      setHistory(items)
      if (!activeExecution && items.length > 0) {
        setActiveExecution(items[0])
      }
    } catch {
      setHistory([])
    }
  }, [activeExecution, card.id])

  useEffect(() => {
    setExecutor((card.executor as YouJailExecutor) || 'claude')
    setActiveExecution(card.latestExecution ?? null)
  }, [card.id, card.executor, card.latestExecution])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  useEffect(() => {
    if (!isLive) return
    const timer = window.setInterval(() => {
      void onRefreshCard()
    }, 2000)
    return () => window.clearInterval(timer)
  }, [isLive, onRefreshCard])

  const terminalExecution = activeExecution
  const terminalRunning = isLive && terminalExecution?.status === 'running'
  const historyLogs = useMemo(() => terminalExecution?.logs ?? [], [terminalExecution?.logs])

  const runExecution = async (mode: 'execute' | 'retry') => {
    setRunning(true)
    try {
      const path = mode === 'retry' ? 'retry' : 'execute'
      const payload =
        mode === 'retry'
          ? { executor, retryFeedback: retryFeedback.trim() || null }
          : { executor }
      const execution = await postJson<YouJailExecution>(`/api/youjail/cards/${card.id}/${path}`, payload)
      setActiveExecution(execution)
      setRetryFeedback('')
      notifySuccess(mode === 'retry' ? 'Повторный запуск начат' : 'Запуск начат')
      await onRefreshCard()
      await loadHistory()
    } catch (err) {
      notifyProblem(err, mode === 'retry' ? 'Не удалось повторить запуск' : 'Не удалось запустить агента')
    } finally {
      setRunning(false)
    }
  }

  const loadExecutionLogs = async (executionId: number) => {
    try {
      const execution = await getJson<YouJailExecution>(`/api/youjail/executions/${executionId}`)
      setActiveExecution(execution)
    } catch (err) {
      notifyProblem(err, 'Не удалось загрузить лог')
    }
  }

  return (
    <section className="youjail-execution-panel">
      <div className="youjail-section-head">
        <h3>Агент</h3>
        <span className={`youjail-execution-status is-${card.executionStatus}`}>
          {STATUS_LABELS[card.executionStatus] ?? card.executionStatus}
        </span>
      </div>

      <label className="youjail-field">
        <span>Исполнитель</span>
        <select
          value={executor}
          disabled={disabled || running || isLive}
          onChange={(event) => setExecutor(event.target.value as YouJailExecutor)}
        >
          {YOUJAIL_EXECUTORS.filter((item) => item !== 'manual').map((item) => (
            <option key={item} value={item}>
              {EXECUTOR_LABELS[item]}
            </option>
          ))}
        </select>
      </label>

      <div className="youjail-execution-actions">
        <button
          type="button"
          className="btn-primary"
          disabled={disabled || running || isLive}
          onClick={() => void runExecution('execute')}
        >
          {running ? 'Запуск…' : 'Запустить'}
        </button>
        {card.executionStatus === 'failed' ? (
          <button
            type="button"
            className="btn-secondary"
            disabled={disabled || running || isLive}
            onClick={() => void runExecution('retry')}
          >
            Повторить
          </button>
        ) : null}
      </div>

      {card.executionStatus === 'failed' ? (
        <label className="youjail-field">
          <span>Обратная связь для повтора</span>
          <textarea
            className="youjail-retry-feedback"
            value={retryFeedback}
            disabled={disabled || running || isLive}
            placeholder="Что исправить агенту при повторном запуске…"
            onChange={(event) => setRetryFeedback(event.target.value)}
          />
        </label>
      ) : null}

      {(card.worktreePath || card.worktreeBranch) && (
        <div className="youjail-meta">
          {card.worktreeBranch ? <p>Ветка: {card.worktreeBranch}</p> : null}
          {card.worktreePath ? <p>Worktree: {card.worktreePath}</p> : null}
        </div>
      )}

      {terminalExecution ? (
        <div className="youjail-execution-log">
          <h3>
            Запуск #{terminalExecution.id} · {EXECUTOR_LABELS[terminalExecution.executor as YouJailExecutor] ?? terminalExecution.executor}
          </h3>
          {terminalExecution.errorMessage ? (
            <p className="youjail-error-inline">{terminalExecution.errorMessage}</p>
          ) : null}
          <YouJailTerminal
            executionId={terminalExecution.id}
            running={terminalRunning}
            historyLogs={historyLogs}
          />
        </div>
      ) : null}

      {history.length > 0 ? (
        <details
          className="youjail-log-history"
          open={historyOpen}
          onToggle={(event) => setHistoryOpen((event.target as HTMLDetailsElement).open)}
        >
          <summary>История запусков ({history.length})</summary>
          <ul className="youjail-execution-history">
            {history.map((item) => (
              <li key={item.id}>
                <button
                  type="button"
                  className={`youjail-execution-history-item${activeExecution?.id === item.id ? ' is-active' : ''}`}
                  onClick={() => void loadExecutionLogs(item.id)}
                >
                  <span>#{item.id}</span>
                  <span>{EXECUTOR_LABELS[item.executor as YouJailExecutor] ?? item.executor}</span>
                  <span className={`youjail-execution-status is-${item.status}`}>{STATUS_LABELS[item.status] ?? item.status}</span>
                </button>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
