# Dogtags Manager в B2PROD

Вкладка после Voice использует адаптированный интерфейс Dogtags Manager из коммита `534b82f`. Исходники интерфейса и lockfile включены сюда; данные рабочего пространства в Git не поставляются.

## Запуск

1. Запустите отдельный стек Dogtags Manager: API, PostgreSQL, RabbitMQ, worker и dispatcher. Эта интеграция использует существующее рабочее пространство Dogtags; отдельные пользовательские пространства она не создаёт.
2. В окружении backend B2PROD задайте `DOGTAGS_MANAGER_URL` — адрес API, доступный из контейнера backend. В Docker Desktop локально это может быть `http://host.docker.internal:8000`. На dev-сервере используйте адрес сервиса Dogtags в сети или доступный backend URL; не адрес браузера пользователя.
3. Задайте `DOGTAGS_MANAGER_ORIGIN` равным `APP_ORIGIN` Dogtags. Это значение передаётся исходному API для его проверки Origin/CSRF. Origin и URL подключения могут различаться.
4. Пересоберите backend и frontend B2PROD штатным Compose для вашего окружения. Backend Dockerfile сам собирает интерфейс Dogtags и отдаёт его на `/dogtags-manager/`.
5. Войдите в B2PROD и откройте вкладку Dogtags Manager. Доступ к данным проверяется по сессии и правам B2PROD на каждом запросе.

Не публикуйте локальный `.env.local`, `docker-compose.local.yml`, исходные заявки, выгрузки БД и Docker volumes. Подключение и очистка архива действуют на общее рабочее пространство существующего Dogtags.

## Проверки

- Backend: `PYTHONPATH=backend python -m unittest discover -s backend/tests -p test_dogtags_proxy.py -v`.
- Интерфейс: в `frontend/` этой папки выполните `npm ci`, `npm run build`, `node --test tests/unit/*.test.mjs` на Node.js 24.
- Ресурсы PDF копируются из закреплённой зависимости `pdfjs-dist` во время сборки; сгенерированный `public/pdfjs/` в Git не хранится.

Существующие ошибки общего TypeScript-check B2PROD в других разделах этим изменением не исправляются.
