# SK-008 — архивная записка о первоначальном патче

В первоначальном накопительном архиве этот файл описывал отдельно устанавливаемый Railway-патч. В текущем FULL-контейнере 19.11 патч **уже объединён** с GitHub-сервером. Не применяйте патч повторно и не удаляйте старые модули.

**Используйте `DEPLOY_19_11.md` как актуальную инструкцию.**


## SK-087 — film generation activation
- Film packs in `film-packs/` are active by default when items are marked `skuVerified: true` and `imageRights: "approved"`.
- `FILM_APPROVED_SKUS` is now optional. Leave it empty to allow all active verified SKUs, or set a comma-separated allowlist to restrict production.
