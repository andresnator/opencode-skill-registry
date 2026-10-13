import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import type { Plugin } from "@opencode/plugin"
import { MAX_RETRIES, RETRY_COOLDOWN_MS, STARTUP_TIMEOUT_MS } from "./constants.js"
import { renderRegistry } from "./registry.js"
import { collectConventionEntries, loadOpenCodeSkills } from "./source.js"
import { publishRegistry } from "./store.js"

export const SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry"

function projectRoot(location: Plugin.Context["location"]) {
  const reportedWorktree = location.project.directory
  // Non-git projects report the filesystem root; never write generated state there.
  if (!reportedWorktree || reportedWorktree === path.parse(reportedWorktree).root) return location.directory
  return reportedWorktree
}

export const SkillRegistryPlugin: Plugin.Plugin["setup"] = async (context) => {
  const root = projectRoot(context.location)
  const lifetime = new AbortController()
  let task: Promise<void> | undefined
  // OpenCode awaits full activation, including pending package installs, before this hook.
  // Share one awaited snapshot across concurrent prompts and keep it fixed until unload.
  const registration = await context.session.hook("prompt", async () => {
    if (lifetime.signal.aborted) return
    task ??= generateSnapshot(context, root, lifetime.signal)
    await task
  })

  return async () => {
    lifetime.abort()
    try {
      await registration.dispose()
    } finally {
      // Publication is not cancellable; cleanup waits for any write already started.
      await task
    }
  }
}

async function generateSnapshot(context: Plugin.Context, root: string, lifetime: AbortSignal) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (lifetime.aborted) return
    try {
      const markdown = await prepareSnapshot(context, root, lifetime)
      lifetime.throwIfAborted()
      // Publication is not cancellable; cleanup waits for any write already started.
      await publishRegistry(root, markdown)
      return
    } catch (error) {
      if (lifetime.aborted) return
      const detail = error instanceof Error ? error.message : String(error)
      const exhausted = attempt === MAX_RETRIES
      console.error(`[skill-registry] ${detail}${exhausted ? " — retry budget spent, giving up until reload or restart" : ""}`)
      if (exhausted) return
      try {
        await delay(RETRY_COOLDOWN_MS, undefined, { signal: lifetime })
      } catch {
        return
      }
    }
  }
}

async function prepareSnapshot(context: Plugin.Context, root: string, lifetime: AbortSignal) {
  const timeout = new AbortController()
  const signal = AbortSignal.any([lifetime, timeout.signal])
  const timer = setTimeout(() => timeout.abort(new Error("OpenCode skill snapshot timed out")), STARTUP_TIMEOUT_MS)
  try {
    return await abortable(renderSnapshot(context, root, signal), signal)
  } finally {
    clearTimeout(timer)
  }
}

function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    signal.addEventListener("abort", abort, { once: true })
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
    if (signal.aborted) abort()
  })
}

async function renderSnapshot(context: Plugin.Context, root: string, signal: AbortSignal) {
  signal.throwIfAborted()
  const [skills, conventions] = await Promise.all([
    loadOpenCodeSkills(context, signal),
    collectConventionEntries(root, signal),
  ])
  signal.throwIfAborted()
  return renderRegistry(skills, conventions)
}

export default {
  id: SKILL_REGISTRY_PLUGIN_ID,
  setup: SkillRegistryPlugin,
} satisfies Plugin.Plugin
