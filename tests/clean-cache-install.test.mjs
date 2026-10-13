import assert from "node:assert/strict"
import { spawn, spawnSync } from "node:child_process"
import { createHash, randomBytes } from "node:crypto"
import { OpenCode } from "@opencode/client"
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
const PRIVATE_SKILL_BODY = "PRIVATE_SKILL_BODY_MUST_STAY_OUT_OF_REGISTRY"
const PLUGIN_ID = "andresnator.skill-registry"
const AUTH_USERNAME = "opencode"
const EQUAL_DISPLAY_NAME = "shared-display-name"
const CONTRIBUTOR_IDS = ["fixture.early-contributor", "fixture.late-contributor"]
const LATE_SKILL_ID = "late-added-skill"

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
      XDG_STATE_HOME: path.join(temporaryRoot, "state"),
      OPENCODE_CONFIG_DIR: path.join(configHome, "opencode"),
      TMPDIR: path.join(temporaryRoot, "tmp"),
    }
    for (const key of ["OPENCODE_CONFIG", "OPENCODE_CONFIG_CONTENT", "OPENCODE_PASSWORD", "OPENCODE_SERVER_PASSWORD", "OPENCODE_SERVER", "OPENCODE_SERVER_URL"]) delete isolatedEnvironment[key]
    await mkdir(isolatedEnvironment.TMPDIR, { recursive: true })

    // When
    const opencodeBin = process.env.OPENCODE_BIN ?? DEFAULT_OPENCODE_BIN
    const result = await runProcess(opencodeBin, [
      "plugin", "add", packageSpec, "--print-logs", "--log-level", "debug",
    ], isolatedEnvironment)

    // Then
    const output = stripAnsi(`${result.stdout}\n${result.stderr}`)
    assert.equal(result.timedOut, false, `OpenCode installation timed out:\n${output}`)
    assert.equal(result.code, 0, `first OpenCode installation failed:\n${output}\nregistry requests: ${requests.join(", ")}`)
    assert.ok(requests.includes(`GET /${PACKAGE_NAME}`), "OpenCode did not request the package metadata")
    assert.ok(
      requests.includes(`GET /${PACKAGE_NAME}/-/${PACKAGE_NAME}-${packageJson.version}.tgz`),
      `OpenCode did not download the packed artifact: ${requests.join(", ")}`,
    )

    const configFile = path.join(configHome, "opencode", "opencode.json")
    const config = JSON.parse(await readFile(configFile, "utf8"))
    assert.deepEqual(config.plugins, [packageSpec])

    const version = await runProcess(opencodeBin, ["--version"], isolatedEnvironment)
    assert.equal(version.code, 0, version.stderr)
    await shouldMatchResolvedOpenCodeSkillsAcrossFlags(
      opencodeBin,
      isolatedEnvironment,
      repositoryDirectory,
      sessionDirectory,
      version.stdout.trim(),
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
    writeSkill(path.join(sessionDirectory, ".opencode/skills/equal-name-one"), EQUAL_DISPLAY_NAME, "First distinct ID."),
    writeSkill(path.join(sessionDirectory, ".opencode/skills/equal-name-two"), EQUAL_DISPLAY_NAME, "Second distinct ID."),
    writeSkill(
      path.join(repositoryDirectory, "skills/private-worktree-skill"),
      PRIVATE_SKILL_NAME,
      "Private scanner exception must stay inactive.",
    ),
  ])
  const contributors = await writeContributorFixtures(repositoryDirectory)
  await writeFile(
    path.join(repositoryDirectory, "opencode.json"),
    `${JSON.stringify({ skills: ["./configured-skills"], plugins: contributors }, null, 2)}\n`,
    "utf8",
  )
}

async function shouldMatchResolvedOpenCodeSkillsAcrossFlags(
  opencodeBin,
  environment,
  repositoryDirectory,
  sessionDirectory,
  version,
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
    true,
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

  const configFile = path.join(repositoryDirectory, "opencode.json")
  const config = JSON.parse(await readFile(configFile, "utf8"))
  await writeFile(configFile, `${JSON.stringify({ ...config, plugins: [...config.plugins].reverse() })}\n`, "utf8")
  const reordered = await captureResolvedSnapshot(opencodeBin, externalSkillsEnabled, repositoryDirectory, sessionDirectory)

  // Then
  assert.deepEqual(reordered.skills.map(skillTriple).sort(compareSkillTriples), allSources.skills.map(skillTriple).sort(compareSkillTriples))
  assertSkillsPresent(allSources, CONTRIBUTOR_IDS)
  assertSkillsPresent(allSources, [...NATIVE_SKILL_NAMES, ...AGENT_SKILL_NAMES, ...CLAUDE_SKILL_NAMES])
  assertSkillsAbsent(allSources, [PRIVATE_SKILL_NAME])
  // Characterize the installed release without imposing its ignored flags on future 2.x versions.
  if (version.match(/\d+\.\d+\.\d+/)?.[0] === "2.0.28") {
    for (const snapshot of [withoutClaude, withoutExternal]) {
      assert.deepEqual(snapshot.skills.map(skillTriple).sort(compareSkillTriples), allSources.skills.map(skillTriple).sort(compareSkillTriples))
    }
  }
  for (const snapshot of [allSources, withoutClaude, withoutExternal, reordered]) {
    assert.equal(snapshot.skills.filter((entry) => entry.name === EQUAL_DISPLAY_NAME).length, 2)
    assert.equal(snapshot.registryEntries.filter((entry) => entry.name === EQUAL_DISPLAY_NAME).length, 2)
    assert.equal(snapshot.skills.filter((entry) => entry.name === DUPLICATE_SKILL_NAME).length, 1)
    assert.equal(snapshot.registryEntries.filter((entry) => entry.name === DUPLICATE_SKILL_NAME).length, 1)
  }
  for (const name of AGENT_SKILL_NAMES) assertRegistrySection(allSources, name, "Agent Skills")
  for (const name of CLAUDE_SKILL_NAMES) assertRegistrySection(allSources, name, "Claude Skills")
  for (const name of NATIVE_SKILL_NAMES) assertRegistrySection(allSources, name, "OpenCode Skills")
}

async function captureResolvedSnapshot(opencodeBin, environment, repositoryDirectory, sessionDirectory, verifyLifecycle = false) {
  const files = {
    registry: path.join(repositoryDirectory, ".ai/atl/skill-registry.md"),
    hash: path.join(repositoryDirectory, ".ai/atl/skill-registry.hash"),
  }
  await mkdir(path.dirname(files.registry), { recursive: true })
  await writeFile(files.registry, "# Legacy V1 registry\n", "utf8")
  await writeFile(files.hash, "legacy-hash\n", "utf8")
  const port = await reservePort()
  const password = randomBytes(32).toString("hex")
  const authorization = `Basic ${Buffer.from(`${AUTH_USERNAME}:${password}`).toString("base64")}`
  const client = OpenCode.make({ baseUrl: `http://127.0.0.1:${port}`, headers: { Authorization: authorization } })
  const location = { directory: sessionDirectory }
  const server = startProcess(opencodeBin, [
    "serve", "--hostname", "127.0.0.1", "--port", String(port), "--print-logs", "--log-level", "debug",
  ], { ...environment, OPENCODE_PASSWORD: password, OPENCODE_SERVER_PASSWORD: password }, sessionDirectory, [password, authorization, authorization.slice(6)])

  try {
    // When
    await waitForBootstrap(client, location, server)
    await waitForRegistryPlugin(client, location, server)
    await waitForFile(files.registry, server, files.hash)
    const { data: skills } = await client.skill.list({ location }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const markdown = await readFile(files.registry, "utf8")
    const unauthenticated = await fetch(`http://127.0.0.1:${port}/api/skill?directory=${encodeURIComponent(sessionDirectory)}`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    assert.equal(unauthenticated.status, 401, "the isolated server must keep authentication enabled")

    // Then
    assert.ok(Array.isArray(skills), `OpenCode skill.list did not return an array\n${server.output()}`)
    assert.doesNotMatch(markdown, new RegExp(PRIVATE_SKILL_BODY))
    assert.equal((await readFile(files.hash, "utf8")).trim(), createHash("sha256").update(markdown).digest("hex"))
    const registryEntries = skillEntriesFromRegistry(markdown)
    assert.deepEqual(
      registryEntries.map(skillTriple).sort(compareSkillTriples),
      skills.map((entry) => skillTriple({ ...entry, location: entry.path })).sort(compareSkillTriples),
      `generated registry differs from OpenCode skill.list\n${server.output()}`,
    )
    await assert.rejects(stat(path.join(sessionDirectory, ".ai/atl/skill-registry.md")), /ENOENT/)
    if (verifyLifecycle) await shouldKeepSnapshotAndCleanUpWhenNativeLocationReloads(client, location, files, repositoryDirectory, server)
    return { markdown, registryEntries, skills }
  } finally {
    await server.stop()
  }
}

async function writeContributorFixtures(repositoryDirectory) {
  const directories = []
  for (const id of CONTRIBUTOR_IDS) {
    const directory = path.join(repositoryDirectory, "contributors", id)
    directories.push(directory)
    await mkdir(directory, { recursive: true })
    await writeFile(path.join(directory, "package.json"), JSON.stringify({ type: "module", main: "./index.mjs" }))
    await writeFile(path.join(directory, "index.mjs"), `
      import { appendFile } from "node:fs/promises"
      export default {
        id: ${JSON.stringify(id)},
        async setup(ctx) {
          await new Promise((resolve) => setTimeout(resolve, 150))
          await ctx.skill.transform((editor) => editor.add({
            id: ${JSON.stringify(id)},
            name: ${JSON.stringify(id)},
            description: "Delayed startup contributor.",
            path: ${JSON.stringify(path.join(directory, "SKILL.md"))},
            content: ${JSON.stringify(PRIVATE_SKILL_BODY)},
          }))
          return () => appendFile(${JSON.stringify(path.join(repositoryDirectory, "contributor-cleanup.log"))}, ${JSON.stringify(id + "\n")})
        },
      }
    `)
  }
  return directories
}

async function shouldKeepSnapshotAndCleanUpWhenNativeLocationReloads(client, location, files, repositoryDirectory, server) {
  // Given
  const markdown = await readFile(files.registry, "utf8")
  const hash = await readFile(files.hash, "utf8")
  const previous = await stat(files.registry)
  const lateDirectory = path.join(location.directory, ".opencode/skills", LATE_SKILL_ID)

  try {
    // When
    await writeSkill(lateDirectory, LATE_SKILL_ID, "Native skills may change after the fixed startup snapshot.")
    await waitForCondition(async () => {
      const { data } = await client.skill.list({ location }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      return data.some((entry) => entry.id === LATE_SKILL_ID)
    }, "native skill watcher update", server)

    // Then
    assert.deepEqual({
      markdown: await readFile(files.registry, "utf8"),
      hash: await readFile(files.hash, "utf8"),
      mtime: (await stat(files.registry)).mtimeMs,
    }, { markdown, hash, mtime: previous.mtimeMs })
  } finally {
    await rm(lateDirectory, { recursive: true, force: true })
  }

  // When
  await client.location.reload({ signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  await waitForCondition(async () => {
    try {
      const cleanup = await readFile(path.join(repositoryDirectory, "contributor-cleanup.log"), "utf8")
      return CONTRIBUTOR_IDS.every((id) => cleanup.includes(id))
    } catch {
      return false
    }
  }, "native contributor cleanup", server)
  await waitForBootstrap(client, location, server)
  await waitForRegistryPlugin(client, location, server)

  // Then
  const { data } = await client.skill.list({ location }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  assert.equal(data.some((entry) => entry.id === LATE_SKILL_ID), false)
}

async function waitForCondition(condition, what, server) {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await condition()) return
    if (server.closed()) throw new Error(`OpenCode server exited before ${what}\n${server.output()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for ${what}\n${server.output()}`)
}

function initializeGitRepository(repositoryDirectory) {
  const result = spawnSync("git", ["init", "--quiet", repositoryDirectory], { encoding: "utf8" })
  assert.equal(result.status, 0, result.stderr || result.stdout)
}

async function writeSkill(directory, name, description) {
  await mkdir(directory, { recursive: true })
  await writeFile(
    path.join(directory, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n${PRIVATE_SKILL_BODY}\n`,
    "utf8",
  )
}

function skillEntriesFromRegistry(markdown) {
  const entries = []
  let section = ""
  for (const line of markdown.split("## Detected Convention Files")[0].split("\n")) {
    if (line.startsWith("## ")) section = line.slice(3)
    if (!line.startsWith("| ") || line.startsWith("| Description ") || line === "| - | - | - | - |") continue
    const [description, id, name, location] = line.slice(2, -2).split(" | ")
    assert.ok(description !== undefined && id !== undefined && name !== undefined && location !== undefined, `invalid registry row: ${line}`)
    entries.push({ description: description === "-" ? undefined : description, id, location, name, section })
  }
  return entries
}

function skillTriple(entry) {
  return { id: entry.id, name: entry.name, description: entry.description, location: entry.location ?? entry.path }
}

function compareSkillTriples(left, right) {
  return left.id.localeCompare(right.id)
}

function assertSkillsPresent(snapshot, names) {
  const actual = new Set(snapshot.skills.map((entry) => entry.name))
  for (const name of names) assert.ok(actual.has(name), `OpenCode skill.list is missing expected skill: ${name}`)
}

function assertSkillsAbsent(snapshot, names) {
  const actual = new Set(snapshot.skills.map((entry) => entry.name))
  for (const name of names) assert.equal(actual.has(name), false, `OpenCode skill.list unexpectedly contains skill: ${name}`)
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

function startProcess(command, args, env, cwd, secrets = []) {
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
    output: () => redactDiagnostics(stripAnsi(`${stdout}\n${stderr}`), secrets),
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

async function waitForFile(file, server, hashFile) {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const text = await readFile(file, "utf8")
      const hash = (await readFile(hashFile, "utf8")).trim()
      if (text.startsWith("# Skill Registry") && hash === createHash("sha256").update(text).digest("hex")) return
    } catch {
      // Registry and hash may still be missing or between their two renames.
    }
    const closed = server.closed()
    if (closed) throw new Error(`OpenCode server exited before generating the registry: ${JSON.stringify(closed)}\n${server.output()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for generated registry\n${server.output()}`)
}

async function waitForBootstrap(client, location, server) {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS
  while (Date.now() < deadline) {
    const closed = server.closed()
    if (closed) throw new Error(`OpenCode server exited before bootstrap: ${JSON.stringify(closed)}\n${server.output()}`)
    try {
      await client.location.get({ location }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
      return
    } catch {
      // The listener may not be ready yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for OpenCode bootstrap\n${server.output()}`)
}

async function waitForRegistryPlugin(client, location, server) {
  const deadline = Date.now() + RUNTIME_TIMEOUT_MS
  while (Date.now() < deadline) {
    const { data: plugins } = await client.plugin.list({ location }, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
    const plugin = plugins.find((entry) => entry.id === PLUGIN_ID)
    const failed = plugins.find((entry) => entry.state.status === "failed")
    assert.equal(failed, undefined, `plugin activation failed\n${server.output()}`)
    if (plugin?.state.status === "active") return
    if (server.closed()) throw new Error(`OpenCode server exited before plugin activation\n${server.output()}`)
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error(`timed out waiting for registry plugin activation\n${server.output()}`)
}

function redactDiagnostics(output, secrets) {
  let safe = output.replace(/(password[:=]\s*)\S+/gi, "$1[redacted]")
  for (const secret of secrets) if (secret) safe = safe.replaceAll(secret, "[redacted]")
  return safe
}

function shouldRedactCredentialsWhenDiagnosticsAreReported() {
  // Given
  const fakePassword = "fixture-password-not-a-real-credential"
  const fakeEncoded = Buffer.from(`${AUTH_USERNAME}:${fakePassword}`).toString("base64")

  // When
  const output = redactDiagnostics(`password: ${fakePassword}\nBasic ${fakeEncoded}`, [fakePassword, fakeEncoded])

  // Then
  assert.equal(output, "password: [redacted]\nBasic [redacted]")
}

async function shouldWaitForMatchingHashWhenRegistryIsPublishedFirst() {
  // Given
  const directory = await mkdtemp(path.join(tmpdir(), "skill-registry-readiness-"))
  const registry = path.join(directory, "skill-registry.md")
  const hash = path.join(directory, "skill-registry.hash")
  const markdown = "# Skill Registry\n"
  const matchingHash = createHash("sha256").update(markdown).digest("hex")
  await writeFile(registry, markdown, "utf8")
  await writeFile(hash, "previous-hash", "utf8")
  const server = { closed: () => undefined, output: () => "" }
  let ready = false
  const pending = waitForFile(registry, server, hash).then(() => { ready = true })

  try {
    // When
    await new Promise((resolve) => setTimeout(resolve, 100))
    assert.equal(ready, false, "a new registry with an old hash is not ready")
    await writeFile(hash, matchingHash, "utf8")
    await pending

    // Then
    assert.equal(ready, true)
  } finally {
    await writeFile(hash, matchingHash, "utf8")
    await pending
    await rm(directory, { recursive: true, force: true })
  }
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

shouldRedactCredentialsWhenDiagnosticsAreReported()
await shouldWaitForMatchingHashWhenRegistryIsPublishedFirst()
await shouldInstallOnFirstAttemptWhenCacheIsEmpty()
