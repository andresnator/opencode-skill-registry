import { statSync } from "node:fs"
import fs from "node:fs/promises"
import path from "node:path"
import type { PluginInput } from "@opencode-ai/plugin"

export type OpenCodeSkill = {
  name: string
  description?: string
  location: string
}

export type ConventionEntry = {
  file: string
  path: string
  notes: string
}

export const CONVENTION_FILE_NAMES = [
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
  "copilot-instructions.md",
] as const

type UnknownRecord = Record<string, unknown>
type SkillRequest = (parameters?: { directory?: string }) => Promise<unknown>
type LegacyGet = (options: { url: string }) => Promise<unknown>

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function resultData(result: unknown) {
  if (!isRecord(result)) return result
  if ("error" in result && result.error !== undefined && result.error !== null) {
    const detail = result.error instanceof Error ? result.error.message : String(result.error)
    throw new Error(`OpenCode /skill request failed: ${detail}`)
  }
  return "data" in result ? result.data : result
}

function normalizeSkills(value: unknown): OpenCodeSkill[] {
  if (!Array.isArray(value)) throw new TypeError("OpenCode /skill returned a non-array response")

  const seenNames = new Set<string>()
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`OpenCode /skill returned an invalid entry at index ${index}`)
    if (typeof item.name !== "string") throw new TypeError(`OpenCode /skill entry ${index} has no string name`)
    if (typeof item.location !== "string") throw new TypeError(`OpenCode /skill entry ${index} has no string location`)
    if (item.description !== undefined && typeof item.description !== "string") {
      throw new TypeError(`OpenCode /skill entry ${index} has an invalid description`)
    }
    if (seenNames.has(item.name)) throw new TypeError(`OpenCode /skill returned duplicate name: ${item.name}`)
    seenNames.add(item.name)

    return {
      name: item.name,
      description: item.description,
      location: item.location,
    }
  })
}

export async function loadOpenCodeSkills(client: PluginInput["client"], directory: string): Promise<OpenCodeSkill[]> {
  const app = (client as unknown as { app?: { skills?: SkillRequest } }).app
  let result: unknown

  if (typeof app?.skills === "function") {
    result = await app.skills.call(app, { directory })
  } else {
    const legacy = (client as unknown as { _client?: { get?: LegacyGet } })._client
    if (typeof legacy?.get !== "function") {
      throw new Error("OpenCode client does not expose the /skill transport")
    }
    result = await legacy.get.call(legacy, { url: "/skill" })
  }

  return normalizeSkills(resultData(result))
}

function regularFileSync(file: string) {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function inodeKeySync(file: string) {
  try {
    const stat = statSync(file)
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : ""
  } catch {
    return ""
  }
}

function isGeneratedPath(worktree: string, resolved: string) {
  const relative = path.relative(worktree, resolved)
  const generatedDirectory = path.join(".ai", "atl")
  return relative === generatedDirectory || relative.startsWith(`${generatedDirectory}${path.sep}`)
}

export async function collectConventionEntries(worktree: string): Promise<ConventionEntry[]> {
  const seenInodes = new Set<string>()
  const conventionFiles = CONVENTION_FILE_NAMES.map((file) => path.join(worktree, file)).filter((file) => {
    const inode = inodeKeySync(file)
    if (!inode || seenInodes.has(inode)) return false
    seenInodes.add(inode)
    return true
  })

  const entries: ConventionEntry[] = []
  const seenPaths = new Set<string>()

  for (const file of conventionFiles) {
    entries.push({ file: path.basename(file), path: file, notes: "Detected compatibility convention" })
    seenPaths.add(file)

    let text: string
    try {
      text = await fs.readFile(file, "utf8")
    } catch {
      continue
    }

    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1]
      if (!candidate || candidate.includes("*") || candidate.includes("{")) continue
      const resolved = path.resolve(worktree, candidate)
      const relative = path.relative(worktree, resolved)
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue
      if (isGeneratedPath(worktree, resolved) || seenPaths.has(resolved) || !regularFileSync(resolved)) continue
      seenPaths.add(resolved)
      entries.push({
        file: path.basename(resolved),
        path: resolved,
        notes: `Referenced by ${path.basename(file)}`,
      })
    }
  }

  return entries
}
