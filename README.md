# How Much AI

How Much AI is a self-hosted dashboard for subscription usage limits across multiple AI accounts. It currently tracks Claude (Anthropic) and ChatGPT/Codex (OpenAI), refreshes readings automatically, and can send reset or high-usage alerts.

This repository is the open-source, single-tenant edition. It has no hosted sign-in, billing, marketing site, analytics, or provider lock. You run it, choose where its encrypted vault is stored, and control every secret it uses.

> How Much AI is unofficial and is not affiliated with Anthropic or OpenAI.

## Quick start

You need Node.js 22.18.0 or newer.

```bash
git clone https://github.com/SeraphKc/how-much-ai.git
cd how-much-ai
npm ci --ignore-scripts --include=dev --audit=false --fund=false
cp .env.example .env.local
npm run dev
```

Before starting, set `APP_PASSWORD` in `.env.local` to an independent strong value. Then open [http://localhost:3000](http://localhost:3000). The development command binds explicitly to `127.0.0.1` and stores accounts in an encrypted local vault under `.data/`.

Development fails closed when `APP_PASSWORD` is missing. Production fails closed unless `APP_PASSWORD`, `AUTH_SECRET`, and `VAULT_ENCRYPTION_SECRET` are independent and each contains at least 32 characters after trimming. No supported mode enters unauthenticated open access.

## Connect accounts

Click **Connect account**, then choose a provider:

- **Claude** — use the private app sign-in flow and paste the returned `code#state`. A same-machine Claude Code login and Convex-backed device pairing are also available as convenience options. `claude setup-token` is inference-only and cannot read the subscription-usage endpoint.
- **ChatGPT/Codex** — read the Codex login from the machine running the app or paste the contents of `~/.codex/auth.json`.

Credentials are encrypted in the server-side vault and are never returned to the browser after connection. Local and device-pairing shortcuts may share a rotating CLI credential; the provider-specific private sign-in is the more durable choice when available.

Same-machine CLI discovery is automatic in development. In a production-mode local install it requires `ENABLE_LOCAL_CONNECT=1`; never enable that route on a remote server.

## Secure Windows local mode

For the reviewed, authenticated, loopback-only Windows installation and its exact threat boundary, see [Secure Windows local mode](docs/WINDOWS_SECURE_LOCAL.md). The installer records ten exact bootstrap hashes, registers exactly two tasks (`HowMuchAI-Service` and `HowMuchAI-Window`), and creates the current user's verified `Programs\How Much AI.lnk`. The shortcut contains only the state root and public hashes, never a URL, secret, ticket, account, provider, or credential.

Before reopening the dashboard, the launcher verifies its own hash, the runtime/integrity anchors, and both exact task plans. A `Ready` service starts Service then Window; a `Running` service starts Window only; any missing, foreign, or mutated task or any other state starts neither. Installation verifies the shortcut path, all fields through a Windows Shell COM round trip, its private ACL, and non-reparse path boundaries. An exact shortcut is idempotently accepted, while a mismatch is refused rather than overwritten. Creation uses candidate-first validation and identity-aware rollback; the final verifier repeats the checks and scans installed state for secret material. Removal likewise deletes the shortcut and exactly two tasks only after their ownership plans verify. The browser session uses challenge/server-proof/client-proof HMAC with the protected `AUTH_SECRET`; it never transmits `APP_PASSWORD`.

## Usage dashboard

The dashboard is available regardless of whether any notification channel is configured. Each provider-returned limit is its own row. Claude can return the five-hour row, the overall weekly row, connected-app limits, and model-scoped weekly rows such as Opus or Sonnet. OpenAI rows are shown only when its usage response returns them; a returned session row is labeled **Codex · 5 saatlik limit**. This does not claim that every ChatGPT account has a universal five-hour limit.

The provider-native **used** percentage is the primary number and the progress fill grows from 0% to 100% used. Remaining percentage is secondary. Remaining alone controls the urgency badge/color and the strict-local notification thresholds, so a full fill means fully used rather than fully available. Reset countdown/exact time and stale/error status are shown when the provider supplies enough information.

## Choose a storage mode

The server selects one backend from the environment:

| Backend | Configuration | Best for | Hosted scheduled notifications |
| --- | --- | --- | --- |
| Encrypted file | Production: `VAULT_ENCRYPTION_SECRET`; development: none | One persistent machine | No |
| Convex | `CONVEX_URL` + `VAULT_ACCESS_SECRET` + `VAULT_ENCRYPTION_SECRET` | Durable or multi-instance hosting | Yes |
| Redis/KV REST | URL + token + `VAULT_ENCRYPTION_SECRET` | Durable hosting without Convex | No |

Development local-file storage can create `.data/vault.enc` and `.data/vault.key`. Production uses the required `VAULT_ENCRYPTION_SECRET`. Back up the whole `.data` directory; the encrypted vault cannot be recovered without its matching key.

See [Self-hosting](docs/SELF_HOSTING.md) for complete Convex, Redis, notification, backup, reverse-proxy, and production instructions. Every supported variable is documented in [`.env.example`](.env.example).

## Put it on a network safely

Copy the example environment file and replace the blank values you need:

```bash
cp .env.example .env.local
```

Every production deployment must set independent values, each at least 32 characters after trimming, for:

```dotenv
APP_PASSWORD=
AUTH_SECRET=
VAULT_ENCRYPTION_SECRET=
```

Production vault generations encrypted by an older login password, Convex access secret, or the historical public fallback fail closed with a migration-required error. Preserve the ciphertext and use a controlled offline migration or rotate/reconnect the provider credentials; never downgrade the app to spend legacy-key credentials.

Then verify and build:

```bash
npm ci --ignore-scripts --include=dev --audit=false --fund=false
npm test
npm run typecheck
npm run build
npm start
```

Terminate TLS at a trusted reverse proxy or hosting platform. Keep `TRUST_PROXY_IP_HEADERS=0` unless that proxy overwrites the forwarded client-IP headers itself. Serverless platforms must use Convex or Redis because their local filesystems are not durable.

## Notifications

The reviewed Windows strict-local installation has a separate on-device notification path. It uses the current dashboard refresh stream, privacy-minimized browser storage, Web Locks, and the same-origin service worker. It requires no notification environment variable and does not import or call Convex, VAPID, Telegram, webhook, or other hosted delivery paths. It works only while the reviewed local browser/app process is open or minimized; closing it stops live device notifications until the app is opened again.

Strict-local permission is requested only after the user presses the permission button. Denied, unavailable, or revoked permission fails closed, does not advance an undelivered event, and is surfaced without repeated prompts. Automatic refresh must remain enabled for live notifications; manual refresh uses the same rules. The first fresh observation seeds state silently, stale or failed readings never alert, and each limit is tracked independently. Remaining allowance thresholds are exactly 50%, 40%, 30%, 20%, 15%, 10%, 5%, and 0%; the reset message contains the exact text `limit sıfırlandı`. If one reading crosses several thresholds, only the tightest newly crossed threshold is delivered.

Hosted scheduled notifications are a separate, Convex-only topology: their configuration, detector state, subscriptions, lease, and five-minute scheduler are stored in Convex. Available hosted channels are:

- browser Web Push;
- Telegram;
- a generic JSON webhook.

Outside reviewed Windows strict-local mode, Redis-only and file-only installs still provide the complete visual dashboard, provider tracking, encrypted credentials, refresh coordination, and local countdowns, but no scheduled notification channel. Their notification panel explains that Convex is required for hosted alerts.

## Development

Run all checks from the repository root:

```bash
npm ci --ignore-scripts --include=dev --audit=false --fund=false
npm test
npm run typecheck
npm run build
```

The build also checks that local vault material was not copied into the production output. Contributor and AI-agent rules are in [AGENTS.md](AGENTS.md). CI runs the same commands on every push and pull request.

## Security and license

Do not commit `.env*`, `.data/`, provider credentials, database tokens, or generated vault backups. If you find a vulnerability, follow [SECURITY.md](SECURITY.md) and do not publish credential material in an issue.

How Much AI is released under the [MIT License](LICENSE).
