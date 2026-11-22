SKINCAR SK-106 — ГИТХАБ-ПАТЧ (в корень репозитория skincar-server)

ПРАВИЛЬНЫЙ ПОРЯДОК:
1) Не загружай сам zip в GitHub. Распакуй его.
2) Открой github.com/777svv10/skincar-server (ветка main) и выбери Add file -> Upload files.
3) Загрузи перечисленные ниже файлы в КОРЕНЬ репозитория. Замени одноимённые существующие файлы.
4) Дождись статуса SUCCESS в Railway, проверь Telegram webhook и /start, /garage.
5) В Railway Variables при необходимости отдельно задай BOT_ADMIN_IDS=<твой подтверждённый Telegram ID>.
6) Финансовые команды по умолчанию OFF: BOT_CREDIT_ADMIN_ENABLED=false, BOT_PROMOS_ENABLED=false. Включать только после QA.
7) Netlify не меняется: пользователь пока не публиковал SK-105; никаких действий на Netlify не требуется.

Изменённые и новые файлы:
 - bot-service.js
 - bot-admin-ops.js
 - sk106-bot.test.js
 - sk106-bot-admin.test.js
 - app.js
 - server.js
 - schema.sql
 - generations.js
 - telegram.js
 - setup-webhook.js
 - .env.example
 - DEPLOY_SK106_TELEGRAM_BOT.md

Актуально до SK-106: рабочая серверная версия GitHub/Railway была SK-101, коммит 065bcf8.
В этом ZIP нет настоящих токенов, файлов .env, базы PostgreSQL или пользовательских фотографий.
Важное: server.js загрузит schema.sql и создаст дополнительные таблицы; их нельзя заменять старой schema.sql.

Для возврата: восстановить прежний GitHub commit SK-101; дополнительные таблицы можно оставить без удаления.
