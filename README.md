# OpenCode Skill Registry

Generate a lightweight discovery index of the skills and convention files available to an OpenCode project. The plugin runs in the background, writes only when its content hash changes, and does not depend on a specific agent harness.

## Quick path

The repository is directly installable from a pinned GitHub release:

```bash
git clone --branch v0.1.0 --depth 1 https://github.com/andresnator/opencode-skill-registry.git
cd opencode-skill-registry
opencode plugin "$PWD" --global
```

Keep the cloned directory because OpenCode records its absolute path. No `npm install` or build step is required; releases include the verified self-contained bundle.

Restart OpenCode and open a project. The plugin generates:

```text
<project>/.ai/atl/skill-registry.md
<project>/.ai/atl/skill-registry.hash
```

> The npm manifest is ready for `opencode-skill-registry@<version>`, but availability is not claimed until an npm release is published.

## Discovery contract

The defaults follow common OpenCode and Agent Skills layouts:

| Scope | Locations |
|---|---|
| Project | `.opencode/skills`, `.agents/skills`, `skills` |
| User | `~/.config/opencode/skills` |
| Conventions | `AGENTS.md`, `agents.md`, `CLAUDE.md`, `.cursorrules`, `GEMINI.md`, `copilot-instructions.md` |

Each discovered skill is represented by name, trigger text, and its full `SKILL.md` path. When the same name exists in project and user scope, the project copy wins. Symlinked trees are traversed safely and deduplicated by real path.

The registry is a discovery index, not a copy of skill bodies. Consumers match a trigger, then read the referenced `SKILL.md` for the complete contract.

## Persistence and safety

- The generated files live under project-local `.ai/atl/`.
- Legacy `.atl/` is moved to `.ai/atl/` only when the new destination does not exist.
- The hash includes skill version/mtime data and the content of convention files, so unchanged projects are not rewritten.
- Generated `.ai/` state is added to `.git/info/exclude` when the project is a Git worktree; tracked `.gitignore` files are never edited.
- A failed startup generation is retried at most three times, with cooldown, so a persistent filesystem error cannot turn every OpenCode event into a recursive scan.
- The plugin reads skill metadata and convention paths. It does not read credentials or send project data over the network.

## Compatibility and package shape

| Concern | Contract |
|---|---|
| OpenCode | `>=1.17.15 <2`; validated with the 1.18.x plugin API |
| Agent harness | None |
| Runtime npm dependencies | None |
| Package entry | `exports["./server"]` → `dist/server.js` |

The default export is `{ id, server }`, and the runtime bundle imports only Node builtins.

## Development

```bash
npm ci
npm run check
```

The nine deterministic contract groups run inside a throwaway HOME and worktree. They cover project precedence, symlink cycles, hash no-op behavior, legacy migration, bounded retry, duplicated roots, skipped build directories, and exact Git exclusion ownership.

## Repository map

| Path | Purpose |
|---|---|
| `src/server.ts` | Plugin implementation and deterministic test seams |
| `tests/contracts.ts` | Isolated behavioral contracts |
| `scripts/build.mjs` | Self-contained ESM bundle |
| `scripts/verify-package.mjs` | Entry, dependency, bundle, and package-content checks |

See [NOTICE.md](NOTICE.md) for extraction provenance. The project is licensed under the [MIT License](LICENSE).
