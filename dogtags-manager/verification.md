# Локальная проверка автономного Dogtags — 27 ноября 2026

## Работающий экземпляр

Поднят отдельный Compose project `reporting-dogtags` из этого репозитория. API/PostgreSQL/RabbitMQ healthy; worker и dispatcher работают; init завершился с кодом 0. Публичных port bindings у API, БД и очереди нет. Reporting backend подключён к выделенной gateway-сети; БД и очередь находятся только в private-сети. Рабочие volumes прежнего Dogtags не использованы и не изменены.

Локальный Reporting на localhost:5173 подключён к этому API. Проверены настоящий вход Reporting, запрет запроса без сессии (401), health, сессия Dogtags и отдельный пустой архив. Исходный `dogtags-manager-api-1` во время проверки остановлен.

Через API с production-origin `https://t2product.ru` проверены HTTPS-схема и Secure cookie, загрузка синтетического CSV, реальная обработка Celery worker до PREPARED, approval, скачивание всех артефактов с проверкой размера и SHA-256. Синтетическая запись удалена штатным API. Затем экземпляр переключён на локальный origin для localhost.

## Регрессионные проверки

- Reporting gateway: 8/8 unittest, включая HTTPS и запрет подмены X-Forwarded-Proto браузером. Новый HTTPS-тест сначала падал на прежнем коде.
- Bootstrap: 1/1 unittest в случайной отдельной PostgreSQL schema. Проверены пустая установка, публикация отличающейся версии правил и повторный bootstrap: активные правила, число публикаций и владелец сохраняются. Временная схема удалена после теста.
- Сборка нового backend-образа Dogtags и пересборка Reporting backend прошли. Compose-конфигурации локального и offline-подключения валидны; shell-синтаксис bundle-скрипта проверен.
- Domain-тесты перенесённого backend: 227 прошли, 29 упали. На неизменённом Git-снимке исходного Dogtags `534b82f` с теми же зависимостями получены те же 227/29 и тот же набор упавших тестов. Исходные backend/contracts перенесены без правок; существующие ошибки этих тестов здесь не исправлялись.

## Границы проверки

Сам сервер t2product.ru, его TLS/nginx, секреты и фактические ресурсы не проверялись и не менялись. Bundle для архитектуры этого сервера не собирался: скрипт и отдельный offline Compose подготовлены, но полный перенос docker save/load в закрытый контур ещё не выполнен. Существующие ошибки общего TypeScript-check Reporting и исходных domain-тестов Dogtags остаются. Изоляция сервисов не создаёт отдельный архив на каждого пользователя: доступные вкладке пользователи Reporting используют общее рабочее пространство данного экземпляра Dogtags.

## Повторная проверка bootstrap

Из корня Reporting с локальным env-файлом:

```bash
docker compose --env-file .env.local -p reporting-dogtags \
  -f dogtags-manager/compose.yml run --rm --no-deps \
  -v "$PWD/dogtags-manager/tests:/tests:ro" init \
  python -m unittest discover -s /tests -v
```

Тест создаёт и удаляет только случайную тестовую схему; рабочие таблицы не изменяет.
