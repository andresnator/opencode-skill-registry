import path from "node:path"
import type { Plugin, PluginInput } from "@opencode-ai/plugin"
import { renderRegistry } from "./registry.js"
import { collectConventionEntries, loadOpenCodeSkills } from "./source.js"
import { publishRegistry } from "./store.js"

export const SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry"

const MAX_RETRIES = 3
const RETRY_COOLDOWN_MS = 1_000

function projectRoot(input: { worktree?: string; directory: string }) {
  const reportedWorktree = input.worktree ?? ""
  // Non-git projects report the filesystem root as worktree; fall back to the session directory.
  if (!reportedWorktree || reportedWorktree === path.parse(reportedWorktree).root) return input.directory
  return reportedWorktree
}

async function generateRegistry(input: PluginInput, worktree: string) {
  const [skills, conventions] = await Promise.all([
    loadOpenCodeSkills(input.client, input.directory),
    collectConventionEntries(worktree),
  ])
  await publishRegistry(worktree, renderRegistry(skills, conventions))
}

export const SkillRegistryPlugin: Plugin = async (input) => {
  const root = projectRoot(input)
  let started = false
  let failed = false
  let running = false
  let retries = 0
  let nextRetryAt = 0

  const run = async () => {
    running = true
    try {
      await generateRegistry(input, root)
      failed = false
      retries = 0
    } catch (error) {
      failed = true
      nextRetryAt = Date.now() + RETRY_COOLDOWN_MS
      const detail = error instanceof Error ? error.message : String(error)
      if (retries >= MAX_RETRIES) {
        console.error(`[skill-registry] ${detail} — retry budget spent, giving up until the next session`)
      } else {
        console.error(`[skill-registry] ${detail}`)
      }
    } finally {
      running = false
    }
  }

  return {
    config: async () => {
      if (started) return
      started = true
      void run()
    },
    event: async () => {
      if (!failed || running) return
      if (retries >= MAX_RETRIES) return
      if (retries > 0 && Date.now() < nextRetryAt) return
      retries += 1
      failed = false
      void run()
    },
  }
}

export default {
  id: SKILL_REGISTRY_PLUGIN_ID,
  server: SkillRegistryPlugin,
}
