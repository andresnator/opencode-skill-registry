# Contributing

Use Node.js `22.23.2` and pnpm `10.34.5`.

## Quick path

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

Keep one behavior per change. Update its tests and public documentation before opening a pull request. Do not rewrite `pnpm-lock.yaml` with npm, Yarn, or another pnpm version.

## Test local source

Use isolated OpenCode configuration when possible. Register the checkout under test with:

```bash
opencode plugin "$PWD" --global --force
```

Keep the checkout at that path, restart OpenCode, and verify generated files under `.ai/atl/`.

## Preserve contracts

- Keep discovery provider- and harness-independent.
- Preserve project-over-user precedence and symlink safety.
- Keep generated state project-local and hash-gated.
- Keep runtime npm dependencies at zero.
- Add observable behavior contracts to `tests/contracts.ts`.
- Keep public documentation in English.

Name non-trivial tests `should...When...` and use visible Given, When, and Then sections.

## Open the pull request

Use `type(scope)!: description`. Describe user impact and list automated and manual evidence.

Release Please creates stable GitHub releases. `.github/workflows/publish.yml` publishes them to npm through Trusted Publishing. Never add an npm token to the repository.
