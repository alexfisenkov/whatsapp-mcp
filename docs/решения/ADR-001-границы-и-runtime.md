# ADR-001: два адаптера, typed MCP core и per-account runtime

- Статус: принято 2026-10-06; production deployment gates указаны внизу.
- Решение владельца: одновременно personal linked-device и official Business API;
  публичный источник — GitHub; runtime обновляется только после CI для exact SHA.

## Контекст

Нужен широкий WhatsApp MCP для личного аккаунта, отдельный MCP для WhatsApp
Business, локальный stdio, hosted Streamable HTTP и install instructions для
учеников. Personal и Business credentials не должны пересекаться. Нужна
проверяемая capability coverage, durable audit mutation flow, bounded searchable
history и automatic deploy только проверенного commit/release.

## Рассмотренные варианты

1. **WAHA Core REST + собственный typed TypeScript MCP core + отдельный Meta
   Graph adapter.** Не переписывает WhatsApp linked-device protocol; один набор
   MCP policies работает поверх двух отдельных адаптеров.
2. **Прямой Baileys adapter + Graph.** Убирает container-runtime зависимость,
   но переносит на проект поддержку linked-device protocol/session lifecycle,
   reconnect и API surface.
3. **WAHA встроенный MCP + отдельный Business MCP.** Меньше собственного кода,
   но tools, auth, tenant checks и policy boundaries остаются в нескольких
   несовместимых слоях.

## Решение

Выбран вариант 1. Personal provider pinned к WAHA Core 2026.9.2 NOWEB REST;
Business provider — Meta Graph API. При этом server сейчас не имеет Docker/
Podman; infra workstream владеет rootless container runtime и isolated networking
для WAHA. Не менять provider молча ради обхода инфраструктурного препятствия.

Собственный MCP core объявляет tools только из provider-backed typed definitions.
Personal и Business запускаются как отдельные account instances, с отдельным
private state, service token audience и engine/provider credentials. Публичный
GitHub package не включает server runtime, linked-device sessions или secrets.

## Guarded writes

Изменяющий tool сначала показывает prepare; второй confirm инструмент принимает
точную operation, profile, payload digest, expiry и release revision. Подготовка
не означает согласие человека. Confirm вызывается только после отдельного
явного owner authorization и атомарно claim-ится в durable audit store до
единственного upstream write. Release SHA mismatch блокирует подтверждение,
повторный claim невозможен, timeout сохраняет `OUTCOME_UNKNOWN` без автоповтора.

## История и callback

Personal history индексируется ограниченными pulls из WAHA NOWEB store; история
не считается полной. Graph Business history — только callback события после
настройки и проверки webhook. Business Group support не публикуется без прямой
проверки eligibility и актуального Meta contract.

## Последствия

- Вебхосту нужен container runtime для WAHA и приватная сеть до loopback engine.
- Node target `>=22 <23`; SQLite встроен в Node 22, но API имеет experimental
  статус и требует закреплённой версии и регрессионных проверок.
- Encryption-at-rest, retention и production backup остаются частью server
  operations, не реализуются фейковым application flag.
- Gateway bearer должен быть преобразован в exact per-profile private
  `MCP_SERVICE_TOKEN`; generic shared token between profiles запрещён.
- Public client install docs описывают provisioning собственных credentials;
  owner runtime не является shared learner WhatsApp account.

## Deployment gates

Infra workstream проверяет rootless WAHA isolation, exact nginx routes and auth,
profile ownership, atomic verified-SHA update, service health/readiness, rollback,
state backup/permissions и no public session/media path. Local build/test green не
снимает эти gates. QR pairing, live Graph webhook и production delivery в этом
ADR не считаются выполненными.
