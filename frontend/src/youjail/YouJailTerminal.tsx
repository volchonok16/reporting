import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { getSessionId, resolveApiBase } from '../api'

import type { YouJailExecutionLog } from './types'

type YouJailTerminalProps = {
  executionId: number | null
  running: boolean
  historyLogs?: YouJailExecutionLog[]
}

function buildTerminalUrl(executionId: number): string {
  const apiBase = resolveApiBase()
  const protocol = apiBase.startsWith('https')
    ? 'wss'
    : typeof window !== 'undefined' && window.location.protocol === 'https:'
      ? 'wss'
      : 'ws'
  const host = apiBase
    ? apiBase.replace(/^https?:\/\//, '')
    : typeof window !== 'undefined'
      ? window.location.host
      : 'localhost:5173'
  const sessionId = getSessionId()
  const params = new URLSearchParams()
  if (sessionId) params.set('X-Session-Id', sessionId)
  const query = params.toString()
  return `${protocol}://${host}/api/youjail/executions/${executionId}/terminal${query ? `?${query}` : ''}`
}

export default function YouJailTerminal({ executionId, running, historyLogs = [] }: YouJailTerminalProps) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const socketRef = useRef<WebSocket | null>(null)

  useEffect(() => {
    if (!containerRef.current) return

    const terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'Consolas, "Cascadia Mono", monospace',
      fontSize: 13,
      theme: {
        background: '#0f1419',
        foreground: '#e6edf3',
        cursor: '#58a6ff',
      },
      convertEol: true,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)
    terminal.open(containerRef.current)
    fitAddon.fit()
    terminal.writeln('Подключение к PTY-терминалу…')

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const resizeObserver = new ResizeObserver(() => {
      fitAddon.fit()
      const socket = socketRef.current
      if (socket && socket.readyState === WebSocket.OPEN) {
        socket.send(
          JSON.stringify({
            type: 'resize',
            rows: terminal.rows,
            cols: terminal.cols,
          }),
        )
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      socketRef.current?.close()
      socketRef.current = null
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal || executionId === null) return

    if (!running) {
      terminal.clear()
      terminal.writeln(`Сессия #${executionId} (завершена)`)
      for (const line of historyLogs) {
        terminal.writeln(line.content)
      }
      return
    }

    socketRef.current?.close()
    const socket = new WebSocket(buildTerminalUrl(executionId))
    socket.binaryType = 'arraybuffer'
    socketRef.current = socket

    socket.onopen = () => {
      terminal.clear()
      terminal.writeln(`Сессия #${executionId}${running ? ' (live)' : ''}`)
      const fitAddon = fitAddonRef.current
      if (fitAddon) {
        fitAddon.fit()
        socket.send(
          JSON.stringify({
            type: 'resize',
            rows: terminal.rows,
            cols: terminal.cols,
          }),
        )
      }
    }

    socket.onmessage = (event) => {
      if (typeof event.data === 'string') {
        terminal.write(event.data)
        return
      }
      if (event.data instanceof ArrayBuffer) {
        terminal.write(new Uint8Array(event.data))
      }
    }

    socket.onerror = () => {
      terminal.writeln('\r\n\x1b[31mОшибка WebSocket-терминала\x1b[0m')
    }

    socket.onclose = () => {
      if (running) {
        terminal.writeln('\r\n\x1b[33mСоединение закрыто\x1b[0m')
      }
    }

    const onData = terminal.onData((data) => {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(data)
      }
    })

    return () => {
      onData.dispose()
      socket.close()
      if (socketRef.current === socket) {
        socketRef.current = null
      }
    }
  }, [executionId, historyLogs, running])

  return <div className="youjail-terminal" ref={containerRef} />
}
