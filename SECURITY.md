# Security Policy

## Reporting a vulnerability

Do not report suspected vulnerabilities in public issues, discussions, or pull requests. Use GitHub's **Security → Advisories → Report a vulnerability** private reporting flow for this repository. If private reporting is unavailable, contact the project maintainers through the private security contact channel configured by the repository owner.

Include the affected component and version, impact, and a concise way to verify the issue. Do not include real credentials, student records, or other personal data. We aim to acknowledge reports within three business days and provide an initial triage within seven calendar days. Please allow time for a coordinated fix before public disclosure.

## Secret handling and rotation

- Production secrets must be stored in the deployment platform's secret manager (for example, AWS Secrets Manager, Azure Key Vault, Google Secret Manager, or HashiCorp Vault), encrypted at rest and delivered to workloads through short-lived workload identity where supported.
- GitHub Actions secrets are for CI/deployment credentials only. Grant workflows the minimum required permissions; never expose production runtime secrets to pull-request jobs, forks, build logs, or artifacts.
- Keep local credentials in ignored `.env` files. `.env.example` contains placeholders only. Never commit credentials or paste them into issues or logs.
- Rotate secrets on a defined schedule and immediately after suspected exposure or personnel/access changes. Generate a replacement, place it in the secret manager, deploy/reload consumers, verify health, then revoke the old value. Use overlapping credentials only where the provider supports safe overlap.
- Rotate Google OAuth client secrets, database and Redis credentials, and signing/session secrets independently. Rotating a session-signing secret invalidates existing sessions; notify users and require reauthentication. Revoke OAuth grants or sessions if compromise is suspected.
- Record rotation metadata and completion in the approved audit system, but never record secret values. Limit secret-manager access using least-privilege roles and review access regularly.

## Branch protection recommendations

Apply a ruleset to the default branch and release branches:

- Require pull requests and at least one approval from someone other than the author; require two approvals for changes to authentication, authorization, secrets, or deployment workflows.
- Dismiss stale approvals after new commits, require conversation resolution, and require branches to be up to date before merging.
- Require the successful `Lint, type-check, test, and build`, `gitleaks`, `dependency-audit`, and `semgrep` checks, plus the OSV-Scanner check shown in the pull request's Checks tab.
- Require signed commits, restrict force pushes and branch deletion, and do not allow bypass for administrators except a documented break-glass process.
- Review CODEOWNERS and repository access periodically. Protect the default branch from direct pushes.

## Automated security checks

Pull requests run Gitleaks, npm and pnpm audits, OSV-Scanner, and Semgrep with the OWASP Top 10 and TypeScript rule sets. The pnpm audit fails on high or critical findings; OSV results are uploaded for review, including lower-severity advisories.
