// src/server.ts
import crypto from "node:crypto";
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
var FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
var FORMAT_VERSION = "3";
var SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry";
function scalar(frontmatter, key) {
  const lines = frontmatter.split(/\r?\n/);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const direct = line.match(new RegExp(`^\\s*${key}:\\s*(.*)$`));
    if (!direct) continue;
    const value = direct[1].trim();
    if (value === ">" || value === "|" || value === ">-" || value === "|-") {
      const block = [];
      for (let next = index + 1; next < lines.length; next++) {
        if (!/^\s+/.test(lines[next])) break;
        block.push(lines[next].trim());
      }
      return block.join(" ").trim();
    }
    return value.replace(/^["']|["']$/g, "").trim();
  }
  return "";
}
function triggerFrom(description) {
  const match = description.match(/Trigger:\s*([^.\n]+)/i);
  const trigger = (match?.[1] ?? description).replace(/\s+/g, " ").trim();
  if (trigger.length <= 120) return trigger;
  return `${trigger.slice(0, 119)}\u2026`;
}
function tableCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
async function directoryExists(dir) {
  try {
    return (await fs.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
async function parseSkill(file, project) {
  const stat = await fs.stat(file);
  const text = await fs.readFile(file, "utf8");
  const frontmatter = text.match(FRONTMATTER_RE)?.[1] ?? "";
  const name = scalar(frontmatter, "name") || path.basename(path.dirname(file));
  if (name === "skill-registry") return void 0;
  return {
    name,
    version: scalar(frontmatter, "version") || "0.0.0",
    status: scalar(frontmatter, "status") || "",
    description: scalar(frontmatter, "description"),
    path: file,
    mtimeMs: stat.mtimeMs,
    project
  };
}
var SKIPPED_DIRS = /* @__PURE__ */ new Set(["node_modules", ".git", ".venv", "dist", "build", "target"]);
async function listSkillFiles(dir, seenDirs = /* @__PURE__ */ new Set()) {
  const out = [];
  async function walk(current, depth = 0) {
    let realCurrent;
    try {
      realCurrent = await fs.realpath(current);
    } catch {
      return;
    }
    if (seenDirs.has(realCurrent)) return;
    seenDirs.add(realCurrent);
    let entries;
    try {
      entries = await fs.readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (depth > 0 && SKIPPED_DIRS.has(entry.name)) continue;
      const full = path.join(current, entry.name);
      let entryStat;
      try {
        entryStat = await fs.stat(full);
      } catch {
        continue;
      }
      if (entryStat.isDirectory()) await walk(full, depth + 1);
      else if (entryStat.isFile() && entry.name === "SKILL.md") out.push(full);
    }
  }
  await walk(dir);
  return [...new Set(out)];
}
async function discoverSkills(worktree) {
  const home = os.homedir();
  const roots = [
    { dir: path.join(worktree, ".opencode/skills"), project: true },
    { dir: path.join(worktree, ".agents/skills"), project: true },
    { dir: path.join(worktree, "skills"), project: true },
    { dir: path.join(home, ".config/opencode/skills"), project: false }
  ];
  const seenDirs = /* @__PURE__ */ new Set();
  const byName = /* @__PURE__ */ new Map();
  for (const root of roots) {
    for (const file of await listSkillFiles(root.dir, seenDirs)) {
      const skill = await parseSkill(file, root.project);
      if (!skill) continue;
      const existing = byName.get(skill.name);
      if (!existing || skill.project && !existing.project) byName.set(skill.name, skill);
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}
async function collectConventions(worktree) {
  const seenInodes = /* @__PURE__ */ new Set();
  const conventionFiles = ["AGENTS.md", "agents.md", "CLAUDE.md", ".cursorrules", "GEMINI.md", "copilot-instructions.md"].map((file) => path.join(worktree, file)).filter((file) => {
    const inode = inodeKeySync(file);
    if (!inode || seenInodes.has(inode)) return false;
    seenInodes.add(inode);
    return true;
  });
  const rows = [];
  const seen = /* @__PURE__ */ new Set();
  const hashParts = [];
  async function addHash(file) {
    try {
      const text = await fs.readFile(file, "utf8");
      const digest = crypto.createHash("sha256").update(text).digest("hex");
      hashParts.push(`${file}@${digest}`);
      return text;
    } catch {
      return "";
    }
  }
  for (const file of conventionFiles) {
    rows.push(`| ${tableCell(path.basename(file))} | ${tableCell(file)} | Project convention file |`);
    seen.add(file);
    const text = await addHash(file);
    if (!text) continue;
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1];
      if (!candidate || candidate.includes("*") || candidate.includes("{")) continue;
      const resolved = path.resolve(worktree, candidate);
      const relative = path.relative(worktree, resolved);
      if (relative === ".atl" || relative.startsWith(`.atl${path.sep}`) || relative === ".ai" || relative.startsWith(`.ai${path.sep}`)) {
        continue;
      }
      if (!resolved.startsWith(worktree + path.sep) || seen.has(resolved) || !regularFileSync(resolved)) continue;
      seen.add(resolved);
      await addHash(resolved);
      rows.push(`| ${tableCell(path.basename(resolved))} | ${tableCell(resolved)} | Referenced by ${tableCell(path.basename(file))} |`);
    }
  }
  return { rows: rows.join("\n"), hashInput: hashParts.sort().join("\n") };
}
async function renderRegistry(skills, conventions) {
  const userRows = skills.map((skill) => `| ${tableCell(triggerFrom(skill.description) || "-")} | ${tableCell(skill.name)} | ${tableCell(skill.path)} |`).join("\n");
  return `# Skill Registry

Auto-generated \u2014 do not edit. Discovery index only: match a trigger, then read the skill's SKILL.md at the listed path for its full contract.

## Skills

| Trigger | Skill | Path |
|---|---|---|
${userRows || "| - | - | - |"}

## Project Conventions

| File | Path | Notes |
|---|---|---|
${conventions.rows || "| - | - | - |"}
`;
}
function regularFileSync(file) {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}
function inodeKeySync(file) {
  try {
    const stat = statSync(file);
    return stat.isFile() ? `${stat.dev}:${stat.ino}` : "";
  } catch {
    return "";
  }
}
async function ensureInfoExclude(worktree) {
  const exclude = path.join(worktree, ".git/info/exclude");
  try {
    const text = await fs.readFile(exclude, "utf8");
    if (/(^|\n)\.ai\/?(\n|$)/.test(text)) return;
    await fs.appendFile(exclude, text.endsWith("\n") ? ".ai/\n" : "\n.ai/\n");
  } catch {
  }
}
async function migrateLegacyAtl(worktree) {
  const legacyDir = path.join(worktree, ".atl");
  const aiDir = path.join(worktree, ".ai");
  const atlDir = path.join(aiDir, "atl");
  if (!await directoryExists(legacyDir) || await directoryExists(atlDir)) return;
  try {
    await fs.mkdir(aiDir, { recursive: true });
    await fs.rename(legacyDir, atlDir);
  } catch (error) {
    console.error(`[skill-registry] legacy .atl migration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function generateRegistry(worktree) {
  await migrateLegacyAtl(worktree);
  const skills = await discoverSkills(worktree);
  const conventions = await collectConventions(worktree);
  const orderedHashInput = skills.map((skill) => `${skill.name}@${skill.version}@${skill.mtimeMs}`).sort().join("\n");
  const hash = crypto.createHash("sha256").update(`${FORMAT_VERSION}
${orderedHashInput}
${conventions.hashInput}`).digest("hex");
  const atlDir = path.join(worktree, ".ai", "atl");
  const hashFile = path.join(atlDir, "skill-registry.hash");
  const registryFile = path.join(atlDir, "skill-registry.md");
  await fs.mkdir(atlDir, { recursive: true });
  try {
    if ((await fs.readFile(hashFile, "utf8")).trim() === hash) return;
  } catch {
  }
  await fs.writeFile(registryFile, await renderRegistry(skills, conventions), "utf8");
  await fs.writeFile(hashFile, `${hash}
`, "utf8");
  await ensureInfoExclude(worktree);
}
function projectRoot(input) {
  const reportedWorktree = input.worktree ?? "";
  if (!reportedWorktree || reportedWorktree === path.parse(reportedWorktree).root) return input.directory;
  return reportedWorktree;
}
var skillRegistryContracts = {
  scalar,
  triggerFrom,
  listSkillFiles,
  discoverSkills,
  collectConventions,
  renderRegistry,
  ensureInfoExclude,
  migrateLegacyAtl,
  generateRegistry,
  projectRoot
};
var MAX_RETRIES = 3;
var RETRY_COOLDOWN_MS = 1e3;
var SkillRegistryPlugin = async (input) => {
  const root = projectRoot(input);
  let failed = false;
  let running = false;
  let retries = 0;
  let nextRetryAt = 0;
  const run = async () => {
    running = true;
    try {
      await generateRegistry(root);
      retries = 0;
    } catch (error) {
      failed = true;
      nextRetryAt = Date.now() + RETRY_COOLDOWN_MS;
      const detail = error instanceof Error ? error.message : String(error);
      if (retries >= MAX_RETRIES) {
        console.error(`[skill-registry] ${detail} \u2014 retry budget spent, giving up until the next session`);
      } else {
        console.error(`[skill-registry] ${detail}`);
      }
    } finally {
      running = false;
    }
  };
  void run();
  return {
    "event": async () => {
      if (!failed || running) return;
      if (retries >= MAX_RETRIES) return;
      if (retries > 0 && Date.now() < nextRetryAt) return;
      retries += 1;
      failed = false;
      void run();
    }
  };
};
var server_default = {
  id: SKILL_REGISTRY_PLUGIN_ID,
  server: SkillRegistryPlugin
};
export {
  SKILL_REGISTRY_PLUGIN_ID,
  SkillRegistryPlugin,
  server_default as default,
  skillRegistryContracts
};
