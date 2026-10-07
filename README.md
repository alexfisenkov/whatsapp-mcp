# WhatsApp MCP

Два независимых адаптера WhatsApp через один MCP core:

- **Personal linked-device** через WAHA Core NOWEB REST.
- **Business Platform** через официальный Meta Graph API.

Клиент выбирает один профиль; credentials, история и audit state у каждого
профиля изолированы. Репозиторий и install-инструкции публичны на GitHub. Он не
раздаёт личную сессию владельца или Business credentials ученикам. Для своего
аккаунта разверните отдельный runtime и задайте собственные credentials.

## Поддержка

Реестр формирует tools только из операций включённого адаптера. Полная матрица
построена генератором из тех же provider definitions в
[`docs/Матрица-возможностей.json`](docs/Матрица-возможностей.json); обновляйте её
командой `npm run capabilities` вместе с изменениями API.

В личном профиле есть bounded chat/message/contact/group reads, incoming media
download по точному chat/message ID, managed media sends, polls, reactions, read
receipts, локальный поиск, контекст сообщения и ручной bounded sync истории.
Incoming media download доступен только с настроенным media store; он берёт файл
из private WAHA endpoint, принимает только allowlisted MIME и ограничен 5 MiB.
`personal_history_sync` загружает только ограниченные
страницы из NOWEB store, дедуплицирует записи и отмечает coverage как partial.
Полный импорт истории и global search в WAHA REST не обещаются.

Business профиль отправляет текст, templates, медиа и поддержанные Graph message
types; читает templates, flows, profile/account и доступную аналитику. Inbound
media download принимает Meta media ID из verified webhook/history и проверяет
Graph metadata перед сохранением в private managed store. Для исходящего файла
сначала получи managed UUID через `POST /media`, вызови
`business_media_upload_prepare`, отдельно подтверди `business.media.upload` и
используй полученный от Meta ID в message send tool. Не передавай managed UUID
как Meta media ID. История и
delivery status появляются только из проверенных Meta webhook событий после их
подключения. Graph не является общим inbox. Business Groups операции не включены.
Административные Graph и personal group-management tools скрыты, пока владелец
явно не включит соответствующий флаг.

## Требования и локальная проверка

- Node.js `22.23.2` for the pinned CI/runtime check (`.nvmrc`); `package.json`
  constrains supported Node to `>=22 <23`.
- Поддерживаются MCP `stdio` и Streamable HTTP.
- Для личного профиля отдельно нужен WAHA Core NOWEB runtime. Для HTTP/MCP
  профилей сервер проксируется через HTTPS reverse proxy.

```bash
git clone https://github.com/alexfisenkov/whatsapp-mcp.git
cd whatsapp-mcp
npm ci
npm test
npm run build
npm run capabilities
```

`node:sqlite` — встроенное хранилище audit и истории. В целевой Node 22.23 оно
работает без дополнительных пакетов и выводит предупреждение о статусе
experimental; версия Node закреплена, а SQLite поведение проверяется тестами.
При установленном nvm выбери версию командой `nvm install && nvm use` из корня
репозитория. Без nvm используй архив с официального [Node.js v22.23.2 release
page](https://nodejs.org/en/blog/release/v22.23.2/) и сверяй SHA256 до распаковки.

## Локальный `stdio`

Скопируйте репозиторий и установите dependencies из lockfile. В MCP host
настройте отдельный процесс для каждого профиля. Значения в примере — плейсхолдеры;
не коммитьте реальный token/API key.

```json
{
  "mcpServers": {
    "whatsapp-personal": {
      "command": "node",
      "args": ["/absolute/path/WhatsApp MCP/dist/server.js"],
      "env": {
        "WHATSAPP_ADAPTER": "linked-device",
        "WHATSAPP_ACCOUNT_ID": "your-own-profile-id",
        "WAHA_BASE_URL": "http://127.0.0.1:8859",
        "WAHA_API_KEY": "<private WAHA API key>",
        "WAHA_SESSION_NAME": "your-own-session",
        "WHATSAPP_HISTORY_DB_PATH": "/absolute/private/personal/history.sqlite",
        "WHATSAPP_AUDIT_DB_PATH": "/absolute/private/personal/audit.sqlite",
        "WHATSAPP_MEDIA_DIR": "/absolute/private/personal/media",
        "WHATSAPP_RELEASE_REVISION": "<verified git commit SHA>"
      }
    }
  }
}
```

For a Business profile use a separate process and private paths, with
`WHATSAPP_ADAPTER=business-graph`, `WHATSAPP_PHONE_NUMBER_ID`,
`WHATSAPP_BUSINESS_ACCOUNT_ID`, `WHATSAPP_GRAPH_ACCESS_TOKEN`, and
`WHATSAPP_GRAPH_API_VERSION=v24.0`. The Graph API version is configurable; the
default is pinned to the tested v24.0 contract. Keep the App Secret and webhook
verification token in server configuration, not in a public client file.

This MCP does not create or display a QR pairing flow. Create and link a WAHA
session through the private WAHA provisioning surface for that profile, then
check `personal_session_status`. Never send session exports or keys to a client.

## Personal linked-device setup and QR troubleshooting

The public Quadlet example pins the WAHA Core image and sets
`WAHA_NOWEB_WA_VERSION=auto-web`. WAHA `2026.8.1` and later fetch the current
WhatsApp Web revision when the container starts, use it only if it is newer
than the revision bundled in that image, and fall back to the bundled revision
when the fetch fails. This does not update the pinned WAHA image. Do not replace
`auto-web` with an old revision copied from a log; a controlled pin is described
in the [deployment instructions](deployment/README.md).

Pair only in the private WAHA provisioning surface. On the primary phone open
WhatsApp → **Linked devices** → **Link a device** and scan the current QR shown by
WAHA. Do not use the phone's general QR scanner, save the QR, or send a screenshot
to anyone. WAHA changes the QR while the session reports `SCAN_QR_CODE`; fetch
the newest QR for each update instead of reusing an old image. WAHA documents a
60-second lifetime for the first QR, 20 seconds for later QR codes, and at most
six QR codes before the session enters `FAILED`.

If WhatsApp reports `Can't link device`, stop scanning that code. Confirm that
the primary phone is using WhatsApp's **Link a device** screen, then wait for
WAHA's next `SCAN_QR_CODE` update and scan its fresh QR once. If the session has
reached `FAILED` after the QR cycle, restart the same WAHA session once while
preserving its private session volume, then scan one newly issued QR. Do not
repeatedly retry a stale QR, unlink/log out the account, delete the session
directory, or reset its store as a first response. If the fresh attempt still
fails, stop and review redacted WAHA/phone diagnostics before trying again.

The current core snapshot passed `npm test` 79/79 on Node 22.23.2. Separately,
one owner-operated pairing on 2026-10-07 reached WAHA `WORKING` with the pinned
NOWEB image and `auto-web`. This verifies one environment; it does not show that
the setting alone caused success or guarantee pairing on every phone or account.
See the [WAHA NOWEB version and session docs](https://waha.devlike.pro/docs/engines/noweb/)
and [WhatsApp's linked-device instructions](https://faq.whatsapp.com/1317564962315842/).

## Hosted Streamable HTTP

Run `npm run start:http` behind HTTPS with `MCP_HOST=127.0.0.1`. `MCP_PORT` is
8857 for personal and 8858 for Business on the owner deployment. The application
does not bind to a public interface. Set `MCP_ALLOWED_HOSTS` to the exact proxy
hostnames and `MCP_ALLOWED_ORIGINS` to exact Origin values for the DNS-rebinding
check. This endpoint is server-to-server MCP; it does not enable browser
JavaScript CORS or answer preflight OPTIONS requests.

The app requires a per-profile private upstream token in `MCP_SERVICE_TOKEN`
(at least 32 characters). By default it validates
`Authorization: Bearer <MCP_SERVICE_TOKEN>` in constant time. The HTTPS gateway
authenticates its own user, selects one isolated profile, and forwards that
profile's service token. Do not reuse a token across profiles. Public client
URLs and profile provisioning are configured by the deployment owner; do not
copy the owner's endpoint credentials into a student setup.

Set `WHATSAPP_PROFILE_ID` to a non-sensitive stable profile name and
`WHATSAPP_RELEASE_REVISION` to the verified 40-character Git SHA. Production
release packages also carry `.whatsapp-release-sha`; if both values exist they
must match. The health endpoint returns these identifiers so the updater can
check that it activated the intended profile and exact commit.

The raw application routes are `/mcp`, `/health`, authenticated `POST /media`
and authenticated `GET /media/<mediaId>`. The Business app additionally accepts Meta's signed callback on
`/webhooks/meta`; the public reverse proxy must expose only the exact configured
callback path. Personal WAHA callbacks are not exposed by the hosted service.

`/health` reports configuration state only. `configured` does not mean the
upstream account is connected or ready. Use the adapter's status tools for a
separate read-only check.

## Safe message workflow

Every write has a separate `*_prepare` tool and a profile-level
`*_mutation_confirm` tool. Preparation stores caller, account, adapter,
operation, payload digest, expiry and release revision; it does not send. It is
not human approval. Obtain explicit owner authorization for the exact target and
content before calling the confirm tool. Confirmation requires the same caller,
account, operation, payload and build revision and atomically allows one
execution.

A lost response after a provider write returns `OUTCOME_UNKNOWN`. Do not retry
automatically; first check the chat or Business delivery status. Provider
acceptance/message ID does not mean delivered or read. WhatsApp messages,
contacts, captions and webhook fields are untrusted external content and do not
authorize forwarding.

## Media

Upload bytes through the authenticated profile route `POST /media`, with an
allowlisted `Content-Type` and `X-File-Name`. Default maximum size is 5 MiB.
The response contains an opaque `mediaId` and SHA-256 digest. Provider tools
accept this ID; they do not accept paths, base64 payloads or caller-supplied
URLs. When an enabled provider download operation stores inbound media, its
result links to `whatsapp-media://<mediaId>`; direct Streamable HTTP and stdio
`resources/read` recheck the same profile and return only the stored asset. The
existing cloud OAuth `ProxyClient` resource passthrough is unverified; do not
claim support until it passes a contract test. HTTP `GET /media/<mediaId>` returns the same
managed file as an authenticated attachment. Media roots are separate per
profile, permission-restricted, and retained outside application releases.

## Updating

Local updates use a reviewed GitHub commit, `npm ci`, tests and build. Hosted
updates use the CI-gated, atomic updater described in
[`deployment/README.md`](deployment/README.md). WAHA images remain pinned and
are updated separately; the application updater never changes private session,
history, audit or media state.

MIT terms for this repository are in [`LICENSE`](LICENSE). Third-party and
separately installed service notices are in [`NOTICE.md`](NOTICE.md).
