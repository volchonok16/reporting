# PlantUML — исходники диаграмм

> **Смотреть в браузере:** [docs/diagrams.md](../docs/diagrams.md) (Mermaid)  
> **Confluence:** [docs/confluence.md](../docs/confluence.md) + PNG в [docs/diagrams/png/](../docs/diagrams/png/)  
> **SVG:** [docs/diagrams/svg/](../docs/diagrams/svg/)

## Файлы

| Файл | Содержание |
|------|------------|
| `database-er.puml` | ER: задачи, Staffing/org, YouJail, B2B status, sync |
| `architecture.puml` | Workbook + MinIO, YouJail FS, Status.pptx, FineBI |
| `use-case.puml` | Use cases всех вкладок workbook + BI + TFS |

## Как открыть

1. **Онлайн:** https://www.plantuml.com/plantuml — вставьте содержимое `.puml` файла.
2. **VS Code / Cursor:** расширение «PlantUML», затем Preview.
3. **IntelliJ / IDEA:** встроенная поддержка PlantUML.
4. **CLI / Docker:**

```bash
docker run --rm -v "$(pwd):/work" -w /work plantuml/plantuml \
  -tsvg -o /work/docs/diagrams/svg \
  /work/plantuml/database-er.puml \
  /work/plantuml/architecture.puml \
  /work/plantuml/use-case.puml
```

Примеры и тестовые данные в диаграммах **не используются** — только структура.
