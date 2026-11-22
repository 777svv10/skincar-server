# SkinCar SK-110 — безопасность API и диагностика

Компоненты: PostgreSQL rate-limit, requestId + структурированные ошибки, пилотные Stars без вшитых ID, базовые защитные заголовки Netlify.

## Внедрено в Railway
- Rate-limit для подписанного Telegram-логина 15/мин, 120/час; загрузки фото 6/мин, 50/час; генерации 5/мин, 40/час; другие мутации 120/мин, 1500/час. Не заменяет действующий дневной лимит генераций и защиту от затрат OpenAI.
- Аккаунты разделены по хешам Telegram ID, счётчики атомарные в PostgreSQL (перед большой загрузкой), 429 + Retry-After.
- X-Request-ID в HTTP, requestId в JSON, безопасный event-лог Railway без токена, URL и изображения.
- Удалён старый hardcoded пилотный список из payments.js; сохранён в PAYMENT_TESTER_IDS Railway Variables до деплоя.
- Аддитивная миграция таблицы api_rate_limits с автоочисткой.
- Публичный GitHub остаётся PUBLIC, старые коммиты могут содержать прежние ID — отдельно провести исторический secret scan.
- Реальный нагрузочный тест и два-тестовых-аккаунта IDOR остаются до публичной беты.

## Подготовлено для Netlify (НЕ опубликовано)
- _headers: X-Content-Type-Options, Referrer-Policy, Permissions-Policy, Cache-Control HTML. CSP и iframe-политики без тестирования на Telegram WebView НЕ включались.

## Следующее — SK-111
- Сообщение о проблеме на странице «Помощь» и в аварийном результате; сохранение requestId, route, UTC, generationId, app version.
- Telegram bot screenshot/file_id + описание, тикет, безопасная админка, correlation по ID и уведомления.
- Запрещена автоматическая передача токенов, исходных фото и персональных данных в сторонние системы.
