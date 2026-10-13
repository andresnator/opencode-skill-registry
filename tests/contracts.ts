import assert from "node:assert/strict"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { MAX_RETRIES, RETRY_COOLDOWN_MS, STARTUP_TIMEOUT_MS, NATIVE_SKILL_PROVIDER_IDS } from "../src/constants.ts"
import { classifySkillSource, renderRegistry } from "../src/registry.ts"
import plugin, { SkillRegistryPlugin } from "../src/server.ts"
import { collectConventionEntries, loadOpenCodeSkills, type OpenCodeSkill } from "../src/source.ts"
import { publishRegistry, registryFiles, registryHash } from "../src/store.ts"

const WAIT_TIMEOUT_MS = STARTUP_TIMEOUT_MS + RETRY_COOLDOWN_MS
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
function skill(id: string, location: string, description?: string): OpenCodeSkill {
  return { id, name: id, location, description }
}
function nativeResponse(skills: OpenCodeSkill[]) {
  return {
    location: { directory: testRoot },
    data: skills.map(({ location, ...metadata }) => ({ ...metadata, path: location, content: "PRIVATE BODY MUST NOT BE INDEXED" })),
  }
}
function inventory() {
  return { data: NATIVE_SKILL_PROVIDER_IDS.map((id) => ({ id, state: { status: "active" } })) }
}
function pluginInput(
  worktree: string,
  request: (input?: unknown, options?: { signal?: AbortSignal }) => Promise<unknown>,
  plugins: () => Promise<unknown> = async () => inventory(),
): Plugin.Context {
  return {
    location: { directory: worktree, project: { directory: worktree, canonical: "/not-this-worktree" } },
    skill: { list: request },
    plugin: { list: plugins },
  } as never
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

async function shouldProjectNativeV2MetadataWhenListingSkills(): Promise<void> {
  // Given
  const controller = new AbortController()
  let received: unknown
  const context = pluginInput(testRoot, async (input, options) => {
    received = { input, signal: options?.signal }
    return nativeResponse([skill("native", "/skills/native/SKILL.md", "Trigger: native.")])
  })

  // When
  const result = await loadOpenCodeSkills(context, controller.signal)

  // Then
  assert.deepEqual(result, [skill("native", "/skills/native/SKILL.md", "Trigger: native.")])
  assert.deepEqual(received, { input: undefined, signal: controller.signal })
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE BODY/)
  pass("shouldProjectNativeV2MetadataWhenListingSkills")
}

async function shouldKeepEqualNamesWhenNativeIDsDiffer(): Promise<void> {
  // Given
  const entries = [skill("same", "/one/SKILL.md"), { ...skill("other-id", "/two/SKILL.md"), name: "same" }]

  // When
  const result = await loadOpenCodeSkills(pluginInput(testRoot, async () => nativeResponse(entries)))

  // Then
  assert.deepEqual(result, entries)
  const markdown = renderRegistry(result, [])
  assert.match(markdown, /\| same \| same \| \/one\/SKILL.md \|/)
  assert.match(markdown, /\| other-id \| same \| \/two\/SKILL.md \|/)
  pass("shouldKeepEqualNamesWhenNativeIDsDiffer")
}

async function shouldRejectMalformedOrUnavailableOpenCodeResponses(): Promise<void> {
  // Given
  const invalidResponses = [
    { data: "not-an-array", message: /non-array response/ },
    { data: [null], message: /invalid entry at index 0/ },
    { data: [{ id: null }], message: /has no string id/ },
    { data: [{ id: "one", name: 42 }], message: /has no string name/ },
    { data: [{ id: "one", name: "one", path: null }], message: /has no string path/ },
    { data: [{ id: "one", name: "one", path: "/one", description: 42 }], message: /invalid description/ },
    { data: [{ id: "same", name: "one", path: "/one" }, { id: "same", name: "two", path: "/two" }], message: /duplicate id: same/ },
  ]

  // When / Then
  for (const invalid of invalidResponses) {
    await assert.rejects(loadOpenCodeSkills(pluginInput(testRoot, async () => ({ data: invalid.data }))), invalid.message)
  }
  await assert.rejects(loadOpenCodeSkills(pluginInput(testRoot, async () => { throw new Error("unavailable") })), /unavailable/)
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
  assert.ok(markdown.indexOf("| Trigger: native. Keep this detail. | native-one | native-one |", openCodeHeading) < agentsHeading)
  assert.ok(markdown.indexOf("| Trigger: agent \\| compatibility. | agent-one | agent-one |", agentsHeading) < claudeHeading)
  assert.ok(markdown.indexOf("| Trigger: claude. Keep this detail. | claude-one | claude-one |", claudeHeading) > claudeHeading)
  assert.match(markdown, /\| - \| built-in \| built-in \| <built-in> \|/)
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


async function shouldGenerateOnceWhenV2SetupStarts(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "session-snapshot")
  let requests = 0
  let response = [skill("session-one", "/repo/.opencode/skills/session-one/SKILL.md", "Trigger: first.")]
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    return nativeResponse(response)
  }))
  const registryFile = registryFiles(worktree).registryFile

  try {
    // When
    await waitFor(() => exists(registryFile), "registry after setup")
    response = [skill("session-two", "/repo/.opencode/skills/session-two/SKILL.md", "Trigger: second.")]
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))

    // Then
    const markdown = await fs.readFile(registryFile, "utf8")
    assert.match(markdown, /session-one/)
    assert.doesNotMatch(markdown, /session-two|PRIVATE BODY/)
    assert.equal(requests, 1)
    assert.equal(typeof cleanup, "function")
    assert.equal(plugin.id, "andresnator.skill-registry")
    assert.equal(plugin.setup, SkillRegistryPlugin)
    assert.equal("server" in plugin, false)
  } finally {
    await cleanup?.()
  }
  pass("shouldGenerateOnceWhenV2SetupStarts")
}

async function shouldWaitForNativeProvidersWhenStartupIsIncomplete(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "readiness")
  let ready = false
  let requests = 0
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    return nativeResponse([skill("complete", "/complete/SKILL.md")])
  }, async () => ready ? inventory() : { data: [inventory().data[0]] }))

  try {
    // When
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
    assert.equal(requests, 0)
    assert.equal(await exists(registryFiles(worktree).registryFile), false)
    ready = true
    await waitFor(() => exists(registryFiles(worktree).registryFile), "complete native snapshot")

    // Then
    assert.equal(requests, 1)
    assert.match(await fs.readFile(registryFiles(worktree).registryFile, "utf8"), /complete/)
  } finally {
    await cleanup?.()
  }
  pass("shouldWaitForNativeProvidersWhenStartupIsIncomplete")
}

async function shouldRetryGenerationWhenNativeRequestFails(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "retry")
  const errors: string[] = []
  const originalError = console.error
  console.error = (message: unknown) => errors.push(String(message))
  let requests = 0
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    if (requests === 1) throw new Error("transient source failure")
    return nativeResponse([skill("recovered", "/recovered/SKILL.md")])
  }))

  try {
    // When
    await waitFor(() => errors.length === 1, "initial source failure")
    assert.equal(await exists(registryFiles(worktree).registryFile), false)
    await waitFor(() => exists(registryFiles(worktree).registryFile), "registry after retry")

    // Then
    assert.equal(requests, 2)
    assert.match(await fs.readFile(registryFiles(worktree).registryFile, "utf8"), /recovered/)
  } finally {
    await cleanup?.()
    console.error = originalError
  }
  pass("shouldRetryGenerationWhenNativeRequestFails")
}

async function shouldBoundRetriesWhenFailurePersists(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "retry-cap")
  const errors: string[] = []
  const originalError = console.error
  console.error = (message: unknown) => errors.push(String(message))
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => { throw new Error("persistent failure") }))

  try {
    // When
    await waitFor(() => errors.length === MAX_RETRIES + 1, "retry budget")
    await new Promise((resolve) => setTimeout(resolve, RETRY_COOLDOWN_MS + SETTLE_WAIT_MS))

    // Then
    assert.equal(errors.length, 4)
    assert.match(errors[3], /retry budget spent/)
    assert.equal(await exists(registryFiles(worktree).registryFile), false)
  } finally {
    await cleanup?.()
    console.error = originalError
  }
  pass("shouldBoundRetriesWhenFailurePersists")
}

async function shouldCancelWorkWhenCleanupRuns(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "cleanup")
  let resolve!: (value: unknown) => void
  let signal: AbortSignal | undefined
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async (_, options) => {
    signal = options?.signal
    return new Promise((done) => { resolve = done })
  }))
  await waitFor(() => signal !== undefined, "pending native request")

  // When
  await cleanup?.()
  await cleanup?.()
  resolve(nativeResponse([skill("late", "/late/SKILL.md")]))
  await new Promise((done) => setTimeout(done, SETTLE_WAIT_MS))

  // Then
  assert.equal(signal?.aborted, true)
  assert.equal(await exists(registryFiles(worktree).registryFile), false)
  pass("shouldCancelWorkWhenCleanupRuns")
}

async function shouldRetryWhenNativeRequestTimesOut(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "timeout")
  let requests = 0
  let signal: AbortSignal | undefined
  let resolve!: (value: unknown) => void
  const errors: string[] = []
  const originalError = console.error
  console.error = (message: unknown) => errors.push(String(message))
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async (_, options) => {
    requests += 1
    if (requests > 1) return nativeResponse([skill("recovered", "/recovered/SKILL.md")])
    signal = options?.signal
    return new Promise((done) => { resolve = done })
  }))

  try {
    // When
    await waitFor(() => errors.length > 0, "attempt timeout")
    await waitFor(() => exists(registryFiles(worktree).registryFile), "timeout recovery")
    resolve(nativeResponse([skill("late", "/late/SKILL.md")]))
    await new Promise((done) => setTimeout(done, SETTLE_WAIT_MS))

    // Then
    assert.equal(requests, 2)
    assert.equal(signal?.aborted, true)
    assert.match(errors[0], /timed out/)
    assert.doesNotMatch(await fs.readFile(registryFiles(worktree).registryFile, "utf8"), /late/)
  } finally {
    await cleanup?.()
    console.error = originalError
  }
  pass("shouldRetryWhenNativeRequestTimesOut")
}

async function shouldCancelConventionReadWhenSnapshotIsAborted(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "convention-cancellation")
  await fs.mkdir(worktree, { recursive: true })
  const convention = path.join(worktree, "AGENTS.md")
  await fs.writeFile(convention, "fixture", "utf8")
  const controller = new AbortController()
  const originalRead = fs.readFile
  let entered = false
  let receivedSignal: AbortSignal | undefined
  let release!: () => void
  fs.readFile = ((file, options) => {
    if (file !== convention) return originalRead(file, options)
    entered = true
    receivedSignal = typeof options === "object" && options !== null ? options.signal : undefined
    return new Promise((resolve, reject) => {
      release = () => resolve("")
      receivedSignal?.addEventListener("abort", () => reject(receivedSignal?.reason), { once: true })
    })
  }) as typeof fs.readFile
  const pending = collectConventionEntries(worktree, controller.signal)
  const settled = pending.then(() => "resolved", () => "rejected")

  try {
    // When
    await waitFor(() => entered, "convention read")
    controller.abort(new Error("cancelled convention scan"))

    // Then
    assert.equal(receivedSignal, controller.signal)
    assert.equal(await settled, "rejected")
  } finally {
    release?.()
    await settled
    fs.readFile = originalRead
  }
  pass("shouldCancelConventionReadWhenSnapshotIsAborted")
}

async function shouldCancelRetriesWhenCleanupRunsDuringCooldown(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "cooldown-cleanup")
  const originalError = console.error
  let errors = 0
  let requests = 0
  console.error = () => { errors += 1 }
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    throw new Error("retryable failure")
  }))

  try {
    // When
    await waitFor(() => errors === 1, "cooldown")
    await cleanup?.()
    await new Promise((resolve) => setTimeout(resolve, RETRY_COOLDOWN_MS + SETTLE_WAIT_MS))

    // Then
    assert.equal(requests, 1)
    assert.equal(await exists(registryFiles(worktree).registryFile), false)
  } finally {
    await cleanup?.()
    console.error = originalError
  }
  pass("shouldCancelRetriesWhenCleanupRunsDuringCooldown")
}

async function shouldRejectSnapshotWhenNativeProviderFailed(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "failed-provider")
  const originalError = console.error
  const errors: string[] = []
  let requests = 0
  console.error = (message: unknown) => errors.push(String(message))
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => {
    requests += 1
    return nativeResponse([])
  }, async () => ({ data: [
    { id: NATIVE_SKILL_PROVIDER_IDS[0], state: { status: "failed" } },
    inventory().data[1],
  ] })))

  try {
    // When
    await waitFor(() => errors.length === 1, "failed native provider")
    await cleanup?.()

    // Then
    assert.match(errors[0], /native skill provider failed/)
    assert.equal(requests, 0)
    assert.equal(await exists(registryFiles(worktree).registryFile), false)
  } finally {
    await cleanup?.()
    console.error = originalError
  }
  pass("shouldRejectSnapshotWhenNativeProviderFailed")
}

async function shouldAwaitPublicationWhenCleanupRunsAfterWritingStarts(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "publication-cleanup")
  const originalRename = fs.rename
  let release!: () => void
  let started = false
  let cleaned = false
  fs.rename = async (source, target) => {
    if (String(target) === registryFiles(worktree).registryFile) {
      started = true
      await new Promise<void>((resolve) => { release = resolve })
    }
    await originalRename(source, target)
  }
  const cleanup = await SkillRegistryPlugin(pluginInput(worktree, async () => nativeResponse([])))

  try {
    // When
    await waitFor(() => started, "publication")
    const stopped = Promise.resolve(cleanup?.()).then(() => { cleaned = true })
    await new Promise((resolve) => setTimeout(resolve, SETTLE_WAIT_MS))
    assert.equal(cleaned, false)
    release()
    await stopped

    // Then
    const files = registryFiles(worktree)
    const markdown = await fs.readFile(files.registryFile, "utf8")
    assert.equal((await fs.readFile(files.hashFile, "utf8")).trim(), registryHash(markdown))
    assert.equal(cleaned, true)
  } finally {
    release?.()
    await cleanup?.()
    fs.rename = originalRename
  }
  pass("shouldAwaitPublicationWhenCleanupRunsAfterWritingStarts")
}

async function shouldUseOpenedDirectoryWhenProjectIsNotGit(): Promise<void> {
  // Given
  const worktree = path.join(testRoot, "non-git/nested")
  const context = pluginInput(worktree, async () => nativeResponse([]))
  Object.assign(context.location.project, { directory: path.parse(worktree).root })
  const cleanup = await SkillRegistryPlugin(context)

  try {
    // When
    await waitFor(() => exists(registryFiles(worktree).registryFile), "non-git registry")

    // Then
    assert.equal(await exists(registryFiles(path.dirname(worktree)).registryFile), false)
  } finally {
    await cleanup?.()
  }
  pass("shouldUseOpenedDirectoryWhenProjectIsNotGit")
}

await shouldProjectNativeV2MetadataWhenListingSkills()
await shouldKeepEqualNamesWhenNativeIDsDiffer()
await shouldRejectMalformedOrUnavailableOpenCodeResponses()
await shouldRenderAllSkillsInOpenCodeAgentsClaudeOrder()
await shouldLabelConventionsAsCompatibilityInventory()
await shouldSkipOnlyWhenHashAndRegistryContentMatch()
await shouldRepairAfterHashRenameFails()
await shouldGenerateOnceWhenV2SetupStarts()
await shouldWaitForNativeProvidersWhenStartupIsIncomplete()
await shouldRetryGenerationWhenNativeRequestFails()
await shouldBoundRetriesWhenFailurePersists()
await shouldCancelWorkWhenCleanupRuns()
await shouldRetryWhenNativeRequestTimesOut()
await shouldCancelConventionReadWhenSnapshotIsAborted()
await shouldCancelRetriesWhenCleanupRunsDuringCooldown()
await shouldRejectSnapshotWhenNativeProviderFailed()
await shouldAwaitPublicationWhenCleanupRunsAfterWritingStarts()
await shouldUseOpenedDirectoryWhenProjectIsNotGit()

console.log(`PASS: ${passed} skill-registry plugin contract group(s)`)
