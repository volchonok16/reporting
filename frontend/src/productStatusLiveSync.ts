import { getSessionId, resolveApiBase } from './api'

export type ProductStatusSavedEvent = {
  type: 'saved'
  workbook: string
  gids: string[]
  changedBy: string | null
  at: string
  originConnectionId?: string
}

type SavedListener = (event: ProductStatusSavedEvent) => void

type WorkbookConnection = {
  workbook: string
  connectionId: string
  listeners: Set<SavedListener>
  socket: WebSocket | null
  reconnectTimer: number | null
  reconnectAttempt: number
  closed: boolean
}

const connections = new Map<string, WorkbookConnection>()

function createConnectionId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `live-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

export function workbookKeyFromApiBase(apiBase: string): string {
  if (apiBase.includes('/b2b-news')) return 'b2b-news'
  if (apiBase.includes('/revenue-activities')) return 'revenue-activities'
  return 'b2b'
}

function buildLiveWebSocketUrl(workbook: string): string {
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
  const params = new URLSearchParams({ workbook })
  const sessionId = getSessionId()
  if (sessionId) params.set('X-Session-Id', sessionId)
  return `${protocol}://${host}/api/product-status/live/ws?${params}`
}

function getOrCreateConnection(workbook: string): WorkbookConnection {
  let connection = connections.get(workbook)
  if (!connection) {
    connection = {
      workbook,
      connectionId: createConnectionId(),
      listeners: new Set(),
      socket: null,
      reconnectTimer: null,
      reconnectAttempt: 0,
      closed: false,
    }
    connections.set(workbook, connection)
  }
  return connection
}

function scheduleReconnect(connection: WorkbookConnection): void {
  if (connection.closed || connection.listeners.size === 0) return
  if (connection.reconnectTimer !== null) return
  const delayMs = Math.min(30_000, 1000 * 2 ** connection.reconnectAttempt)
  connection.reconnectAttempt += 1
  connection.reconnectTimer = window.setTimeout(() => {
    connection.reconnectTimer = null
    connect(connection)
  }, delayMs)
}

function handleMessage(connection: WorkbookConnection, raw: string): void {
  let payload: unknown
  try {
    payload = JSON.parse(raw)
  } catch {
    return
  }
  if (!payload || typeof payload !== 'object') return
  const message = payload as Partial<ProductStatusSavedEvent> & { type?: string }
  if (message.type !== 'saved' || !Array.isArray(message.gids) || message.gids.length === 0) {
    return
  }
  const event: ProductStatusSavedEvent = {
    type: 'saved',
    workbook: String(message.workbook ?? connection.workbook),
    gids: message.gids.map(String),
    changedBy: typeof message.changedBy === 'string' ? message.changedBy : null,
    at: typeof message.at === 'string' ? message.at : new Date().toISOString(),
    originConnectionId:
      typeof message.originConnectionId === 'string' ? message.originConnectionId : undefined,
  }
  for (const listener of connection.listeners) {
    listener(event)
  }
}

function connect(connection: WorkbookConnection): void {
  if (connection.closed || connection.listeners.size === 0) return
  if (connection.socket && connection.socket.readyState <= WebSocket.OPEN) return

  const socket = new WebSocket(buildLiveWebSocketUrl(connection.workbook))
  connection.socket = socket

  socket.addEventListener('open', () => {
    connection.reconnectAttempt = 0
    socket.send(
      JSON.stringify({
        type: 'register',
        connectionId: connection.connectionId,
      }),
    )
  })

  socket.addEventListener('message', (event) => {
    if (typeof event.data === 'string') {
      handleMessage(connection, event.data)
    }
  })

  socket.addEventListener('close', () => {
    if (connection.socket === socket) {
      connection.socket = null
    }
    scheduleReconnect(connection)
  })

  socket.addEventListener('error', () => {
    socket.close()
  })
}

function releaseConnection(workbook: string): void {
  const connection = connections.get(workbook)
  if (!connection || connection.listeners.size > 0) return
  connection.closed = true
  if (connection.reconnectTimer !== null) {
    window.clearTimeout(connection.reconnectTimer)
    connection.reconnectTimer = null
  }
  connection.socket?.close()
  connection.socket = null
  connections.delete(workbook)
}

export function getProductStatusLiveConnectionId(apiBase: string): string | null {
  const connection = connections.get(workbookKeyFromApiBase(apiBase))
  return connection?.connectionId ?? null
}

export function subscribeProductStatusLive(
  apiBase: string,
  onSaved: SavedListener,
): () => void {
  const workbook = workbookKeyFromApiBase(apiBase)
  const connection = getOrCreateConnection(workbook)
  connection.closed = false
  connection.listeners.add(onSaved)
  connect(connection)
  return () => {
    connection.listeners.delete(onSaved)
    releaseConnection(workbook)
  }
}

export function productStatusLiveHeaders(apiBase: string): Record<string, string> {
  const connectionId = getProductStatusLiveConnectionId(apiBase)
  if (!connectionId) return {}
  return { 'X-Live-Connection-Id': connectionId }
}
