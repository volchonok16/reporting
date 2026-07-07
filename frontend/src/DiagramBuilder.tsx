import { useEffect, useMemo, useState } from 'react'
import mermaid from 'mermaid'

type DiagramKind = 'mindmap' | 'flowchart' | 'sequence' | 'bpmn' | 'wave' | 'board'

type KindPreset = {
  id: DiagramKind
  label: string
  title: string
  starter: string
}

const PRESETS: KindPreset[] = [
  {
    id: 'mindmap',
    label: 'Радиальный',
    title: 'Радиальная структура',
    starter: `mindmap
  root((Digital IT))
    Разработка
      Backend
      Frontend
      QA
    Интеграции
      CRM
      ESB
    Операции
      Мониторинг
      Поддержка`,
  },
  {
    id: 'flowchart',
    label: 'Иерархический',
    title: 'Иерархическая диаграмма',
    starter: `flowchart TD
  CEO[Руководитель IT]
  Head1[Head разработки]
  Head2[Head аналитики]
  Team1[Backend]
  Team2[Frontend]
  Team3[BI]
  CEO --> Head1
  CEO --> Head2
  Head1 --> Team1
  Head1 --> Team2
  Head2 --> Team3`,
  },
  {
    id: 'sequence',
    label: 'Последовательность',
    title: 'Последовательность процесса',
    starter: `sequenceDiagram
  participant Biz as Бизнес
  participant PO as Product Owner
  participant Dev as Разработка
  participant QA as QA
  Biz->>PO: Инициирует задачу
  PO->>Dev: Передаёт требования
  Dev->>QA: Отдаёт на проверку
  QA->>Biz: Подтверждает готовность`,
  },
  {
    id: 'bpmn',
    label: 'BPMN',
    title: 'BPMN-процесс',
    starter: `flowchart LR
  Start([Старт])
  Task1[Сбор требований]
  Gate{Согласовано?}
  Task2[Разработка]
  Task3[Уточнение]
  End([Финиш])
  Start --> Task1 --> Gate
  Gate -- Да --> Task2 --> End
  Gate -- Нет --> Task3 --> Task1`,
  },
  {
    id: 'wave',
    label: 'Волнообразная',
    title: 'Волнообразный план',
    starter: `timeline
  title Волнообразный цикл поставки
  Q1 : Аналитика
     : Архитектура
  Q2 : Разработка
     : Интеграция
  Q3 : Пилот
     : Обратная связь
  Q4 : Тиражирование`,
  },
  {
    id: 'board',
    label: 'Доска проектов',
    title: 'Проектная доска',
    starter: `flowchart LR
  subgraph Backlog
    A[CRM API]
    B[ESB адаптер]
  end
  subgraph InProgress[В работе]
    C[Миграция клиентов]
    D[Личный кабинет B2B]
  end
  subgraph Done[Готово]
    E[Мониторинг SLA]
  end
  A --> C
  B --> D
  C --> E`,
  },
]

let renderCounter = 0

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'default',
})

export default function DiagramBuilder() {
  const [kind, setKind] = useState<DiagramKind>('mindmap')
  const [source, setSource] = useState(PRESETS[0].starter)
  const [svg, setSvg] = useState('')
  const [error, setError] = useState<string | null>(null)

  const activePreset = useMemo(() => PRESETS.find((preset) => preset.id === kind) ?? PRESETS[0], [kind])

  useEffect(() => {
    let mounted = true
    const render = async () => {
      try {
        renderCounter += 1
        const elementId = `diagram-builder-${renderCounter}`
        const { svg: nextSvg } = await mermaid.render(elementId, source)
        if (!mounted) return
        setSvg(nextSvg)
        setError(null)
      } catch (err) {
        if (!mounted) return
        setSvg('')
        setError(err instanceof Error ? err.message : 'Ошибка построения диаграммы')
      }
    }
    void render()
    return () => {
      mounted = false
    }
  }, [source])

  const applyPreset = (nextKind: DiagramKind) => {
    const preset = PRESETS.find((item) => item.id === nextKind)
    setKind(nextKind)
    if (preset) {
      setSource(preset.starter)
    }
  }

  return (
    <div className="diagram-page app">
      <header className="diagram-header">
        <h1 className="diagram-title">Диаграммы</h1>
        <p className="diagram-subtitle">Радиальный, Иерархический, Последовательность, BPMN, Волнообразная, Доска проектов.</p>
      </header>

      <nav className="diagram-kind-tabs" aria-label="Тип диаграммы">
        {PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className={`diagram-kind-tab${preset.id === kind ? ' diagram-kind-tab-active' : ''}`}
            onClick={() => applyPreset(preset.id)}
          >
            {preset.label}
          </button>
        ))}
      </nav>

      <section className="table-section diagram-workspace">
        <div className="diagram-editor">
          <div className="diagram-editor-head">
            <h2>{activePreset.title}</h2>
            <button type="button" className="btn-secondary" onClick={() => setSource(activePreset.starter)}>
              Пример
            </button>
          </div>
          <textarea
            className="diagram-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="diagram-preview">
          <h2>Предпросмотр</h2>
          <p className="diagram-preview-hint">Диаграмма строится из Mermaid-синтаксиса выбранного типа.</p>
          {error ? (
            <p className="banner-error">Ошибка Mermaid: {error}</p>
          ) : (
            <div
              className={`diagram-svg${kind === 'mindmap' ? ' diagram-svg-radial' : ''}`}
              dangerouslySetInnerHTML={{ __html: svg }}
            />
          )}
        </div>
      </section>
    </div>
  )
}
