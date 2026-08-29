import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { createServer as createPortServer } from "node:net"
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { fileURLToPath } from "node:url"

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const PACKAGE_NAME = "opencode-skill-registry"
const INSTALL_TIMEOUT_MS = 60_000
const RUNTIME_TIMEOUT_MS = 30_000
const REQUEST_TIMEOUT_MS = 2_000
const DEFAULT_OPENCODE_BIN = fileURLToPath(new URL("../node_modules/.bin/opencode", import.meta.url))
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const packageSpec = `${PACKAGE_NAME}@${packageJson.version}`
const NATIVE_SKILL_NAMES = [
  "project-native-singular",
  "ancestor-native-plural",
  "global-native-singular",
  "global-native-plural",
  "configured-path",
]
const AGENT_SKILL_NAMES = ["project-agent", "ancestor-agent", "global-agent"]
const CLAUDE_SKILL_NAMES = ["project-claude", "ancestor-claude", "global-claude"]
const DUPLICATE_SKILL_NAME = "duplicate-source"
const PRIVATE_SKILL_NAME = "private-worktree-skill"

async function shouldInstallOnFirstAttemptWhenCacheIsEmpty() {
  // Given
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), "skill-registry-install-"))
  const packageDirectory = path.join(temporaryRoot, "package")
  const repositoryDirectory = path.join(temporaryRoot, "repository")
  const sessionDirectory = path.join(repositoryDirectory, "workspace/nested")
  const homeDirectory = path.join(temporaryRoot, "home")
  const configHome = path.join(temporaryRoot, "config")
  const dataHome = path.join(temporaryRoot, "data")
  const cacheHome = path.join(temporaryRoot, "cache")
  const npmCache = path.join(temporaryRoot, "npm-cache")
  const requests = []
  await Promise.all([
    mkdir(packageDirectory, { recursive: true }),
    mkdir(sessionDirectory, { recursive: true }),
    mkdir(homeDirectory, { recursive: true }),
    mkdir(configHome, { recursive: true }),
    mkdir(dataHome, { recursive: true }),
    mkdir(cacheHome, { recursive: true }),
    mkdir(npmCache, { recursive: true }),
  ])
  initializeGitRepository(repositoryDirectory)
  await writeSkillFixtures({ configHome, homeDirectory, repositoryDirectory, sessionDirectory })

  let registry
  try {
    const tarball = await packPackage(packageDirectory)
    registry = await startRegistry(tarball, requests)
    const isolatedEnvironment = {
      ...process.env,
      CI: "true",
      HOME: homeDirectory,
      NO_COLOR: "1",
      NPM_CONFIG_AUDIT: "false",
      NPM_CONFIG_CACHE: npmCache,
      NPM_CONFIG_REGISTRY: registry.url,
      npm_config_audit: "false",
      npm_config_cache: npmCache,
      npm_config_registry: registry.url,
      XDG_CACHE_HOME: cacheHome,
      XDG_CONFIG_HOME: configHome,
      XDG_DATA_HOME: dataHome,
    }
    delete isolatedEnvironment.OPENCODE_CONFIG
    delete isolatedEnvironment.OPENCODE_CONFIG_CONTENT

    // When
    const opencodeBin = process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN
    const result = await runProcess(opencodeBin, [
      "plugin", packageSpec, "--global", "--pure", "--print-logs", "--log-level", "DEBUG",
    ], isolatedEnvironment)

    // Then
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    assert.equal(result.timedOut, false, `OpenCode installation timed out:\n${output}`)
    assert.equal(result.code, 0, `first OpenCode installation failed:\n${output}\nregistry requests: ${requests.join(", ")}`)
    assert.match(output, /Detected server target/)
    assert.ok(requests.includes(`GET /${PACKAGE_NAME}`), "OpenCode did not request the package metadata")
    assert.ok(
      requests.includes(`GET /${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`),
      `OpenCode did not download the packed artifact: ${requests.join(", ")}`,
    )

    const configFile = path.join(configHome, "opencode", "opencode.jsonc")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    assert.deepEqual(config.plugin, [packageSpec])

    const version = await runProcess(opencodeBin, ["--version"], isolatedEnvironment)
    assert.equal(version.code, 0, version.stderr)
    await shouldMatchResolvedOpenCodeSkillsAcrossFlags(
      opencodeBin,
      isolatedEnvironment,
      repositoryDirectory,
      sessionDirectory,
    )
    process.stdout.write(`PASS: clean-cache install and resolved-skill startup succeed on OpenCode ${version.stdout.trim()}.\n`)
  } finally {
    await registry?.close()
    await rm(temporaryRoot, { recursive: true, force: true })
  }
}

async function writeSkillFixtures({ configHome, homeDirectory, repositoryDirectory, sessionDirectory }) {
  const ancestorDirectory = path.dirname(sessionDirectory)

  await Promise.all([
    writeSkill(
      path.join(sessionDirectory, ".opencode/skill/project-native-singular"),
      "project-native-singular",
      "Project OpenCode singular description.",
    ),
    writeSkill(
      path.join(ancestorDirectory, ".opencode/skills/ancestor-native-plural"),
      "ancestor-native-plural",
      "Ancestor OpenCode plural description.",
    ),
    writeSkill(
      path.join(configHome, "opencode/skill/global-native-singular"),
      "global-native-singular",
      "Global OpenCode singular description.",
    ),
    writeSkill(
      path.join(configHome, "opencode/skills/global-native-plural"),
      "global-native-plural",
      "Global OpenCode plural description.",
    ),
    writeSkill(
      path.join(sessionDirectory, "configured-skills/configured-path"),
      "configured-path",
      "Configured path description.",
    ),
    writeSkill(
      path.join(sessionDirectory, ".agents/skills/project-agent"),
      "project-agent",
      "Project Agent description.",
    ),
    writeSkill(
      path.join(ancestorDirectory, ".agents/skills/ancestor-agent"),
      "ancestor-agent",
      "Ancestor Agent description.",
    ),
    writeSkill(
      path.join(homeDirectory, ".agents/skills/global-agent"),
      "global-agent",
      "Global Agent description.",
    ),
    writeSkill(
      path.join(sessionDirectory, ".claude/skills/project-claude"),
      "project-claude",
      "Project Claude description.",
    ),
    writeSkill(
      path.join(ancestorDirectory, ".claude/skills/ancestor-claude"),
      "ancestor-claude",
      "Ancestor Claude description.",
    ),
    writeSkill(
      path.join(homeDirectory, ".claude/skills/global-claude"),
      "global-claude",
      "Global Claude description.",
    ),
    writeSkill(
      path.join(sessionDirectory, ".opencode/skills/duplicate-source"),
      DUPLICATE_SKILL_NAME,
      "OpenCode duplicate candidate.",
    ),
    writeSkill(
      path.join(sessionDirectory, ".agents/skills/duplicate-source"),
      DUPLICATE_SKILL_NAME,
      "Agent duplicate candidate.",
    ),
    writeSkill(
      path.join(sessionDirectory, ".claude/skills/duplicate-source"),
      DUPLICATE_SKILL_NAME,
      "Claude duplicate candidate.",
    ),
    writeSkill(
      path.join(repositoryDirectory, "skills/private-worktree-skill"),
      PRIVATE_SKILL_NAME,
      "Private scanner exception must stay inactive.",
    ),
  ])
  await writeFile(
    path.join(repositoryDirectory, "opencode.json"),
    `${JSON.stringify({ skills: { paths: ["./configured-skills"] } }, null, 2)}\n`,
    "utf8",
  )
}

async function shouldMatchResolvedOpenCodeSkillsAcrossFlags(
  opencodeBin,
  environment,
  repositoryDirectory,
  sessionDirectory,
) {
  // Given
  const externalSkillsEnabled = {
    ...environment,
    OPENCODE_DISABLE_CLAUDE_CODE: "false",
    OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "false",
    OPENCODE_DISABLE_EXTERNAL_SKILLS: "false",
  }

  // When
  const allSources = await captureResolvedSnapshot(
    opencodeBin,
    externalSkillsEnabled,
    repositoryDirectory,
    sessionDirectory,
  )
  const withoutClaude = await captureResolvedSnapshot(
    opencodeBin,
    { ...externalSkillsEnabled, OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "true" },
    repositoryDirectory,
    sessionDirectory,
  )
  const withoutExternal = await captureResolvedSnapshot(
    opencodeBin,
    { ...externalSkillsEnabled, OPENCODE_DISABLE_EXTERNAL_SKILLS: "true" },
    repositoryDirectory,
    sessionDirectory,
  )

  // Then
  assertSkillsPresent(allSources, [...NATIVE_SKILL_NAMES, ...AGENT_SKILL_NAMES, ...CLAUDE_SKILL_NAMES])
  assertSkillsAbsent(allSources, [PRIVATE_SKILL_NAME])
  assertSkillsPresent(withoutClaude, [...NATIVE_SKILL_NAMES, ...AGENT_SKILL_NAMES])
  assertSkillsAbsent(withoutClaude, [...CLAUDE_SKILL_NAMES, PRIVATE_SKILL_NAME])
  assertSkillsPresent(withoutExternal, NATIVE_SKILL_NAMES)
  assertSkillsAbsent(withoutExternal, [...AGENT_SKILL_NAMES, ...CLAUDE_SKILL_NAMES, PRIVATE_SKILL_NAME])
  for (const snapshot of [allSources, withoutClaude, withoutExternal]) {
    assert.equal(snapshot.skills.filter((entry) => entry.name === DUPLICATE_SKILL_NAME).length, 1)
    assert.equal(snapshot.registryEntries.filter((entry) => entry.name === DUPLICATE_SKILL_NAME).length, 1)
  }
  for (const name of AGENT_SKILL_NAMES) assertRegistrySection(allSources, name, "Agent Skills")
  for (const name of CLAUDE_SKILL_NAMES) assertRegistrySection(allSources, name, "Claude Skills")
  for (const name of NATIVE_SKILL_NAMES) assertRegistrySection(allSources, name, "OpenCode Skills")
  assert.match(await readFile(path.join(repositoryDirectory, ".git/info/exclude"), "utf8"), /(^|\n)\.ai\/(\n|$)/)
}

async function captureResolvedSnapshot(opencodeBin, environment, repositoryDirectory, sessionDirectory) {
  const files = {
    registry: path.join(repositoryDirectory, ".ai/atl/skill-registry.md"),
    hash: path.join(repositoryDirectory, ".ai/atl/skill-registry.hash"),
  }
  await Promise.all([rm(files.registry, { force: true }), rm(files.hash, { force: true })])
  const port = await reservePort()
  const serverExecutable = await resolveServerExecutable(opencodeBin)
  const server = startProcess(serverExecutable, [
    "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "DEBUG",
  ], environment, sessionDirectory)

  try {
    // When
    await waitForBootstrap(port, sessionDirectory, server)
    await waitForFile(files.registry, server)
    const response = await fetch(`http://127.0.0.1:${port}/skill?directory=${encodeURIComponent(sessionDirectory)}`, {
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    assert.equal(response.ok, true, `OpenCode /skill failed: ${response.status}\n${server.output()}`)
    const skills = await response.json()
    const markdown = await readFile(files.registry, "utf8")

    // Then
    assert.ok(Array.isArray(skills), `OpenCode /skill did not return an array\n${server.output()}`)
    const registryEntries = skillEntriesFromRegistry(markdown)
    assert.deepEqual(
      registryEntries.map(skillTriple).sort(compareSkillTriples),
      skills.map(skillTriple).sort(compareSkillTriples),
      `generated registry differs from OpenCode /skill\n${server.output()}`,
    )
    return { markdown, registryEntries, skills }
  } finally {
    await server.stop()
  }
}

function initializeGitRepository(repositoryDirectory) {
  const result = spawnSync("git", ["init", "--quiet", repositoryDirectory], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function resolveServerExecutable(opencodeBin) {
  const executable = path.resolve(path.dirname(opencodeBin), "../opencode-ai/bin/opencode.exe")
  try {
    if ((await stat(executable)).isFile()) return executable
  } catch {
    // Non-standard OpenCode installations can expose an executable directly.
  }
  return opencodeBin
}

async function writeSkill(directory, name, description) {
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
    "utf8",
  )
}

function skillEntriesFromRegistry(markdown) {
  const entries = []
  let section = ""
  for (const line of markdown.split("## Detected Convention Files")[0].split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3)
    if (!line.startsWith("| ") || line.startsWith("| Description ") || line === "| - | - | - |") continue
    const [description, name, location] = line.slice(2, -2).split(" | ")
    assert.ok(description !== undefined && name !== undefined && location !== undefined, `invalid registry row: ${line}`)
    entries.push({ description: description === "-" ? undefined : description, location, name, section })
  }
  return entries
}

function skillTriple(entry) {
  return { name: entry.name, description: entry.description, location: entry.location }
}

function compareSkillTriples(left, right) {
  return left.name.localeCompare(right.name) || left.location.localeCompare(right.location)
}

function assertSkillsPresent(snapshot, names) {
  const actual = new Set(snapshot.skills.map((entry) => entry.name))
  for (const name of names) assert.ok(actual.has(name), `OpenCode /skill is missing expected skill: ${name}`)
}

function assertSkillsAbsent(snapshot, names) {
  const actual = new Set(snapshot.skills.map((entry) => entry.name))
  for (const name of names) assert.equal(actual.has(name), false, `OpenCode /skill unexpectedly contains skill: ${name}`)
}

function assertRegistrySection(snapshot, name, section) {
  const entry = snapshot.registryEntries.find((candidate) => candidate.name === name)
  assert.equal(entry?.section, section, `${name} was rendered in the wrong section`)
}

async function reservePort() {
  const server = createPortServer()
  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  return address.port
}

function startProcess(command, args, env, cwd) {
  const child = spawn(command, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] })
  let stdout = ""
  let stderr = ""
  let closed
  const completion = new Promise((resolve) => {
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.once("error", (error) => {
      closed = { code: null, signal: null, error }
      resolve(closed)
    })
    child.once("close", (code, signal) => {
      closed = { code, signal }
      resolve(closed)
    })
  })

  return {
    closed: () => closed,
    output: () => stripAnsi(`${stdout}\n${stderr}`),
    stop: async () => {
      if (!closed) child.kill("SIGTERM")
      await Promise.race([completion, new Promise((resolve) => setTimeout(resolve, 2_000))])
      if (!closed) {
        child.kill("SIGKILL")
        await completion
      }
    },
  }
}

async function waitForFile(file, server) {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      await stat(file)
      return
    } catch {
      const closed = server.closed()
      if (closed) throw new Error(`OpenCode server exited before generating the registry: ${JSON.stringify(closed)}\n${server.output()}`)
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
  }
  throw new Error(`timed out waiting for generated registry\n${server.output()}`)
}

async function waitForBootstrap(port, projectDirectory, server) {
  const endpoint = `http://127.0.0.1:${port}/provider?directory=${encodeURIComponent(projectDirectory)}`
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS
  while (Date.now() < deadline) {
    const closed = server.closed()
    if (closed) throw new Error(`OpenCode server exited before bootstrap: ${JSON.stringify(closed)}\n${server.output()}`)
    try {
      const response = await fetch(endpoint, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      if (response.ok) return
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for OpenCode bootstrap\n${server.output()}`)
}

async function packPackage(destination) {
  const packed = spawnSync("pnpm", ["pack", "--pack-destination", destination], {
    cwd: ROOT,
    encoding: "utf8",
  })
  assert.equal(packed.status, 0, packed.stderr || packed.stdout)
  return readFile(path.join(destination, `${PACKAGE_NAME}-${packageJson.version}.tgz`))
}

async function startRegistry(tarball, requests) {
  const server = createServer((request, response) => {
    requests.push(`${request.method} ${request.url}`)
    if (request.method === "GET" && request.url === `/${PACKAGE_NAME}`) {
      const address = server.address()
      assert.ok(address && typeof address === "object")
      const tarballUrl = `http://127.0.0.1:${address.port}/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`
      return sendJson(response, {
        name: PACKAGE_NAME,
        "dist-tags": { latest: packageJson.version },
        versions: {
          [packageJson.version]: {
            ...packageJson,
            dist: {
              integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
              shasum: createHash("sha1").update(tarball).digest("hex"),
              tarball: tarballUrl,
            },
          },
        },
      })
    }

    if (request.method === "GET" && request.url === `/${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`) {
      response.writeHead(200, { "content-length": tarball.length, "content-type": "application/octet-stream" })
      return response.end(tarball)
    }

    if (request.method === "POST" && request.url?.startsWith("/-/npm/v1/security/")) return sendJson(response, {})
    response.writeHead(404)
    return response.end()
  })

  await new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  const address = server.address()
  assert.ok(address && typeof address === "object")
  return {
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
    url: `http://127.0.0.1:${address.port}/`,
  }
}

function sendJson(response, value) {
  const body = JSON.stringify(value)
  response.writeHead(200, { "content-length": Buffer.byteLength(body), "content-type": "application/json" })
  response.end(body)
}

function runProcess(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] })
    let stdout = ""
    let stderr = ""
    let timedOut = false
    const timeout = setTimeout(() => {
      timedOut = true
      child.kill("SIGTERM")
    }, INSTALL_TIMEOUT_MS)
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk })
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk })
    child.once("error", (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.once("close", (code, signal) => {
      clearTimeout(timeout)
      resolve({ code, signal, stderr, stdout, timedOut })
    })
  })
}

function stripAnsi(value) {
  return value.replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "")
}

await shouldInstallOnFirstAttemptWhenCacheIsEmpty()
