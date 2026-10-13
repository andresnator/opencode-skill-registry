# Contributing

Use Node.js `24.20.0` and pnpm `12.11.2`, with development SDK/CLI packages pinned to OpenCode `2.0.28`.

## Quick path

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

CI also verifies a first packed npm installation with an empty cache on OpenCode `2.0.28` and the latest `2.x` release. The fixture uses a password-protected foreground server, checks first-prompt native metadata parity with an uncached npm contributor, and isolates HOME, configuration, cache, data, state, and temporary files. Test prompts use `resume: false` to avoid inference.

Keep one behavior per change. Update its tests and public documentation before opening a pull request. Do not rewrite `pnpm-lock.yaml` with npm, Yarn, or another pnpm version.

## Test local source

Build the checkout with `pnpm run build`, then add its absolute directory to `plugins` in an isolated project configuration:

```jsonc
{
  "plugins": ["/absolute/path/to/opencode-skill-registry"]
}
```

Keep the checkout at that path, reload or restart OpenCode, send the first prompt, and verify generated files under `.ai/atl/`. For an installed CLI instead of the development binary, run:

```bash
OPENCODE_BIN="$(command -v opencode)" pnpm run test:install
```

Do not modify real user configuration for automated tests. Follow the [official V1 plugin migration guide](https://opencode.ai/build/plugins/migrate-v1).

## Preserve contracts

- Keep discovery provider- and harness-independent.
- Preserve exact parity with OpenCode's native `ctx.skill.list()` metadata; do not add a parallel filesystem resolver or precedence rules.
- Preserve distinct IDs with equal display names and never include skill bodies.
- Use the typed V2 `id`/`setup` lifecycle; keep SDK imports type-only to preserve zero runtime dependencies.
- Generate once in the public `ctx.session.hook("prompt")`, after OpenCode awaits full activation including pending package installs; do not use partial plugin inventory as a readiness barrier.
- Make concurrent prompts await the same fixed snapshot; do not refresh it or reset the retry budget on later prompts.
- Cancel pending generation on cleanup; remove the hook and await any publication already started.
- Keep generated state project-local and hash-gated.
- Keep runtime npm dependencies at zero.
- Add observable behavior contracts to `tests/contracts.ts`.
- Keep public documentation in English.

Keep the global 24-hour dependency maturity gate, trust policy, build allowlist, audit, and signature verification active. The nineteen exact `@opencode/<package>@2.0.28` maturity exceptions are explicitly approved for this migration; do not widen them.

Name non-trivial tests `should...When...` and use visible Given, When, and Then sections.

## Open the pull request

Use `type(scope)!: description`. Describe user impact and list automated and manual evidence.

Release Please creates stable GitHub releases. `.github/workflows/publish.yml` publishes them to npm through Trusted Publishing. Never add an npm token to the repository.
