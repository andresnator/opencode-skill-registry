import crypto from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"

export type RegistryFiles = {
  registryFile: string
  hashFile: string
}

type RenameFile = (oldPath: string, newPath: string) => Promise<void>

async function readText(file: string) {
  try {
    return await fs.readFile(file, "utf8")
  } catch {
    return undefined
  }
}

export function registryHash(markdown: string) {
  return crypto.createHash("sha256").update(markdown, "utf8").digest("hex")
}

export function registryFiles(worktree: string): RegistryFiles {
  const atlDir = path.join(worktree, ".ai", "atl")
  return {
    registryFile: path.join(atlDir, "skill-registry.md"),
    hashFile: path.join(atlDir, "skill-registry.hash"),
  }
}

export async function ensureInfoExclude(worktree: string) {
  const exclude = path.join(worktree, ".git/info/exclude")
  try {
    const text = await fs.readFile(exclude, "utf8")
    if (/(^|\n)\.ai\/?(\n|$)/.test(text)) return
    await fs.appendFile(exclude, text.endsWith("\n") ? ".ai/\n" : "\n.ai/\n")
  } catch {
    // Non-git worktrees are valid OpenCode projects; skip local exclude updates.
  }
}

export async function publishRegistry(
  worktree: string,
  markdown: string,
  renameFile: RenameFile = fs.rename,
): Promise<boolean> {
  const files = registryFiles(worktree)
  const atlDir = path.dirname(files.registryFile)
  const expectedHash = registryHash(markdown)

  await fs.mkdir(atlDir, { recursive: true })
  const [storedHash, currentRegistry] = await Promise.all([readText(files.hashFile), readText(files.registryFile)])
  if (storedHash?.trim() === expectedHash && currentRegistry !== undefined && registryHash(currentRegistry) === expectedHash) {
    await ensureInfoExclude(worktree)
    return false
  }

  const suffix = `${process.pid}-${crypto.randomUUID()}.tmp`
  const registryTemp = `${files.registryFile}.${suffix}`
  const hashTemp = `${files.hashFile}.${suffix}`
  try {
    await fs.writeFile(registryTemp, markdown, "utf8")
    await fs.writeFile(hashTemp, `${expectedHash}\n`, "utf8")
    await renameFile(registryTemp, files.registryFile)
    await renameFile(hashTemp, files.hashFile)
  } finally {
    await Promise.allSettled([fs.rm(registryTemp, { force: true }), fs.rm(hashTemp, { force: true })])
  }

  await ensureInfoExclude(worktree)
  return true
}
