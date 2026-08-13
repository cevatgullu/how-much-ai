# Security policy

How Much AI stores renewable provider credentials and should be treated like a password manager for the connected accounts. Security reports are welcome and should be handled privately.

## Supported version

Security fixes are made on the latest revision of the default branch. Older commits, forks, and modified deployments are not supported unless the issue also reproduces on the current default branch.

| Version | Supported |
| --- | --- |
| Latest default branch | Yes |
| Older revisions | No |

## Report a vulnerability privately

Use GitHub's private vulnerability reporting flow for [SeraphKc/how-much-ai](https://github.com/SeraphKc/how-much-ai/security/advisories/new). Do not open a public issue, discussion, or pull request containing exploit details, credentials, vault ciphertext, environment files, or provider responses.

If private vulnerability reporting is unavailable, contact the repository owner through their GitHub profile and ask for a private reporting channel. Share only a high-level description until that channel is established.

Include:

- the affected commit;
- deployment topology (local file, Convex, or Redis);
- the smallest reproducible sequence;
- expected and observed behavior;
- security impact;
- whether provider credentials or deployment secrets may have been exposed;
- a proposed fix, if you have one.

Redact access tokens, refresh tokens, cookies, passwords, Convex and Redis credentials, webhook secrets, VAPID private keys, and complete encrypted vault payloads. A maintainer will ask for additional evidence privately if it is necessary.

## High-priority issues

Examples include:

- a way to read or replace another saved credential;
- authentication or same-origin bypasses;
- credential leakage into browser responses, logs, build output, Git history, or third parties;
- vault decryption, key-confusion, rollback, or destructive-recovery flaws;
- refresh-token races that can invalidate the authoritative credential;
- command injection or unsafe target selection in device pairing;
- unbounded public endpoints, server-side request forgery, or notification destination confusion;
- exposure of `.data`, `.env*`, or deployment secrets.

Upstream vulnerabilities in Anthropic, OpenAI, Convex, Redis providers, browsers, or hosting platforms should also be reported to the affected upstream project.

## Deployment security requirements

- Development login fails closed when `APP_PASSWORD` is missing. Every production mode fails closed unless `APP_PASSWORD`, `AUTH_SECRET`, and `VAULT_ENCRYPTION_SECRET` are independent and each has at least 32 characters after trimming.
- Use HTTPS for every remote deployment.
- Keep the vault and all environment values on private, persistent storage.
- Use independent random values for `APP_PASSWORD`, `AUTH_SECRET`, `VAULT_ENCRYPTION_SECRET`, `VAULT_ACCESS_SECRET`, and `CRON_SECRET`. Convex rejects `VAULT_ACCESS_SECRET` values shorter than 32 trimmed characters in every deployment. Production also requires each configured Redis token and `CRON_SECRET` to contain at least 32 trimmed characters. A Redis token cannot reuse `VAULT_ACCESS_SECRET`; `CRON_SECRET` cannot reuse any application or backend credential; only the two Redis token aliases may identify the same backend credential.
- Production refuses credential ciphertext encrypted with the historical public fallback, `APP_PASSWORD`, or `VAULT_ACCESS_SECRET`. Preserve legacy ciphertext for controlled offline migration and rotate provider credentials if its old key may be public or guessable.
- Leave `TRUST_PROXY_IP_HEADERS=0` unless a trusted reverse proxy overwrites forwarding headers.
- Keep the reviewed strict-local device-notification path local. It requires no remote notification secret and must not be combined with the Convex/VAPID, Telegram, or webhook delivery paths.
- Restrict outbound traffic where practical; Web Push and configured webhooks make server-side network requests.
- Back up the complete local `.data` directory together. An encrypted vault without its matching key is not recoverable.

## If a secret may be compromised

Stop the affected deployment or remove its network access first. Preserve logs and an offline copy of the encrypted vault for investigation, but do not publish them.

Then rotate the affected session/password, database, scheduler, notification, and provider credentials. Revoke and reconnect provider accounts whose tokens might have been disclosed. Vault encryption and Convex access-secret rotation require a deliberate migration; do not delete an old decryption source until the existing vault has been read and verified with the replacement configuration.
