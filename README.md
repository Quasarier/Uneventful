# CampusPulse

CampusPulse is a pnpm monorepo with a Next.js web app and a NestJS API.

## Requirements

- Node.js 22.13 or newer
- Corepack-enabled pnpm 10.7.1 or newer
- Docker Compose

## Local setup

1. Copy `.env.example` to `.env`, then replace its sample values. The OAuth values must come from a Google OAuth client configured for your local callback URL.
2. Install dependencies:

   ```powershell
   corepack pnpm install
   ```

3. Start PostgreSQL, Redis, the API, and web app together with one command:

   ```powershell
   corepack pnpm dev
   ```

   The API validates its required environment variables before it starts. It listens on port `3001` by default; the web app listens on port `3000`. Docker Compose services can also be started separately with `corepack pnpm dev:services`; use `corepack pnpm dev:apps` to run only the API and web app.

4. Install Gitleaks locally so the Husky pre-commit hook can scan staged changes. Go is not required. Choose either option:

   - **Binary (recommended):** Download the Windows AMD64 or ARM64 archive for [Gitleaks v8.30.1](https://github.com/gitleaks/gitleaks/releases/tag/v8.30.1), extract `gitleaks.exe` into a directory on your `PATH`, then open a new terminal and verify it with `gitleaks version`.
   - **Docker fallback:** Install and start Docker Desktop, and ensure the `docker` command is available. If the Gitleaks binary is not installed, the pre-commit hook runs the pinned `zricethezav/gitleaks:v8.30.1` image and mounts the repository read-only. Docker downloads the image on its first use.

   The hook fails with an installation message if neither Gitleaks nor Docker is available. CI installs the same pinned Gitleaks version automatically.

## Verification

```powershell
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Docker Compose reads the root `.env` file automatically. Database and Redis credentials have no Compose defaults; startup fails if the required variables are absent.
