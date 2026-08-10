# Внутренняя модель

Каждая строка любого импортера преобразуется в `SourceRow`:

```text
SourceRow {
  sequence: integer
  sourceRow: integer
  aValue: scalar | blank | formula
  bValue: scalar | blank | formula
}
```

После безопасной нормализации получается:

```text
Mapping {
  aNumber: string
  bNumbers: string[]
  firstSeenOrder: integer
}
```

Номер — идентификатор, а не величина. Поэтому он никогда не хранится как
floating point. Целая числовая ячейка Excel преобразуется в десятичную строку
без научной нотации; строка сохраняет `+` и ведущие нули. Дробное,
отрицательное, формульное или синтаксически неверное значение становится
ошибкой строки.

Порядок определяется `sequence` первого появления. Для B хранится отдельный
порядок внутри A. Пустой B нормализуется в A до дедупликации. В стандартном
режиме ключ `(A, B)` уникален; в режиме весов повторы B сохраняются.

Для больших файлов та же модель хранится в SQLite spool:

```sql
mappings(a_number PRIMARY KEY, first_sequence, source_row)
mapping_b(a_number, b_number, sequence, source_row)
```

Бизнес-сервисы получают итераторы `Mapping` и не зависят от исходного формата.
