# Dependency Security Baseline

Reviewed: 2026-11-20

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
