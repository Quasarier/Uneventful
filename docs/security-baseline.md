# Dependency Security Baseline

Reviewed: 2026-11-21

`pnpm audit` and OSV Scanner report no known vulnerabilities in the current
lockfile. The glob and minimatch advisories were removed from the baseline
after these exact pnpm overrides moved the locked transitive tooling
dependencies to patched releases:

| Dependency path              |  Requested version |           Override | Reason                                   |
| ---------------------------- | -----------------: | -----------------: | ---------------------------------------- |
| `apps__api>@nestjs/cli>glob` |      `glob@13.0.6` |      `glob@14.0.2` | Patched release for GHSA-3g3m-2fjr-6pw4. |
| `.>eslint>minimatch`         | `minimatch@10.2.6` | `minimatch@11.0.1` | Patched release for GHSA-g3hv-75wg-m249. |

Keep the overrides until the parent dependency ranges resolve to patched
versions without them. Re-run both `pnpm audit` and OSV Scanner after lockfile
changes and before releases.

## Frontend transport policy

The web middleware emits `Strict-Transport-Security: max-age=31536000` only
when `NODE_ENV=production`. It intentionally omits both `includeSubDomains`
and `preload`.

## OWASP ZAP baseline exceptions

The local ZAP baseline scan reports three Low `Cross-Origin-Opener-Policy
Header Missing or Invalid` alerts (rule 90004) for `/`, `/events`, and `/login`.
The app uses `same-origin-allow-popups` so the Google sign-in popup can retain
its opener and report completion through the origin- and source-checked
`postMessage` flow. Replacing it with `same-origin` caused the trusted popup
sign-in E2E test to fail. The OAuth result page is scoped to
`Cross-Origin-Opener-Policy: unsafe-none` for the same compatibility reason.

Review by **2026-12-21**. Remove this exception only after replacing the popup
completion channel with an opener-independent design and verifying the full
OAuth E2E journey. The ZAP CI job remains non-blocking until this baseline
exception is resolved or explicitly accepted.
