import { Fragment, useCallback, useEffect, useState, type KeyboardEvent } from 'react'
import { apiFetch, getJson } from './api'
import { notifyError, notifyLoading, notifySuccess, updateLoading } from './toast'

const ALL_BOARDS = 'all'

type ProductZni = {
  id: string
  number: string
  title: string
  url?: string | null
  status?: string | null
  boardCode?: string | null
  boardName?: string | null
}

type Product = {
  id: string
  number: string
  title: string
  url?: string | null
  status?: string | null
  projectOwner?: string | null
  boardCode?: string | null
  boardName?: string | null
  tags: string[]
  zniCount: number
  zniItems: ProductZni[]
}

type ProductsData = {
  items: Product[]
  totalShown: number
}

type ProductsProps = {
  canSyncTfs?: boolean
}

function isClosedStatus(value?: string | null): boolean {
  if (!value?.trim()) return false
  return value.trim().toLowerCase() === 'closed'
}

export default function Products({ canSyncTfs = false }: ProductsProps) {
  const [data, setData] = useState<ProductsData | null>(null)
  const [loading, setLoading] = useState(true)
  const [syncing, setSyncing] = useState(false)
  const [hideClosed, setHideClosed] = useState(true)
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(new Set())

  const loadProducts = useCallback(async () => {
    setLoading(true)
    try {
      const payload = await getJson<ProductsData>(
        `/api/products?hideClosed=${hideClosed ? 'true' : 'false'}`,
      )
      setData(payload)
    } catch (err) {
      notifyError(err, 'Не удалось загрузить продукты')
    } finally {
      setLoading(false)
    }
  }, [hideClosed])

  useEffect(() => {
    void loadProducts()
  }, [loadProducts])

  const waitForSync = useCallback(async (onProgress?: (message: string) => void) => {
    const params = `?board=${encodeURIComponent(ALL_BOARDS)}`
    const response = await apiFetch(`/api/sync${params}`, { method: 'POST' })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(text || 'Ошибка синхронизации')
    }
    const sync = (await response.json()) as { id: number }
    for (;;) {
      const status = await getJson<{
        status: string
        errorMessage?: string | null
        progressMessage?: string | null
      }>(`/api/sync/${sync.id}`)
      if (status.progressMessage) {
        onProgress?.(status.progressMessage)
      }
      if (status.status === 'running') {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        continue
      }
      if (status.status === 'failed') {
        throw new Error(status.errorMessage || 'Синхронизация не удалась')
      }
      return
    }
  }, [])

  const handleSync = async () => {
    if (!canSyncTfs) return
    setSyncing(true)
    const toastId = notifyLoading('Старт…', 'products-sync')
    try {
      await waitForSync((message) => updateLoading(message, toastId))
      notifySuccess('Синхронизация завершена', toastId)
      await loadProducts()
    } catch (err) {
      notifyError(err, 'Ошибка синхронизации', toastId)
    } finally {
      setSyncing(false)
    }
  }

  const toggleExpanded = (key: string) => {
    setExpandedKeys((current) => {
      const next = new Set(current)
      if (next.has(key)) {
        next.delete(key)
      } else {
        next.add(key)
      }
      return next
    })
  }

  const handleExpandKeyDown = (event: KeyboardEvent<HTMLButtonElement>, key: string) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault()
      toggleExpanded(key)
    }
  }

  return (
    <div className="app">
      <section className="board-filter-bar">
        <div className="board-filter">
          <span className="board-filter-label">Продукты</span>
          <span className="table-meta">
            {loading ? 'загрузка…' : `${data?.totalShown ?? 0} продуктов`}
          </span>
        </div>
        <div className="board-filter-actions">
          <label className="dashboard-toggle">
            <input
              type="checkbox"
              checked={hideClosed}
              onChange={(event) => setHideClosed(event.target.checked)}
            />
            <span>Скрыть закрытые ЗНИ</span>
          </label>
          <button
            type="button"
            className="btn-secondary"
            onClick={() => void handleSync()}
            disabled={syncing || loading || !canSyncTfs}
            title={canSyncTfs ? undefined : 'Только администратор может обновлять данные из TFS'}
          >
            {syncing ? 'Обновление…' : 'Обновить из TFS'}
          </button>
        </div>
      </section>

      <section className="table-section">
        <div className="table">
          <div className="table-scroll">
            <table className="zni-table products-table">
              <colgroup>
                <col className="col-expand" />
                <col className="col-id" />
                <col className="col-title" />
                <col className="col-status" />
                <col className="col-board" />
                <col className="col-board" />
                <col className="col-id" />
              </colgroup>
              <thead>
                <tr>
                  <th className="cell-expand" aria-label="Развернуть" />
                  <th>Номер</th>
                  <th>Продукт</th>
                  <th>Статус</th>
                  <th>Владелец проекта</th>
                  <th>Доска</th>
                  <th>ЗНИ</th>
                </tr>
              </thead>
              <tbody>
                {!loading && data?.items.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="table-empty">Нет продуктов</td>
                  </tr>
                ) : null}
                {data?.items.map((product) => {
                  const expanded = expandedKeys.has(product.id)
                  const hasChildren = product.zniItems.length > 0
                  return (
                    <Fragment key={product.id}>
                      <tr
                        className={[
                          'products-product-row',
                          expanded ? 'zni-table-row-expanded' : '',
                        ]
                          .filter(Boolean)
                          .join(' ')}
                      >
                        <td className="cell-expand">
                          {hasChildren ? (
                            <button
                              type="button"
                              className="row-expand-btn"
                              aria-expanded={expanded}
                              aria-label={expanded ? 'Свернуть ЗНИ' : 'Развернуть ЗНИ'}
                              onClick={() => toggleExpanded(product.id)}
                              onKeyDown={(event) => handleExpandKeyDown(event, product.id)}
                            >
                              {expanded ? '▾' : '▸'}
                            </button>
                          ) : null}
                        </td>
                        <td className="cell-number">
                          {product.url ? (
                            <a href={product.url} target="_blank" rel="noreferrer">
                              {product.number}
                            </a>
                          ) : (
                            product.number
                          )}
                        </td>
                        <td className="cell-title products-product-title">
                          <span className="products-row-badge products-row-badge-product">Продукт</span>
                          {product.title}
                        </td>
                        <td className="cell-status">
                          {product.status && !isClosedStatus(product.status)
                            ? product.status
                            : product.status ?? '—'}
                        </td>
                        <td>{product.projectOwner ?? '—'}</td>
                        <td>{product.boardName ?? product.boardCode ?? '—'}</td>
                        <td>{product.zniCount}</td>
                      </tr>
                      {expanded && hasChildren
                        ? product.zniItems.map((zni) => (
                            <tr key={`${product.id}-${zni.id}`} className="products-zni-row">
                              <td className="cell-expand" />
                              <td className="cell-number">
                                {zni.url ? (
                                  <a href={zni.url} target="_blank" rel="noreferrer">
                                    {zni.number}
                                  </a>
                                ) : (
                                  zni.number
                                )}
                              </td>
                              <td className="cell-title products-zni-title">
                                <span className="products-row-badge products-row-badge-zni">ЗНИ</span>
                                {zni.title}
                              </td>
                              <td className="cell-status">{zni.status ?? '—'}</td>
                              <td />
                              <td>{zni.boardName ?? zni.boardCode ?? '—'}</td>
                              <td />
                            </tr>
                          ))
                        : null}
                    </Fragment>
                  )
                })}
              </tbody>
            </table>
          </div>
        </div>
      </section>
    </div>
  )
}
