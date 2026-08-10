# Тестирование

## Быстрый прогон

Требуется Python 3.12. Из корня репозитория:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/pytest -q tests backend/tests
```

Набор `tests/test_mapping.py` проверяет каноническую модель, порядок первого
появления A/B, дедупликацию, пустой B, валидацию идентификаторов, точную
golden-строку, стандартный одноколоночный CSV, BOM/окончания строк и операции
удаления.

Набор `tests/test_api.py` проверяет `health`, обязательность сессии,
`upload → inspect → convert → preview/report/download → csv.reader`, операции
удаления, изоляцию сессий, поврежденные файлы и несовпадение расширения с
содержимым.

## Форматы

- CSV тестируется полностью, включая сквозное преобразование.
- XLSX синтезируется в памяти и проверяет числовые Excel-ячейки и выбор
  содержательного листа.
- XLS синтезируется через тестовую зависимость `xlwt` из
  `requirements-dev.txt`.
- XLSB не генерируется: формат не имеет надежного свободного writer-а.
  Интеграционный тест читает внешний образец, не копируя его в репозиторий.
  Указать путь:

```bash
CAROUSEL_TEST_XLSB=/absolute/path/input.xlsb .venv/bin/pytest -q \
  tests/test_api.py::test_external_xlsb_upload_and_inspection
```

Если файл отсутствует, тест пропускается с явной причиной.

## Поврежденные файлы и безопасность

Проверяются битые ZIP/XLSX/XLSB, двоичный файл с расширением CSV, mismatch
сигнатуры/расширения, формулы вместо номера, дробные/отрицательные значения,
изоляция объектов между сессиями, маскирование номеров и защита отчета от CSV
formula injection.

## Контейнерная проверка

```bash
cp .env.example .env
docker compose config
docker compose build
docker compose up -d
docker compose ps
curl --fail http://localhost:8000/api/health
curl --fail http://localhost:3000/
docker compose down
```

Для CI рекомендуется отдельно запускать быстрые тесты и performance job.
Нагрузочный сценарий не входит в обычный pytest, чтобы не замедлять feedback
loop.
