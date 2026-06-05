# PlantUML — исходники диаграмм

> **Смотреть в браузере без PlantUML:** [docs/diagrams.md](../docs/diagrams.md) (Mermaid на GitHub)  
> **Детальные SVG:** [docs/diagrams/svg/](../docs/diagrams/svg/) — обновляются при push в `main`

## Файлы

| Файл | Содержание |
|------|------------|
| `database-er.puml` | ER-схема всех таблиц и связей |
| `architecture.puml` | Архитектура: Jira, TFS, Trello, Other → PostgreSQL → FineBI |
| `use-case.puml` | Use case диаграмма |

## Как открыть

1. **Онлайн:** https://www.plantuml.com/plantuml — вставьте содержимое `.puml` файла.
2. **VS Code / Cursor:** расширение «PlantUML», затем Preview.
3. **IntelliJ / IDEA:** встроенная поддержка PlantUML.
4. **CLI:** `java -jar plantuml.jar database-er.puml` → PNG/SVG.

Примеры и тестовые данные в диаграммах **не используются** — только структура.
