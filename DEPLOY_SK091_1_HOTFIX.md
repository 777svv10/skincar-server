# SkinCar SK-091.1 — Hotfix EXDEV, 20 November 2026

## Что произошло

Последняя серверная сборка SK-091 была загружена в корень GitHub корректно, но старт Railway провалился:

`EXDEV: cross-device link not permitted, rename '/app/film-packs' -> '/app/.film-packs-old-25'`.

В Railway `/app/film-packs` может быть каталогом на другом файловом томе. Старый `prepare-film-packs.cjs` пытался переместить корень этой папки и вызывал ошибку EXDEV. Запуск `server.js` не происходил.

## Установка исправления — только 1 файл

1. Открой GitHub `777svv10/skincar-server` и загрузи в **корень** новый `prepare-film-packs.cjs` (с заменой существующего). НЕ в `film-packs/`.
2. Проверь в корне наличие неизменных `film-packs.bundle.tar.gz` и `package.json`. Их НЕ нужно загружать повторно.
3. Сделай Commit changes. Railway пересоберёт сервер автоматически.
4. В Railway → Variables проверь: `FILM_GENERATION_MODE=public_beta`. Если переменная уже установлена правильно, оставь её как есть. `FILM_APPROVED_SKUS` не должен ограничивать каталог.
5. В Railway → Deploy Logs проверь строку `SK091 film references ready: 151 models, 306 files` и `SkinCar server ready`.
6. После статуса SUCCESS проверь `GET /health` и генерацию одной плёнки Standard в Telegram Mini App.

## Разница

Только код `prepare-film-packs.cjs`: вместо переименования корневого каталога `film-packs` он распаковывает в него отдельные файлы по безопасным временным именам, на той же файловой системе. `index.json` и stamp пишутся последними.

Никаких миграций PostgreSQL. Netlify и API не изменены.
