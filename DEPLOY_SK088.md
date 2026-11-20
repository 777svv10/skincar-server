# SkinCar SK-089 — открытая бета-генерация плёнок для всех

**Только после резервной копии PostgreSQL.** Репозиторий должен содержать ВСЕ файлы вложенных папок `film-packs`, а не только индекс.

## Что меняется
- Все 3 коллекции и 151 SKU доступны для открытого теста всем авторизованным пользователям, при наличии кредитов.
- Режим по умолчанию — `FILM_GENERATION_MODE=public_beta`.
- `FILM_APPROVED_SKUS` теперь необязателен и используется только если нужно срочно сузить каталог.
- Названия коллекций в Netlify отображаются полными названиями: `VEGA Color PPF`, `VEGA Color Premium`, `IRISTEK Colors`.

## Развёртывание
1. Сделать резервную копию PostgreSQL и создать резервный Git tag/branch.
2. Распаковать архив `SkinCar_SK089_20-11_GITHUB_RAILWAY_FULL.zip` непосредственно в корень репозитория `skincar-server`; не добавлять ZIP как файл.
3. Проверить наличие в GitHub:
   - `film-packs/index.json`
   - `film-packs/vega-color-ppf/pack.json` + `assets/thumbs/` и `assets/references/`
   - `film-packs/vega-color-premium/pack.json` + активы
   - `film-packs/iristek-colors/pack.json` + активы
   - `film-library.js`, `generations.js`, `sk088-film-access.test.js`, `sk088-film-combo.test.js`
4. В Railway Variables:
   - удалить старое значение `FILM_PILOT_TESTER_IDS`, если оно больше не нужно
   - если раньше был `FILM_GENERATION_MODE=pilot`, сменить его на `FILM_GENERATION_MODE=public_beta` либо удалить переменную совсем
   - `FILM_APPROVED_SKUS` оставить пустым/не задавать, чтобы открыть все 151 позиции всем пользователям
5. Дождаться Railway `SUCCESS`, проверить `/health` и логи. База данных/миграции не меняются.
6. Развернуть `SkinCar_SK089_20-11_NETLIFY_FULL.zip` как полный ручной деплой Netlify.
7. Повторно открыть Mini App и протестировать создание с плёнкой, дисками, тонировкой и удалением ГРНЗ.

## Проверка готовности
`node --test sk008-film.test.js sk088-film-access.test.js sk086-film-staging.test.js sk088-film-combo.test.js`

## Происхождение материалов
`skuVerified:false` и `imageRights:unverified` сохранены достоверно. `public_beta` разрешает тестировать пользовательские референсы, **не подтверждая** прав производителя. Режим `live` не включать до независимой проверки.
