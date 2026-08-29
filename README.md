# OpenCode Skill Registry

[![npm version](https://img.shields.io/npm/v/opencode-skill-registry?logo=npm&label=npm)](https://www.npmjs.com/package/opencode-skill-registry)

Generate a lightweight index of the skills resolved for an OpenCode project. The plugin creates one background snapshot per OpenCode session and writes only when the rendered index changes.

## Install

Requires OpenCode `>=1.17.15 <2`.

```bash
opencode plugin opencode-skill-registry --global
```

Restart OpenCode and open a project. The plugin creates:

```text
<project>/.ai/atl/skill-registry.md
<project>/.ai/atl/skill-registry.hash
```

## Use

Consumers match a description in `skill-registry.md`, then load that skill through OpenCode's native `skill` tool. Filesystem entries can also be read at their listed location. The registry is an index, not a copy of skill bodies.

## Discovery

The registry reads OpenCode's resolved `/skill` list instead of maintaining a second discovery implementation. It groups the active entries in this display order:

| Order | Source | Examples |
| ---: | --- | --- |
| 1 | OpenCode | Built-in skills, `.opencode/{skill,skills}`, global config, `skills.paths`, and `skills.urls` |
| 2 | Agents compatibility | Project and global `.agents/skills` |
| 3 | Claude compatibility | Project and global `.claude/skills` |

OpenCode resolves duplicate names before the plugin sees them, so the registry records the same active winner instead of imposing a separate precedence. Each entry includes the `name`, `description`, and `location` returned by `/skill`. Files such as `AGENTS.md`, `CLAUDE.md`, `.cursorrules`, and `GEMINI.md` remain in a separate compatibility inventory; that section is not presented as OpenCode's active instruction set.

The plugin does not enable sources or inspect a Claude executable. OpenCode's `OPENCODE_DISABLE_CLAUDE_CODE_SKILLS` and `OPENCODE_DISABLE_EXTERNAL_SKILLS` flags are reflected unchanged. A project-level `skills/` directory appears only when OpenCode resolves it, for example through `skills.paths`.

## Behavior

- Store generated state under project-local `.ai/atl/`.
- Migrate legacy `.atl/` only when the new destination is absent.
- Hash the exact rendered Markdown and repair a missing or corrupted registry.
- Publish the registry and hash through same-directory temporary files.
- Add `.ai/` to Git's local info exclude without editing tracked `.gitignore`.
- Retry failed startup generation at most three times per session.
- Keep a stable startup snapshot; restart OpenCode to include skills added during a session.
- Query only the local OpenCode client; do not fetch configured skill URLs independently.

The package has no runtime npm dependencies. Its root and `./server` entrypoints load the same server plugin.

## Update or remove

A bare `opencode-skill-registry` entry follows npm `latest`. To pin a release:

```bash
opencode plugin opencode-skill-registry@<version> --global --force
```

To remove the plugin, delete only its matching string or tuple from the global `opencode.jsonc` or `opencode.json`, preserve every other entry, and restart OpenCode. There is no global npm installation to uninstall. Generated `.ai/atl/` files remain until removed separately.

## Develop

```bash
pnpm install --frozen-lockfile
pnpm run check
pnpm run security:check
```

See [Contributing](CONTRIBUTING.md) for local loading and review rules.

## Help

- [Report a problem](https://github.com/andresnator/opencode-skill-registry/issues)
- [Changelog](CHANGELOG.md)
- [MIT License](LICENSE)
