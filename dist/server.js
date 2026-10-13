// src/server.ts
import path3 from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// src/constants.ts
var MAX_RETRIES = 3;
var RETRY_COOLDOWN_MS = 1e3;
var STARTUP_TIMEOUT_MS = 5e3;

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
  return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
}
function renderSkillSection(heading, skills) {
  const rows = skills.sort(compareNames).map((skill) => `| ${tableCell(skill.description ?? "-")} | ${tableCell(skill.id)} | ${tableCell(skill.name)} | ${tableCell(skill.location)} |`).join("\n");
  return `## ${heading}

| Description | Skill ID | Name | Location |
|---|---|---|---|
${rows || "| - | - | - | - |"}`;
}
function renderRegistry(skills, conventions) {
  const skillSections = SOURCE_SECTIONS.map(
    ({ source, heading }) => renderSkillSection(heading, skills.filter((skill) => classifySkillSource(skill.location) === source))
  ).join("\n\n");
  const conventionRows = conventions.map((entry) => `| ${tableCell(entry.file)} | ${tableCell(entry.path)} | ${tableCell(entry.notes)} |`).join("\n");
  return `# Skill Registry

Auto-generated \u2014 do not edit. Discovery index of the skills active in this OpenCode session. Match a description, then load the Skill ID with OpenCode's native skill loader; filesystem locations can also be read directly.

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
function normalizeSkills(value) {
  if (!Array.isArray(value)) throw new TypeError("OpenCode skill.list returned a non-array response");
  const seenIDs = /* @__PURE__ */ new Set();
  return value.map((item, index) => {
    if (!isRecord(item)) throw new TypeError(`OpenCode skill.list returned an invalid entry at index ${index}`);
    if (typeof item.id !== "string") throw new TypeError(`OpenCode skill.list entry ${index} has no string id`);
    if (typeof item.name !== "string") throw new TypeError(`OpenCode skill.list entry ${index} has no string name`);
    if (typeof item.path !== "string") throw new TypeError(`OpenCode skill.list entry ${index} has no string path`);
    if (item.description !== void 0 && typeof item.description !== "string") {
      throw new TypeError(`OpenCode skill.list entry ${index} has an invalid description`);
    }
    if (seenIDs.has(item.id)) throw new TypeError(`OpenCode skill.list returned duplicate id: ${item.id}`);
    seenIDs.add(item.id);
    return {
      id: item.id,
      name: item.name,
      description: item.description,
      location: item.path
    };
  });
}
async function loadOpenCodeSkills(context, signal) {
  const result = await context.skill.list(void 0, { signal });
  return normalizeSkills(result.data);
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
  const generatedDirectory = path.join(".ai", "atl");
  return relative === generatedDirectory || relative.startsWith(`${generatedDirectory}${path.sep}`);
}
async function collectConventionEntries(worktree, signal) {
  signal?.throwIfAborted();
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
    signal?.throwIfAborted();
    entries.push({ file: path.basename(file), path: file, notes: "Detected compatibility convention" });
    seenPaths.add(file);
    let text;
    try {
      text = await fs.readFile(file, { encoding: "utf8", signal });
    } catch {
      signal?.throwIfAborted();
      continue;
    }
    signal?.throwIfAborted();
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
async function publishRegistry(worktree, markdown, renameFile = fs2.rename) {
  const files = registryFiles(worktree);
  const atlDir = path2.dirname(files.registryFile);
  const expectedHash = registryHash(markdown);
  await fs2.mkdir(atlDir, { recursive: true });
  const [storedHash, currentRegistry] = await Promise.all([readText(files.hashFile), readText(files.registryFile)]);
  if (storedHash?.trim() === expectedHash && currentRegistry !== void 0 && registryHash(currentRegistry) === expectedHash) {
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
  return true;
}

// src/server.ts
var SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry";
function projectRoot(location) {
  const reportedWorktree = location.project.directory;
  if (!reportedWorktree || reportedWorktree === path3.parse(reportedWorktree).root) return location.directory;
  return reportedWorktree;
}
var SkillRegistryPlugin = async (context) => {
  const root = projectRoot(context.location);
  const lifetime = new AbortController();
  let task;
  const registration = await context.session.hook("prompt", async () => {
    if (lifetime.signal.aborted) return;
    task ??= generateSnapshot(context, root, lifetime.signal);
    await task;
  });
  return async () => {
    lifetime.abort();
    try {
      await registration.dispose();
    } finally {
      await task;
    }
  };
};
async function generateSnapshot(context, root, lifetime) {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (lifetime.aborted) return;
    try {
      const markdown = await prepareSnapshot(context, root, lifetime);
      lifetime.throwIfAborted();
      await publishRegistry(root, markdown);
      return;
    } catch (error) {
      if (lifetime.aborted) return;
      const detail = error instanceof Error ? error.message : String(error);
      const exhausted = attempt === MAX_RETRIES;
      console.error(`[skill-registry] ${detail}${exhausted ? " \u2014 retry budget spent, giving up until reload or restart" : ""}`);
      if (exhausted) return;
      try {
        await delay(RETRY_COOLDOWN_MS, void 0, { signal: lifetime });
      } catch {
        return;
      }
    }
  }
}
async function prepareSnapshot(context, root, lifetime) {
  const timeout = new AbortController();
  const signal = AbortSignal.any([lifetime, timeout.signal]);
  const timer = setTimeout(() => timeout.abort(new Error("OpenCode skill snapshot timed out")), STARTUP_TIMEOUT_MS);
  try {
    return await abortable(renderSnapshot(context, root, signal), signal);
  } finally {
    clearTimeout(timer);
  }
}
function abortable(work, signal) {
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
  });
}
async function renderSnapshot(context, root, signal) {
  signal.throwIfAborted();
  const [skills, conventions] = await Promise.all([
    loadOpenCodeSkills(context, signal),
    collectConventionEntries(root, signal)
  ]);
  signal.throwIfAborted();
  return renderRegistry(skills, conventions);
}
var server_default = {
  id: SKILL_REGISTRY_PLUGIN_ID,
  setup: SkillRegistryPlugin
};
export {
  SKILL_REGISTRY_PLUGIN_ID,
  SkillRegistryPlugin,
  server_default as default
};
