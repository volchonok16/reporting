# Диаграммы — SVG и PNG

| Формат | Папка | Для чего |
|--------|-------|----------|
| **PNG** | [../png/](../png/) | **Confluence** (удобно вставлять) |
| SVG | эта папка | GitHub, браузер, масштабирование |

Стилистика — Atlassian-like (синий `#0052CC`, серые панели), без Google.

Исходники: [`plantuml/*.puml`](../../../plantuml/).

## Пересборка

Нужны Java + Graphviz (`dot` в PATH):

```bash
JAVA=/opt/homebrew/opt/openjdk@21/bin/java   # или свой JDK
DOT=/opt/homebrew/bin/dot
JAR=/path/to/plantuml.jar

GRAPHVIZ_DOT="$DOT" "$JAVA" -jar "$JAR" -graphvizdot "$DOT" \
  -tsvg -o docs/diagrams/svg \
  plantuml/architecture.puml plantuml/use-case.puml plantuml/database-er.puml

GRAPHVIZ_DOT="$DOT" "$JAVA" -jar "$JAR" -graphvizdot "$DOT" \
  -tpng -o docs/diagrams/png \
  plantuml/architecture.puml plantuml/use-case.puml plantuml/database-er.puml
```

Или через Docker:

```bash
docker run --rm -v "$(pwd):/work" -w /work plantuml/plantuml \
  -tsvg -o /work/docs/diagrams/svg \
  /work/plantuml/architecture.puml \
  /work/plantuml/use-case.puml \
  /work/plantuml/database-er.puml

docker run --rm -v "$(pwd):/work" -w /work plantuml/plantuml \
  -tpng -o /work/docs/diagrams/png \
  /work/plantuml/architecture.puml \
  /work/plantuml/use-case.puml \
  /work/plantuml/database-er.puml
```

Текст для Confluence: [confluence.md](../../confluence.md) · свод Mermaid: [diagrams.md](../../diagrams.md).
