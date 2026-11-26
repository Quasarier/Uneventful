# Agent Rules

These rules apply to coding agents and automation working in this repository.
Treat them as requirements, not suggestions.

## Stack

- pnpm monorepo; packages use the `@uneventful/*` namespace.
- `apps/web`: strict TypeScript, Next.js App Router, Tailwind CSS, and PWA.
- `apps/api`: strict TypeScript and NestJS.
- PostgreSQL 17 with Prisma 7.10.1; Redis with BullMQ and Socket.IO.
- Docker and GitHub Actions for local services and CI.
- Socket.IO provides the authenticated real-time event dashboard.
- Authentication uses Google OAuth/OIDC, restricted to the university email
  domain. Roles are `STUDENT`, `ORGANIZER`, and `ADMIN`.

## Security rules

- Deny by default. Validate input server-side and enforce authorization on
  every endpoint.
- Return explicit, allowlisted response DTOs. Never spread or serialize
  database records directly into API responses.
- Hidden, forbidden, and unknown resources must return identical masked 404s:
  the same status, body shape, and headers.
- Use parameterized queries only.
- Never put secrets or personal data in logs. Never hardcode secrets; validate
  required configuration at startup.
- Follow the OWASP API Security Top 10 and OWASP ASVS Level 2.

## Git and Windows rules

- Never run `git add .`, `git add -A`, `git commit -a`, `git clean`,
  `git reset --hard`, or commands with `--no-verify` or `--force`.
- Stage only specific paths, then inspect `git diff --staged --stat` before
  committing. Do not commit unless asked.
- Never push to `main`. Use small Conventional Commit messages when a commit is
  requested.
- Before pushing, run:

  ```text
  gitleaks detect --source . --log-opts="--all" --redact
  ```

- On Windows, use PowerShell-safe commands and Windows path separators in
  commands. Write files as UTF-8; do not rely on shell-specific heredocs or
  Unix-only syntax in PowerShell.

## Testing rules

- Run database and Redis integration tests with
  `bash scripts/test-integration-local.sh` from Git Bash on Windows.
- CI enforces minimums of 106 API integration tests and 34 Playwright tests.
  Raise the corresponding minimum whenever tests are added.
- Never weaken or delete assertions, skip tests, or lower a minimum to make a
  check pass. Change an expectation only when the requirement changes, and
  explain why.
- Report a test as passing only if it was run in the current task. Distinguish
  local results from CI results.

## Required task report

After each task, report:

1. Files created or changed.
2. Tests added, mapped to the relevant OWASP API Security Top 10 risks.
3. A table with each requirement, its test name, test file, and actual result.
4. A **Not verified** list for checks or assumptions that were not validated.

Do not imply unrun tests, scans, or deployment behavior were verified.
