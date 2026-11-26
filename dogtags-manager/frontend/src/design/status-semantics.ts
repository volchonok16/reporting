/** Source: Callmark v4 Design System §4, §8–10; Instructions §9, §11. */
export const statusSemantics = {
  draft: { tone: 'neutral', label: 'Черновик', icon: '○' },
  queued: { tone: 'neutral', label: 'В очереди', icon: '…' },
  running: { tone: 'info', label: 'Идёт обработка', icon: '↻' },
  review: { tone: 'warning', label: 'Требует проверки', icon: '!' },
  blocked: { tone: 'danger', label: 'Выпуск заблокирован', icon: '!' },
  prepared: { tone: 'info', label: 'Файлы подготовлены', icon: '▤' },
  syntaxPassed: { tone: 'success', label: 'Проверка синтаксиса пройдена', icon: '✓' },
  approved: { tone: 'success', label: 'Комплект подтверждён', icon: '✓' },
  downloaded: { tone: 'info', label: 'Файлы получены', icon: '↓' },
  notSubmitted: { tone: 'neutral', label: 'Внешняя загрузка не подтверждена', icon: '○' },
  proposal: { tone: 'ai', label: 'Предложение ИИ — не применено', icon: '◇' },
} as const;

export type Status = keyof typeof statusSemantics;
export type SemanticTone = (typeof statusSemantics)[Status]['tone'];
