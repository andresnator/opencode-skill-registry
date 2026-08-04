#!/usr/bin/env bash
# Deterministic contracts for the skill-registry plugin. Runs entirely inside
# a throwaway HOME/worktree and never reads or writes real user state.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/skill-registry-test.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$TMP/home"
HOME="$TMP/home" SKILL_REGISTRY_TEST_ROOT="$TMP" "$ROOT/node_modules/.bin/tsx" "$ROOT/tests/contracts.ts"
