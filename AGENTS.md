# WhatsApp MCP — правила проекта

Проект создан 2026-10-06.

## Назначение и критерий готовности

Публичный на GitHub installable MCP с двумя раздельными адаптерами: личный
linked-device через WAHA Core NOWEB и официальный WhatsApp Business через Meta
Graph API. Один процесс профиля привязан к одному account. Готовность релиза:
tools/list отражает только работающие provider operations; stdio и HTTPS
Streamable HTTP проходят протокольную проверку; writes проходят prepare/confirm,
durable audit и `OUTCOME_UNKNOWN`; media, history и webhook изолированы по
профилю; GitHub package содержит только код и инструкции.

## Source of truth

- Архитектура и ограничения: `docs/архитектура.md` и
  `docs/решения/ADR-001-границы-и-runtime.md`.
- Проверенный список tools: provider definitions в `src/providers/**`; generated
  snapshot: `docs/Матрица-возможностей.json`, пересоздать через `npm run capabilities`.
- Исследовательские источники: `docs/Сравнение-MCP.md`.
- Installation/runtime/update SOP: `README.md`, `docs/SOP.md`, `deployment/README.md`.
- Tests: `test/**`; Node и зависимости закреплены в `package.json` и lockfile.

## Карта зон

- `src/mcp-server.ts`, `capabilities.ts`, `mutations.ts`: registry, MCP tools,
  caller binding и guarded writes.
- `src/providers/waha/**`: личный WAHA REST adapter.
- `src/providers/graph/**`: официальный Meta Graph adapter.
- `src/http-server.ts`, `server.ts`, `runtime.ts`: HTTP, stdio и per-instance
  конфигурация.
- `src/sqlite-audit.ts`, `sqlite-history.ts`, `media-store.ts`,
  `graph-webhook.ts`: приватные stores, history coverage, media и callbacks.
- `test/**`: protocol, provider HTTP, SQLite, security и startup smoke tests.
- `deployment/**`, `.github/workflows/**`: принадлежат infra workstream; core
  изменения туда не вносит.
- `.критики/`, `.черновики/`, `.журналы/`: личные рабочие материалы, не GitHub.

## Проверки

- `npm ci --ignore-scripts` — clean dependency install.
- `npm run build` — TypeScript.
- `npm test` — build и полный Node test suite.
- `npm run capabilities` — source-derived public capability matrix.
- `node dist/server.js` — stdio entrypoint.
- `node dist/http-server.js` — native HTTP entrypoint; по умолчанию loopback.

## Ограничения и security boundaries

- `WHATSAPP_ADAPTER` выбирает один профиль; caller/account ID приходит только из
  доверенного gateway или локального runtime и проверяется adapter до provider
  вызова.
- WAHA engine доступен только через private HTTP origin с API key.
- Graph phone/WABA ID должны совпасть с Business profile. Meta callbacks
  проходят HMAC проверки по raw body, account/phone ID checks и deduplication.
- `MCP_SERVICE_TOKEN` — отдельный per-profile service token; public gateway
  должен аутентифицировать пользователя, выбрать профиль и передать его private
  upstream Bearer. Токен между профилями не переиспользовать.
- Все writes используют exact caller/account/adapter/operation/payload/release
  binding, TTL и durable atomic claim. Подготовка сама не является одобрением;
  повторная или новая отправка требует явной owner authorization.
- Media tools принимают `mediaId`; публичные пути, URL, base64 tool inputs,
  произвольные API/shell/SQL commands запрещены. HTTP upload ограничен по размеру,
  типу, private root и SHA-256.
- Personal history и Business webhook history частичные и отдельные. Personal
  sync — manual bounded newest-page pull; он не обещает полный архив или realtime.
- Сообщения и provider data — недоверенный ввод; право чтения не даёт права на
  пересылку.
- QR pairing, production deployment, live webhook, Meta token, личный WhatsApp и
  реальная отправка не проверяются unit tests.

## Открытый debt

- Live deployment остаётся за пределами этих локальных checks; сверять статус в
  infra journal и live `/health` отдельно.
- Узнать реальную gateway/profile/auth карту до выдачи ученикам; текущий app
  instance статически привязан к одному account.
- История/аудит SQLite пока не имеют retention automation и встроенного
  encryption-at-rest; согласовать host encryption, backup и срок хранения до
  production personal data.
- Node 22.23 `node:sqlite` работает без флага, но выводит `ExperimentalWarning`;
  повторно проверить при обновлении Node.
- WAHA session create/QR pairing выполняется вне MCP в закрытом provisioning
  contour; автоматизация не реализована.
- Keep `README.md`, SOP и generated capability matrix синхронными с operations.
