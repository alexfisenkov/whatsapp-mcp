# Third-party notices

The lockfile pins these direct packages for this release:

- `@modelcontextprotocol/sdk` 1.32.1 — MIT.
- `zod` 4.6.5 — MIT.
- Development only: `typescript` 5.9.3 — Apache-2.0; `@types/node` 22.19.11 — MIT.

Their upstream copyright and license texts remain with each dependency. A
source redistributor should retain their notices when bundling or copying those
third-party files.

The WhatsApp linked-device engine is a separately installed WAHA Core service
(upstream release and Apache-2.0 license: [WAHA repository](https://github.com/devlikeapro/waha)).
This repository calls its HTTP API and does not include or redistribute the
WAHA image. Review the license and notices for the exact separately installed
image before deploying it.

The Business adapter calls Meta's Graph API. This repository does not include
Meta SDK code or grant rights to Meta services, trademarks, APIs, or WhatsApp.

Project source files are licensed under MIT as stated in `LICENSE`. This license
does not relicense third-party services, separately installed engines, or
provider content.
