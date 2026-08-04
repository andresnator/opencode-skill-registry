import crypto from "node:crypto"
import { statSync } from "node:fs"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode-ai/plugin"

type SkillEntry = {
  name: string
  version: string
  status: string
  description: string
  path: string
  mtimeMs: number
  project: boolean
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/
const FORMAT_VERSION = "3"
export const SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry"

function scalar(frontmatter: string, key: string) {
  const lines = frontmatter.split(/\r?\n/)
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]
    const direct = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`))
    if (!direct) continue

    const value = direct[1].trim()
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block: string[] = []
      for (let next = index + 1; next < lines.length; next++) {
        if (!/^\s+/.test(lines[next])) break
        block.push(lines[next].trim())
      }
      return block.join(" ").trim()
    }
    return value.replace(/^["']|["']$/g, "").trim()
  }
  return ""
}

function triggerFrom(description: string) {
  const match = description.match(/Trigger:\s*([^.\n]+)/i)
  const trigger = (match?.[1] ?? description).replace(/\s+/g, " ").trim()
  if (trigger.length <= 120) return trigger
  return `${trigger.slice(0, 119)}…`
}

function tableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

async function directoryExists(dir: string) {
  try {
    return (await fs.stat(dir)).isDirectory()
  } catch {
    return false
  }
}

async function parseSkill(file: string, project: boolean): Promise<SkillEntry | undefined> {
  const stat = await fs.stat(file)
  const text = await fs.readFile(file, "utf8")
  const frontmatter = text.match(FRONTMATTER_RE)?.[1] ?? ""
  const name = scalar(frontmatter, "name") || path.basename(path.dirname(file))
  if (name === "skill-registry") return undefined

  return {
    name,
    version: scalar(frontmatter, "version") || "0.0.0",
    status: scalar(frontmatter, "status") || "",
    description: scalar(frontmatter, "description"),
    path: file,
    mtimeMs: stat.mtimeMs,
    project,
  }
}

// Directories that never hold skills but can hold thousands of files. Walking them is the
// difference between a few hundred syscalls and tens of thousands. Skipped only below the
// root's own children: a root's immediate entries ARE the skill directories, and a skill may
// legitimately be named `dist` or `build`.
const SKIPPED_DIRS = new Set(["node_modules", ".git", ".venv", "dist", "build", "target"])

// `seenDirs` is caller-suppliable so a multi-root scan can share it: the installer symlinks
// ~/.config/opencode/skills at the worktree's own skills/ directory, so without a shared set
// the same tree is walked once per root.
async function listSkillFiles(dir: string, seenDirs = new Set<string>()) {
  const out: string[] = []

  // Report paths as discovered under the scanned root (e.g. ~/.config/opencode/skills/...),
  // not their symlink targets; realpath is used only for cycle detection.
  async function walk(current: string, depth = 0) {
    let realCurrent: string
    try {
      realCurrent = await fs.realpath(current)
    } catch {
      return
    }
    if (seenDirs.has(realCurrent)) return
    seenDirs.add(realCurrent)

    let entries
    try {
      entries = await fs.readdir(current, { withFileTypes: true })
    } catch {
      return
    }

    for (const entry of entries) {
      if (depth > 0 && SKIPPED_DIRS.has(entry.name)) continue
      const full = path.join(current, entry.name)
      let entryStat
      try {
        entryStat = await fs.stat(full)
      } catch {
        continue
      }

      if (entryStat.isDirectory()) await walk(full, depth + 1)
      else if (entryStat.isFile() && entry.name === "SKILL.md") out.push(full)
    }
  }

  await walk(dir)
  return [...new Set(out)]
}

async function discoverSkills(worktree: string) {
  const home = os.homedir()
  // Project roots first, then the user root. The order matters now that the roots share one
  // `seenDirs`: when the user root is a symlink at a project root's tree, whichever root is
  // walked first is the one that reports the path — and a project path is the correct answer,
  // the same precedence the byName merge below enforces for genuinely separate trees.
  const roots = [
    { dir: path.join(worktree, ".opencode/skills"), project: true },
    { dir: path.join(worktree, ".agents/skills"), project: true },
    { dir: path.join(worktree, "skills"), project: true },
    { dir: path.join(home, ".config/opencode/skills"), project: false },
  ]

  const seenDirs = new Set<string>()
  const byName = new Map<string, SkillEntry>()
  for (const root of roots) {
    for (const file of await listSkillFiles(root.dir, seenDirs)) {
      const skill = await parseSkill(file, root.project)
      if (!skill) continue
      const existing = byName.get(skill.name)
      if (!existing || (skill.project && !existing.project)) byName.set(skill.name, skill)
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name))
}

type ConventionData = {
  rows: string
  hashInput: string
}

async function collectConventions(worktree: string): Promise<ConventionData> {
  // Case-insensitive filesystems and symlinked convention files resolve several
  // candidates to the same on-disk file; dedupe by inode, keeping the first.
  const seenInodes = new Set<string>()
  const conventionFiles = ["AGENTS.md", "agents.md", "CLAUDE.md", ".cursorrules", "GEMINI.md", "copilot-instructions.md"]
    .map((file) => path.join(worktree, file))
    .filter((file) => {
      const inode = inodeKeySync(file)
      if (!inode || seenInodes.has(inode)) return false
      seenInodes.add(inode)
      return true
    })

  const rows: string[] = []
  const seen = new Set<string>()
  const hashParts: string[] = []

  async function addHash(file: string) {
    try {
      const text = await fs.readFile(file, "utf8")
      const digest = crypto.createHash("sha256").update(text).digest("hex")
      hashParts.push(`${file}@${digest}`)
      return text
    } catch {
      return ""
    }
  }

  for (const file of conventionFiles) {
    rows.push(`| ${tableCell(path.basename(file))} | ${tableCell(file)} | Project convention file |`)
    seen.add(file)

    const text = await addHash(file)
    if (!text) continue

    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1]
      if (!candidate || candidate.includes("*") || candidate.includes("{")) continue
      const resolved = path.resolve(worktree, candidate)
      const relative = path.relative(worktree, resolved)
      if (
        relative === ".atl" ||
        relative.startsWith(`.atl${path.sep}`) ||
        relative === ".ai" ||
        relative.startsWith(`.ai${path.sep}`)
      ) {
        continue
      }
      if (!resolved.startsWith(worktree + path.sep) || seen.has(resolved) || !regularFileSync(resolved)) continue
      seen.add(resolved)
      await addHash(resolved)
      rows.push(`| ${tableCell(path.basename(resolved))} | ${tableCell(resolved)} | Referenced by ${tableCell(path.basename(file))} |`)
    }
  }
  return { rows: rows.join("\n"), hashInput: hashParts.sort().join("\n") }
}

async function renderRegistry(skills: SkillEntry[], conventions: ConventionData) {
  const userRows = skills
    .map((skill) => `| ${tableCell(triggerFrom(skill.description) || "-")} | ${tableCell(skill.name)} | ${tableCell(skill.path)} |`)
    .join("\n")

  return `# Skill Registry

Auto-generated — do not edit. Discovery index only: match a trigger, then read the skill's SKILL.md at the listed path for its full contract.

## Skills

| Trigger | Skill | Path |
|---|---|---|
${userRows || "| - | - | - |"}

## Project Conventions

| File | Path | Notes |
|---|---|---|
${conventions.rows || "| - | - | - |"}
`
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

async function ensureInfoExclude(worktree: string) {
  const exclude = path.join(worktree, ".git/info/exclude")
  try {
    const text = await fs.readFile(exclude, "utf8")
    if (/(^|\n)\.ai\/?(\n|$)/.test(text)) return
    await fs.appendFile(exclude, text.endsWith("\n") ? ".ai/\n" : "\n.ai/\n")
  } catch {
    // Non-git worktrees are valid OpenCode projects; skip local exclude updates.
  }
}

async function migrateLegacyAtl(worktree: string) {
  const legacyDir = path.join(worktree, ".atl")
  const aiDir = path.join(worktree, ".ai")
  const atlDir = path.join(aiDir, "atl")

  if (!(await directoryExists(legacyDir)) || (await directoryExists(atlDir))) return

  try {
    await fs.mkdir(aiDir, { recursive: true })
    await fs.rename(legacyDir, atlDir)
  } catch (error) {
    console.error(`[skill-registry] legacy .atl migration failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function generateRegistry(worktree: string) {
  await migrateLegacyAtl(worktree)
  const skills = await discoverSkills(worktree)
  const conventions = await collectConventions(worktree)
  const orderedHashInput = skills
    .map((skill) => `${skill.name}@${skill.version}@${skill.mtimeMs}`)
    .sort()
    .join("\n")
  const hash = crypto.createHash("sha256").update(`${FORMAT_VERSION}\n${orderedHashInput}\n${conventions.hashInput}`).digest("hex")
  const atlDir = path.join(worktree, ".ai", "atl")
  const hashFile = path.join(atlDir, "skill-registry.hash")
  const registryFile = path.join(atlDir, "skill-registry.md")

  await fs.mkdir(atlDir, { recursive: true })
  try {
    if ((await fs.readFile(hashFile, "utf8")).trim() === hash) return
  } catch {
    // Missing hash means the registry should be written.
  }

  await fs.writeFile(registryFile, await renderRegistry(skills, conventions), "utf8")
  await fs.writeFile(hashFile, `${hash}\n`, "utf8")
  await ensureInfoExclude(worktree)
}

function projectRoot(input: { worktree?: string; directory: string }) {
  const worktree = input.worktree ?? ""
  // Non-git projects report the filesystem root as worktree; fall back to the session directory.
  if (!worktree || worktree === path.parse(worktree).root) return input.directory
  return worktree
}

// Deterministic test seam consumed by scripts/skill-registry-contracts.ts; not part of the runtime contract.
export const skillRegistryContracts = {
  scalar,
  triggerFrom,
  listSkillFiles,
  discoverSkills,
  collectConventions,
  renderRegistry,
  ensureInfoExclude,
  migrateLegacyAtl,
  generateRegistry,
  projectRoot,
}

// Retry budget for a failed generation. The bus fires events continuously — dozens per
// second while a response streams — and each generation is a full recursive scan of every
// skill root. Without a bound, one persistent failure (an unwritable `.ai/`, a permission
// error) turns every event into that scan for the rest of the session. The first retry is
// immediate so a transient failure recovers at once; the rest are rate-limited and capped.
const MAX_RETRIES = 3
const RETRY_COOLDOWN_MS = 1_000

export const SkillRegistryPlugin: Plugin = async (input) => {
  const root = projectRoot(input)
  let failed = false
  let running = false
  let retries = 0
  let nextRetryAt = 0

  const run = async () => {
    running = true
    try {
      await generateRegistry(root)
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

  void run()

  return {
    "event": async () => {
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
