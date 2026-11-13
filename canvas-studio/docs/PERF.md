# Производительность Симметрики

План ускорения под ~50 одновременных редакторов. Опора: [COMPLIANCE.md](COMPLIANCE.md) §17.2, [BUGS.md](BUGS.md) PERF-001…006, [ADR 0001](adr/0001-stack-and-dependencies.md).

## Фаза 0 — Baseline (как мерить)

Эталон из COMPLIANCE (50 000 узлов, headless Chromium без GPU):

| Метрика | Бюджет | Было (COMPLIANCE) | Цель после фаз 1–3 |
|---------|--------|-------------------|---------------------|
| Кадр pan, масштаб 25 % | ≤ 18 мс | 156.1 мс | ≤ 40 мс mid-GPU, движение к 18 мс |
| Кадр pan, масштаб 100 % | ≤ 18 мс | 42.4 мс | ≤ 25 мс |
| Правка → отрисовка | ≤ 16 мс | 3.7 мс | сохранить |
| Первый кадр после открытия | — | 225 мс | снизить за счёт refs-картинок |
| JS-куча | ≤ 1.5 ГБ | 82 МБ | следить при тяжёлых фото |

Серверные таймеры (лог `perf:`):

- `live.save` — длительность записи snapshot + meta (см. `live.ts`)
- `pg.blob.write` — размер байт и мс записи в `simmetrika_blob` (см. `pg-storage.ts`)

Сценарии: файл 50k узлов; боевой макет с несколькими фото; 10 и 50 WebSocket на разных файлах / на одном.

Повторный замер — после фаз 1–3, таблицу «стало» дописать сюда.

## Фаза 1 — Pan/zoom LOD

- Более агрессивный LOD при малом zoom (`lodCoarse` в Canvas2DRenderer).
- Динамический бюджет missing-тайлов в `tiles.ts` (жест vs rest).
- Exact tiles только после `REST_MS`; во время pinch — stand-in / base.

## Фаза 2 — Картинки вне JSON ответа

На диске/PG картинки уже `i{hash}` отдельно от `snapshot.json`. Дальше:

- `GET /api/files/:id?format=lines` отдаёт документ **без** inline base64 (`blobMimes` → пустые `blobs`).
- `GET /api/files/:id/pictures/:hash` — сырые байты.
- Клиент подгружает картинки параллельно после open.

## Фаза 3 — Live / PG

- Цепочка `saving` уже coalescing на файл; таймеры в лог.
- Gzip для крупных JSON-blob (`snapshot.json`, версии) в `PgBlobs`.
- Реже auto-checkpoint при активном коллабе (`AUTO_EVERY`).

## Фаза 4 — Масштаб (runbook)

Рекомендуемый VM при основной нагрузке Симметрика (~50 online): **16 vCPU / 32 GB RAM / 500 GB NVMe**.

| Сервис | RAM ориентир |
|--------|----------------|
| canvas-studio | 10–14 GB |
| PostgreSQL | 10–12 GB (`shared_buffers` 4–6 GB) |
| reporting backend + UI + MinIO + ОС | 6–8 GB |

- Один инстанс studio + PG на одном хосте предпочтителен по latency.
- Второй инстанс canvas-studio за nginx **sticky** по `file_id` (или cookie сессии) — только если CPU Node стабильно **> 70 %** при 50 WS после фаз 1–3.
- Live WebSocket нельзя балансировать round-robin без sticky: комната файла на одном процессе.

Пример nginx (sticky по аргументу file в URL live):

```nginx
upstream canvas_studio {
  sticky cookie cs_route expires=12h;
  server 127.0.0.1:8080;
  # server 127.0.0.1:8081;  # второй инстанс при необходимости
}
```

## Фаза 5 — WASM gate

Перенос `core` / `geometry` / `layout` в Rust→WASM (**ADR 0001**) начинать **только если** после фаз 1–3 профиль снова показывает hot path в layout/merge на правке (сейчас NFR-PERF-005 уже в бюджете). Иначе ROI низкий относительно LOD и I/O картинок.

## Вне скоупа

Полный WebGPU scene renderer с нуля; смена стека редактора; оптимизация workbook/Voice.
