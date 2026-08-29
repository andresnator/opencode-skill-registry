// src/server.ts
import path3 from "node:path";

// src/registry.ts
var SOURCE_SECTIONS = [
  { source: "opencode", heading: "OpenCode Skills" },
  { source: "agents", heading: "Agent Skills" },
  { source: "claude", heading: "Claude Skills" }
];
var AGENTS_SKILL_PATH = /(?:^|\/)\.agents\/skills(?:\/|$)/;
var CLAUDE_SKILL_PATH = /(?:^|\/)\.claude\/skills(?:\/|$)/;
function classifySkillSource(location) {
  const normalized = location.replaceAll("\\", "/");
  if (AGENTS_SKILL_PATH.test(normalized)) return "agents";
  if (CLAUDE_SKILL_PATH.test(normalized)) return "claude";
  return "opencode";
}
function tableCell(value) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim();
}
function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}
function renderSkillSection(heading, skills) {
  const rows = skills.sort(compareNames).map((skill) => `| ${tableCell(skill.description ?? "-")} | ${tableCell(skill.name)} | ${tableCell(skill.location)} |`).join("\n");
  return `## ${heading}

| Description | Skill | Location |
|---|---|---|
${rows || "| - | - | - |"}`;
}
function renderRegistry(skills, conventions) {
  const skillSections = SOURCE_SECTIONS.map(
    ({ source, heading }) => renderSkillSection(heading, skills.filter((skill) => classifySkillSource(skill.location) === source))
  ).join("\n\n");
  const conventionRows = conventions.map((entry) => `| ${tableCell(entry.file)} | ${tableCell(entry.path)} | ${tableCell(entry.notes)} |`).join("\n");
  return `# Skill Registry

Auto-generated \u2014 do not edit. Discovery index of the skills active in this OpenCode session. Match a description, then load the skill with OpenCode's \`skill\` tool; filesystem locations can also be read directly.

${skillSections}

## Detected Convention Files

Compatibility inventory only. These files are not presented as the active instruction set resolved by OpenCode.

| File | Path | Notes |
|---|---|---|
${conventionRows || "| - | - | - |"}
`;
}

// src/source.ts
import { statSync } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
var CONVENTION_FILE_NAMES = [
  "AGENTS.md",
  "agents.md",
  "CLAUDE.md",
  ".cursorrules",
  "GEMINI.md",
  "copilot-instructions.md"
];
function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function resultData(result) {
  if (!isRecord(result)) return result;
  if ("error" in result && result.error !== void 0 && result.error !== null) {
    const detail = result.error instanceof Error ? result.error.message : String(result.error);
    throw new Error(`OpenCode /skill request failed: ${detail}`);
  }
  return "data" in result ? result.data : result;
}
function normalizeSkills(value) {
  if (!Array.isArray(value)) throw new TypeError("OpenCode /skill returned a non-array response");
  const seenNames = /* @__PURE__ */ new Set();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`OpenCode /skill returned an invalid entry at index ${index}`);
    if (typeof item.name !== "string") throw new TypeError(`OpenCode /skill entry ${index} has no string name`);
    if (typeof item.location !== "string") throw new TypeError(`OpenCode /skill entry ${index} has no string location`);
    if (item.description !== void 0 && typeof item.description !== "string") {
      throw new TypeError(`OpenCode /skill entry ${index} has an invalid description`);
    }
    if (seenNames.has(item.name)) throw new TypeError(`OpenCode /skill returned duplicate name: ${item.name}`);
    seenNames.add(item.name);
    return {
      name: item.name,
      description: item.description,
      location: item.location
    };
  });
}
async function loadOpenCodeSkills(client, directory) {
  const app = client.app;
  let result;
  if (typeof app?.skills === "function") {
    result = await app.skills.call(app, { directory });
  } else {
    const legacy = client._client;
    if (typeof legacy?.get !== "function") {
      throw new Error("OpenCode client does not expose the /skill transport");
    }
    result = await legacy.get.call(legacy, { url: "/skill" });
  }
  return normalizeSkills(resultData(result));
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
function isGeneratedPath(worktree, resolved) {
  const relative = path.relative(worktree, resolved);
  return relative === ".atl" || relative.startsWith(`.atl${path.sep}`) || relative === ".ai" || relative.startsWith(`.ai${path.sep}`);
}
async function collectConventionEntries(worktree) {
  const seenInodes = /* @__PURE__ */ new Set();
  const conventionFiles = CONVENTION_FILE_NAMES.map((file) => path.join(worktree, file)).filter((file) => {
    const inode = inodeKeySync(file);
    if (!inode || seenInodes.has(inode)) return false;
    seenInodes.add(inode);
    return true;
  });
  const entries = [];
  const seenPaths = /* @__PURE__ */ new Set();
  for (const file of conventionFiles) {
    entries.push({ file: path.basename(file), path: file, notes: "Detected compatibility convention" });
    seenPaths.add(file);
    let text;
    try {
      text = await fs.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const match of text.matchAll(/`([^`]+)`/g)) {
      const candidate = match[1];
      if (!candidate || candidate.includes("*") || candidate.includes("{")) continue;
      const resolved = path.resolve(worktree, candidate);
      const relative = path.relative(worktree, resolved);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      if (isGeneratedPath(worktree, resolved) || seenPaths.has(resolved) || !regularFileSync(resolved)) continue;
      seenPaths.add(resolved);
      entries.push({
        file: path.basename(resolved),
        path: resolved,
        notes: `Referenced by ${path.basename(file)}`
      });
    }
  }
  return entries;
}

// src/store.ts
import crypto from "node:crypto";
import fs2 from "node:fs/promises";
import path2 from "node:path";
async function directoryExists(dir) {
  try {
    return (await fs2.stat(dir)).isDirectory();
  } catch {
    return false;
  }
}
async function readText(file) {
  try {
    return await fs2.readFile(file, "utf8");
  } catch {
    return void 0;
  }
}
function registryHash(markdown) {
  return crypto.createHash("sha256").update(markdown, "utf8").digest("hex");
}
function registryFiles(worktree) {
  const atlDir = path2.join(worktree, ".ai", "atl");
  return {
    registryFile: path2.join(atlDir, "skill-registry.md"),
    hashFile: path2.join(atlDir, "skill-registry.hash")
  };
}
async function ensureInfoExclude(worktree) {
  const exclude = path2.join(worktree, ".git/info/exclude");
  try {
    const text = await fs2.readFile(exclude, "utf8");
    if (/(^|\n)\.ai\/?(\n|$)/.test(text)) return;
    await fs2.appendFile(exclude, text.endsWith("\n") ? ".ai/\n" : "\n.ai/\n");
  } catch {
  }
}
async function migrateLegacyAtl(worktree) {
  const legacyDir = path2.join(worktree, ".atl");
  const aiDir = path2.join(worktree, ".ai");
  const atlDir = path2.join(aiDir, "atl");
  if (!await directoryExists(legacyDir) || await directoryExists(atlDir)) return;
  try {
    await fs2.mkdir(aiDir, { recursive: true });
    await fs2.rename(legacyDir, atlDir);
  } catch (error) {
    console.error(`[skill-registry] legacy .atl migration failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
async function publishRegistry(worktree, markdown, renameFile = fs2.rename) {
  const files = registryFiles(worktree);
  const atlDir = path2.dirname(files.registryFile);
  const expectedHash = registryHash(markdown);
  await fs2.mkdir(atlDir, { recursive: true });
  const [storedHash, currentRegistry] = await Promise.all([readText(files.hashFile), readText(files.registryFile)]);
  if (storedHash?.trim() === expectedHash && currentRegistry !== void 0 && registryHash(currentRegistry) === expectedHash) {
    await ensureInfoExclude(worktree);
    return false;
  }
  const suffix = `${process.pid}-${crypto.randomUUID()}.tmp`;
  const registryTemp = `${files.registryFile}.${suffix}`;
  const hashTemp = `${files.hashFile}.${suffix}`;
  try {
    await fs2.writeFile(registryTemp, markdown, "utf8");
    await fs2.writeFile(hashTemp, `${expectedHash}
`, "utf8");
    await renameFile(registryTemp, files.registryFile);
    await renameFile(hashTemp, files.hashFile);
  } finally {
    await Promise.allSettled([fs2.rm(registryTemp, { force: true }), fs2.rm(hashTemp, { force: true })]);
  }
  await ensureInfoExclude(worktree);
  return true;
}

// src/server.ts
var SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry";
var MAX_RETRIES = 3;
var RETRY_COOLDOWN_MS = 1e3;
function projectRoot(input) {
  const reportedWorktree = input.worktree ?? "";
  if (!reportedWorktree || reportedWorktree === path3.parse(reportedWorktree).root) return input.directory;
  return reportedWorktree;
}
async function generateRegistry(input, worktree) {
  await migrateLegacyAtl(worktree);
  const [skills, conventions] = await Promise.all([
    loadOpenCodeSkills(input.client, input.directory),
    collectConventionEntries(worktree)
  ]);
  await publishRegistry(worktree, renderRegistry(skills, conventions));
}
var SkillRegistryPlugin = async (input) => {
  const root = projectRoot(input);
  let started = false;
  let failed = false;
  let running = false;
  let retries = 0;
  let nextRetryAt = 0;
  const run = async () => {
    running = true;
    try {
      await generateRegistry(input, root);
      failed = false;
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
  return {
    config: async () => {
      if (started) return;
      started = true;
      void run();
    },
    event: async () => {
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
  server_default as default
};
