import { useCallback, useEffect, useState } from 'react'
import { getJson } from './api'

type ProductStatusRow = {
  launchDate: string
  project: string
  description: string
  purpose: string
}

type ProductStatusData = {
  title: string
  sourceUrl?: string | null
  items: ProductStatusRow[]
  totalShown: number
}

function cellText(value: string): string {
  return value.trim() || '—'
}

export default function ProductStatusB2B() {
  const [data, setData] = useState<ProductStatusData | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const loadData = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const payload = await getJson<ProductStatusData>('/api/product-status/b2b')
      setData(payload)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void loadData()
  }, [loadData])

  return (
    <div className="product-status">
      <header className="product-status-toolbar">
        <div className="product-status-toolbar-left">
          <h1 className="product-status-title">{data?.title ?? 'Статус продукта B2B'}</h1>
          <p className="product-status-subtitle">
            Данные из Google Sheets
            {data?.sourceUrl ? (
              <>
                {' · '}
                <a className="zni-link" href={data.sourceUrl} target="_blank" rel="noreferrer">
                  Открыть таблицу
                </a>
              </>
            ) : null}
          </p>
        </div>
        <button type="button" className="btn-secondary" onClick={() => void loadData()} disabled={loading}>
          {loading ? 'Загрузка…' : 'Обновить'}
        </button>
      </header>

      {error && <p className="banner-error">{error}</p>}

      <section className="table-section product-status-table-section">
        <p className="table-meta">
          Показано строк {data?.totalShown ?? 0}
          {loading ? ' · загрузка…' : ''}
        </p>
        <div className="table">
          <div className="table-scroll">
            <div className="table-head product-status-head">
              <div>Дата запуска</div>
              <div>Проект</div>
              <div>Описание проекта</div>
              <div>Зачем и для чего делаем</div>
            </div>
            <div className="table-body">
              {data?.items.map((item, index) => (
                <div className="table-row product-status-row" key={`${item.project}-${index}`}>
                  <div className="cell-date product-status-cell">{cellText(item.launchDate)}</div>
                  <div className="cell-project product-status-cell">{cellText(item.project)}</div>
                  <div className="product-status-cell product-status-multiline">{cellText(item.description)}</div>
                  <div className="product-status-cell product-status-multiline">{cellText(item.purpose)}</div>
                </div>
              ))}
              {!loading && data?.items.length === 0 && (
                <div className="table-empty">Нет данных в таблице.</div>
              )}
            </div>
          </div>
        </div>
      </section>
    </div>
  )
}
