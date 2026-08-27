# Changelog

## [0.1.3](https://github.com/andresnator/opencode-skill-registry/compare/v0.1.2...v0.1.3) (2026-08-27)


### Bug Fixes

* **install:** support first clean-cache installation ([#9](https://github.com/andresnator/opencode-skill-registry/issues/9)) ([c75c5c2](https://github.com/andresnator/opencode-skill-registry/commit/c75c5c2182a6d008b12be796f0bdff3052d2aec2))

## [0.1.2](https://github.com/andresnator/opencode-skill-registry/compare/v0.1.1...v0.1.2) (2026-08-27)


### Features

* add npm version badge ([#5](https://github.com/andresnator/opencode-skill-registry/issues/5)) ([79fac40](https://github.com/andresnator/opencode-skill-registry/commit/79fac40b2aa486ba5b8e8cf4c02d4070933ff89a))

## [0.1.1](https://github.com/andresnator/opencode-skill-registry/compare/v0.1.0...v0.1.1) (2026-08-27)


### Features

* publish Skill Registry through npm ([436a0b0](https://github.com/andresnator/opencode-skill-registry/commit/436a0b0c97639da96a3a9b199bbdc1d027043a2d))

## 0.1.0 - 2026-08-04

- Extract the skill registry from `agents-orchestrator` into a standalone OpenCode plugin.
- Preserve project-over-user precedence, symlink-cycle protection, hash-gated writes, legacy state migration, bounded retries, and local Git exclusion.
- Ship a self-contained server bundle with no runtime npm dependencies.
