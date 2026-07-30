# Task 7 report: secure Windows local operating guide

Documented the exact Windows strict-local operating boundary and linked it from
the project README.

## Changes

- Added `docs/WINDOWS_SECURE_LOCAL.md` with the complete threat model, pinned
  source rule, versioned runtime, exact four-origin application Fetch policy,
  minimal child environments, DPAPI/vault layout, runtime plaintext limits,
  ACL boundary, limited scheduled tasks, one-use browser bootstrap, temporary
  OAuth handoff, persistent Edge profile handling, installation, verification,
  recovery, reviewed updates, removal, and natural-logon-test limitation.
- Used the final Task 6 names `install-secure-local.ps1`,
  `start-secure-local.ps1`, `open-secure-local.ps1`,
  `Assert-HmaStartupIntegrity`, `HowMuchAI-Service`, and
  `HowMuchAI-Window`.
- Used the final Task 8 names `connect-claude-secure.ps1`,
  `oauth-handoff-extension`, `oauth-temp`, and the one-use attempt routes and
  lifetimes.
- Added a concise README link that distinguishes strict-local Windows
  operation from general self-hosting.
- Ignored local audit, secure-local test, and supply-chain risk evidence
  directories. Existing local evidence remains retained and is not added to
  the final source tree.

## Security boundary

The guide makes no absolute security claim. It explicitly excludes same-user
malware, administrator/debugger/EDR inspection, raw-socket bypass by a
malicious dependency, pagefile/hibernation/crash-dump copies, and provider-side
state. It identifies the current strict application Fetch guard as exactly
four HTTPS origins while stating that all paths and methods on those origins
are permitted and that the guard is not an OS firewall or process sandbox.

## Verification

- Task 7 documentation-name search: the current strict-local environment names,
  exact host, and port were found in `lib/strict-local-mode.ts` and the guide.
- Deferred source-name portion: the Task 6 script and task-name comparison
  cannot pass in this isolated branch because the branch is based exactly on
  `38c9f74a1f6dd7e6b7bfd9865e19e4f9e7f83fab`; re-run the full planned search
  after Task 6 is merged.
- Deferred runtime execution: Task 9 audit launchers, Task 10 installer, and
  Task 12 final-state verifier are documented by their plan-defined names but
  are not present at this base commit.
- The deferred-marker search over `docs/WINDOWS_SECURE_LOCAL.md` produced no
  matches.
- README target and all three requested ignore entries were checked directly.
- `git diff --check` passed.

## Scope

Only `docs/WINDOWS_SECURE_LOCAL.md`, `README.md`, `.gitignore`, and this report
are changed. No environment file, vault content, DPAPI payload, provider
credential, developer authentication store, external service, or local
supply-chain evidence report was read, changed, or removed.
