import { useEffect, useMemo, useState } from 'react'
import mermaid from 'mermaid'

type DiagramKind = 'flowchart' | 'sequence' | 'mindmap'

type KindPreset = {
  id: DiagramKind
  label: string
  title: string
  starter: string
}

const PRESETS: KindPreset[] = [
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
    id: 'mindmap',
    label: 'Радиальный',
    title: 'Радиальная структура',
    starter: `mindmap
  root((Digital IT))
    Платформа
      CRM
      ESB
      Bercut
    Продукты
      B2B
      M2M
      Voice
    Поддержка
      Мониторинг
      Инциденты`,
  },
]

let renderCounter = 0

mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'loose',
  theme: 'default',
})

export default function DiagramBuilder() {
  const [kind, setKind] = useState<DiagramKind>('flowchart')
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
        <p className="diagram-subtitle">Второй уровень: иерархическая, последовательность, радиальная.</p>
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
          <h2>{activePreset.title}</h2>
          <textarea
            className="diagram-source"
            value={source}
            onChange={(event) => setSource(event.target.value)}
            spellCheck={false}
          />
        </div>
        <div className="diagram-preview">
          <h2>Предпросмотр</h2>
          {error ? (
            <p className="banner-error">Ошибка Mermaid: {error}</p>
          ) : (
            <div className="diagram-svg" dangerouslySetInnerHTML={{ __html: svg }} />
          )}
        </div>
      </section>
    </div>
  )
}
