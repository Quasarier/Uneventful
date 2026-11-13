# Accepted Development-Tooling Advisory Baseline

Reviewed: 2026-11-14

This baseline records the three low/moderate advisories currently reported by
`pnpm audit`. They are accepted temporarily because the affected packages are
reachable only through development/build tools, not the production dependency
sets declared by `apps/api` and `apps/web`. The deployed application does not
execute these packages on request paths, and no attacker-controlled application
input reaches the affected APIs in the current codebase.

This is a scoped assessment, not a claim that the vulnerable versions are
universally safe. A malicious change or compromised build environment could
still influence developer/CI tooling. Keep CI dependency scanning enabled, do
not expose production secrets to pull-request builds, and reassess on lockfile
changes or before the next release. Remove each item once a compatible patched
dependency is available and verified.

| Advisory                                                                                  | Locked package and version | Dependency path                                                  | Scope and reason it is not exploitable in the deployed service                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------- | -------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4), CVE-2026-93753  | `deepmerge@4.3.1`          | `apps__api>@nestjs/cli>fork-ts-checker-webpack-plugin>deepmerge` | Present under the API's `@nestjs/cli` development dependency and used during build/tooling, not included in the API's runtime dependency declarations. The vulnerable merge operation is not called with request-controlled objects by the deployed service. |
| [GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4), CVE-2026-118773 | `glob@13.0.6`              | `apps__api>@nestjs/cli>glob`                                     | Present under the API's Nest CLI development dependency. The application does not expose a user-controlled glob operation or rely on abort signals as a filesystem traversal limit at runtime; the affected walker is a build/tooling dependency.            |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), CVE-2026-118764 | `minimatch@10.2.6`         | `.>eslint>minimatch`                                             | Present under root ESLint development tooling, not the API or web runtime dependencies. The vulnerable pattern preprocessing is not used to process attacker-supplied patterns by the deployed service.                                                      |

## Review conditions

- Re-run `pnpm audit` and inspect the dependency paths before changing this baseline.
- If an affected package enters a production dependency graph or its vulnerable
  API becomes reachable from untrusted input, this acceptance is invalid; upgrade
  or mitigate before deployment.
- Re-review by 2026-12-14, or sooner if upstream publishes a compatible fix.
