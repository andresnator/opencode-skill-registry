import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { classifySkillSource, renderRegistry } from "../src/registry.ts"
import { SkillRegistryPlugin } from "../src/server.ts"
import { collectConventionEntries, loadOpenCodeSkills, type OpenCodeSkill } from "../src/source.ts"
import { publishRegistry, registryFiles, registryHash } from "../src/store.ts"

const WAIT_TIMEOUT_MS = 5_000
const RETRY_WAIT_MS = 1_050
const SETTLE_WAIT_MS = 100

const testRoot = process.env.SKILL_REGISTRY_TEST_ROOT ?? ""
if (!testRoot || !os.homedir().startsWith(testRoot)) {
  console.error("FAIL: run via scripts/test-skill-registry.sh; an isolated HOME under SKILL_REGISTRY_TEST_ROOT is required")
  process.exit(1)
}

let passed = 0

function pass(name: string): void {
  passed += 1
  console.log(`ok - ${name}`)
}

function skill(name: string, location: string, description?: string): OpenCodeSkill {
  return { name, location, description }
}

async function exists(file: string): Promise<boolean> {
  try {
    await fs.stat(file)
    return true
  } catch {
    return false
  }
}

async function waitFor(condition: () => Promise<boolean> | boolean, what: string): Promise<void> {
  const deadline = Date.now() + WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (await condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timeout waiting for ${what}`)
}

function pluginInput(worktree: string, request: () => Promise<unknown>) {
  return {
    worktree,
    directory: worktree,
    client: { app: { skills: request } },
  } as never
}

async function shouldPreferPublicSkillMethodWhenAvailable(): Promise<void> {
  // Given
  const directory = path.join(testRoot, "public-method")
  let receivedDirectory = ""
  let legacyCalled = false
  const client = {
    app: {
      skills: async (parameters?: { directory?: string }) => {
        receivedDirectory = parameters?.directory ?? ""
        return { data: [{ name: "native", description: "Trigger: native.", location: "/skills/native/SKILL.md" }] }
      },
    },
    _client: {
      get: async () => {
        legacyCalled = true
        return { data: [] }
      },
    },
  }

  // When
  const result = await loadOpenCodeSkills(client as never, directory)

  // Then
  assert.deepEqual(result, [skill("native", "/skills/native/SKILL.md", "Trigger: native.")])
  assert.equal(receivedDirectory, directory)
  assert.equal(legacyCalled, false)
  pass("shouldPreferPublicSkillMethodWhenAvailable")
}

async function shouldUseLegacyTransportWhenPublicMethodIsUnavailable(): Promise<void> {
  // Given
  let requestOptions: unknown
  const client = {
    app: {},
    _client: {
      get: async (options: unknown) => {
        requestOptions = options
        return [{ name: "legacy", location: "<built-in>" }]
      },
    },
  }

  // When
  const result = await loadOpenCodeSkills(client as never, testRoot)

  // Then
  assert.deepEqual(requestOptions, { url: "/skill" })
  assert.deepEqual(result, [skill("legacy", "<built-in>")])
  pass("shouldUseLegacyTransportWhenPublicMethodIsUnavailable")
}

async function shouldRejectMalformedOrUnavailableOpenCodeResponses(): Promise<void> {
  // Given
  const invalidResponses: Array<{ response: unknown; message: RegExp }> = [
    { response: { data: "not-an-array" }, message: /non-array response/ },
    { response: { data: [null] }, message: /invalid entry at index 0/ },
    { response: { data: [{ name: 42, location: "/one/SKILL.md" }] }, message: /has no string name/ },
    { response: { data: [{ name: "one", location: null }] }, message: /has no string location/ },
    { response: { data: [{ name: "one", description: 42, location: "/one/SKILL.md" }] }, message: /invalid description/ },
    {
      response: { data: [
        { name: "same", location: "/one/SKILL.md" },
        { name: "same", location: "/two/SKILL.md" },
      ] },
      message: /duplicate name: same/,
    },
  ]

  // When / Then
  for (const invalid of invalidResponses) {
    await assert.rejects(
      loadOpenCodeSkills({ app: { skills: async () => invalid.response } } as never, testRoot),
      invalid.message,
    )
  }
  await assert.rejects(loadOpenCodeSkills({ app: {} } as never, testRoot), /does not expose the \/skill transport/)
  await assert.rejects(
    loadOpenCodeSkills({ app: { skills: async () => ({ error: "unavailable" }) } } as never, testRoot),
    /request failed: unavailable/,
  )
  pass("shouldRejectMalformedOrUnavailableOpenCodeResponses")
}

async function shouldRenderAllSkillsInOpenCodeAgentsClaudeOrder(): Promise<void> {
  // Given
  const skills = [
    skill("claude-one", "/repo/.claude/skills/claude-one/SKILL.md", "Trigger: claude. Keep this detail."),
    skill("agent-one", "/repo/.agents/skills/agent-one/SKILL.md", "Trigger: agent | compatibility."),
    skill("native-one", "/repo/.opencode/skills/native-one/SKILL.md", "Trigger: native. Keep this detail."),
    skill("built-in", "<built-in>"),
  ]
  const original = structuredClone(skills)

  // When
  const markdown = renderRegistry(skills, [])

  // Then
  const openCodeHeading = markdown.indexOf("## OpenCode Skills")
  const agentsHeading = markdown.indexOf("## Agent Skills")
  const claudeHeading = markdown.indexOf("## Claude Skills")
  assert.ok(openCodeHeading >= 0 && openCodeHeading < agentsHeading && agentsHeading < claudeHeading)
  assert.ok(markdown.indexOf("| Trigger: native. Keep this detail. | native-one |", openCodeHeading) < agentsHeading)
  assert.ok(markdown.indexOf("| Trigger: agent \\| compatibility. | agent-one |", agentsHeading) < claudeHeading)
  assert.ok(markdown.indexOf("| Trigger: claude. Keep this detail. | claude-one |", claudeHeading) > claudeHeading)
  assert.match(markdown, /\| - \| built-in \| <built-in> \|/)
  const renderedSkillRows = markdown
    .split("## Detected Convention Files")[0]
    .split("\n")
    .filter((line) => line.startsWith("| ") && !line.startsWith("| Description ") && line !== "| - | - | - |")
  assert.equal(renderedSkillRows.length, skills.length)
  assert.deepEqual(skills, original)
  assert.equal(classifySkillSource("C:\\repo\\.agents\\skills\\one\\SKILL.md"), "agents")
  assert.equal(classifySkillSource("C:\\repo\\.claude\\skills\\one\\SKILL.md"), "claude")
  pass("shouldRenderAllSkillsInOpenCodeAgentsClaudeOrder")
}

async function shouldLabelConventionsAsCompatibilityInventory(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "conventions")
  await fs.mkdir(path.join(worktree, "docs"), { recursive: true })
  await fs.mkdir(path.join(worktree, ".ai/atl"), { recursive: true })
  await fs.writeFile(path.join(worktree, "docs/rules.md"), "rules\n", "utf8")
  await fs.writeFile(path.join(worktree, ".ai/reference.md"), "reference\n", "utf8")
  await fs.writeFile(path.join(worktree, ".ai/atl/ignored.md"), "ignored\n", "utf8")
  await fs.writeFile(
    path.join(worktree, "AGENTS.md"),
    "Read `docs/rules.md`, `.ai/reference.md`, `.ai/atl/ignored.md`, `../outside.md`, and `docs/*.md`.\n",
    "utf8",
  )

  // When
  const entries = await collectConventionEntries(worktree)
  const markdown = renderRegistry([], entries)

  // Then
  assert.deepEqual(entries, [
    { file: "AGENTS.md", path: path.join(worktree, "AGENTS.md"), notes: "Detected compatibility convention" },
    { file: "rules.md", path: path.join(worktree, "docs/rules.md"), notes: "Referenced by AGENTS.md" },
    { file: "reference.md", path: path.join(worktree, ".ai/reference.md"), notes: "Referenced by AGENTS.md" },
  ])
  assert.match(markdown, /Compatibility inventory only/)
  assert.doesNotMatch(markdown, /ignored\.md/)
  pass("shouldLabelConventionsAsCompatibilityInventory")
}

async function shouldSkipOnlyWhenHashAndRegistryContentMatch(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "hash")
  const original = "# Registry\n\noriginal\n"
  const changed = "# Registry\n\nchanged description and location\n"
  const files = registryFiles(worktree)

  // When
  assert.equal(await publishRegistry(worktree, original), true)
  assert.equal(await publishRegistry(worktree, original), false)
  await fs.writeFile(files.registryFile, "CORRUPTED", "utf8")
  const repaired = await publishRegistry(worktree, original)
  const changedWritten = await publishRegistry(worktree, changed)

  // Then
  assert.equal(repaired, true)
  assert.equal(changedWritten, true)
  assert.equal(await fs.readFile(files.registryFile, "utf8"), changed)
  assert.equal((await fs.readFile(files.hashFile, "utf8")).trim(), registryHash(changed))
  pass("shouldSkipOnlyWhenHashAndRegistryContentMatch")
}

async function shouldRepairAfterHashRenameFails(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "atomic")
  const previous = "# Registry\n\nprevious\n"
  const next = "# Registry\n\nnext\n"
  const files = registryFiles(worktree)
  await publishRegistry(worktree, previous)
  let renameCount = 0

  // When
  await assert.rejects(
    publishRegistry(worktree, next, async (oldPath, newPath) => {
      renameCount += 1
      if (renameCount === 2) throw new Error("simulated hash rename failure")
      await fs.rename(oldPath, newPath)
    }),
    /simulated hash rename failure/,
  )

  // Then
  assert.equal(await fs.readFile(files.registryFile, "utf8"), next)
  assert.equal((await fs.readFile(files.hashFile, "utf8")).trim(), registryHash(previous))
  assert.equal(await publishRegistry(worktree, next), true)
  assert.equal((await fs.readFile(files.hashFile, "utf8")).trim(), registryHash(next))
  assert.deepEqual((await fs.readdir(path.dirname(files.registryFile))).filter((file) => file.endsWith(".tmp")), [])
  pass("shouldRepairAfterHashRenameFails")
}

async function shouldGenerateOnceAfterConfigAndIgnoreEventsAfterSuccess(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "session-snapshot")
  let requests = 0
  let response = [skill("session-one", "/repo/.opencode/skills/session-one/SKILL.md", "Trigger: first.")]
  const hooks = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    return { data: response }
  }))
  const registryFile = registryFiles(worktree).registryFile

  // When
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
  assert.equal(await exists(registryFile), false)
  await hooks.config?.({} as never)
  await waitFor(() => exists(registryFile), "registry after config hook")
  response = [skill("session-two", "/repo/.opencode/skills/session-two/SKILL.md", "Trigger: second.")]
  await hooks.event?.({ event: { type: "file.watcher.updated" } } as never)
  await hooks.config?.({} as never)
  await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))

  // Then
  const markdown = await fs.readFile(registryFile, "utf8")
  assert.match(markdown, /session-one/)
  assert.doesNotMatch(markdown, /session-two/)
  assert.equal(requests, 1)
  pass("shouldGenerateOnceAfterConfigAndIgnoreEventsAfterSuccess")
}

async function shouldRetryGenerationAfterFailure(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "retry")
  let requests = 0
  const hooks = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    if (requests === 1) throw new Error("transient source failure")
    return { data: [skill("recovered", "/repo/.opencode/skills/recovered/SKILL.md")] }
  }))
  const errors: string[] = []
  const originalError = console.error
  console.error = (message: unknown) => errors.push(String(message))

  try {
    // When
    await hooks.config?.({} as never)
    await waitFor(() => errors.length === 1, "initial source failure")
    assert.equal(await exists(registryFiles(worktree).registryFile), false)
    await hooks.event?.({ event: { type: "test" } } as never)
    await waitFor(() => exists(registryFiles(worktree).registryFile), "registry after retry")

    // Then
    assert.equal(requests, 2)
    assert.match(await fs.readFile(registryFiles(worktree).registryFile, "utf8"), /recovered/)
  } finally {
    console.error = originalError
  }
  pass("shouldRetryGenerationAfterFailure")
}

async function shouldBoundRetriesOnPersistentFailure(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "retry-cap")
  const hooks = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    throw new Error("persistent source failure")
  }))
  const errors: string[] = []
  const originalError = console.error
  console.error = (message: unknown) => errors.push(String(message))

  try {
    // When
    await hooks.config?.({} as never)
    await waitFor(() => errors.length === 1, "initial persistent failure")
    await hooks.event?.({ event: { type: "test" } } as never)
    await waitFor(() => errors.length === 2, "immediate retry")
    for (let index = 0; index < 20; index++) await hooks.event?.({ event: { type: "test" } } as never)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
    assert.equal(errors.length, 2)

    for (const attempt of [3, 4]) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS))
      await hooks.event?.({ event: { type: "test" } } as never)
      await waitFor(() => errors.length === attempt, `retry ${attempt - 1}`)
    }

    // Then
    assert.match(errors[3], /retry budget spent/)
    await new Promise((resolve) => setTimeout(resolve, RETRY_WAIT_MS))
    await hooks.event?.({ event: { type: "test" } } as never)
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
    assert.equal(errors.length, 4)
  } finally {
    console.error = originalError
  }
  pass("shouldBoundRetriesOnPersistentFailure")
}

await shouldPreferPublicSkillMethodWhenAvailable()
await shouldUseLegacyTransportWhenPublicMethodIsUnavailable()
await shouldRejectMalformedOrUnavailableOpenCodeResponses()
await shouldRenderAllSkillsInOpenCodeAgentsClaudeOrder()
await shouldLabelConventionsAsCompatibilityInventory()
await shouldSkipOnlyWhenHashAndRegistryContentMatch()
await shouldRepairAfterHashRenameFails()
await shouldGenerateOnceAfterConfigAndIgnoreEventsAfterSuccess()
await shouldRetryGenerationAfterFailure()
await shouldBoundRetriesOnPersistentFailure()

console.log(`PASS: ${passed} skill-registry plugin contract group(s)`)
