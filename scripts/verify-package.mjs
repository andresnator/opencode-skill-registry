import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const bundleUrl = new URL("dist/server.js", root)
const bundle = await readFile(bundleUrl, "utf8")

assert.equal(packageJson.name, "opencode-skill-registry")
assert.equal(packageJson.dependencies, undefined, "published package must not have runtime dependencies")
assert.equal(packageJson.exports?.["."]?.import, "./dist/server.js")
assert.equal(packageJson.exports?.["./server"]?.import, "./dist/server.js")
assert.equal(packageJson.engines?.node, ">=22.0.0")
assert.equal(packageJson.engines?.opencode, ">=2.0.28 <3")
assert.ok(!bundle.includes("agents-orchestrator"), "bundle still contains source-harness coupling")

const bareImports = [...bundle.matchAll(/\b(?:from\s+|import\s*\()(["'])([^"']+)\1/g)].map((match) => match[2])
assert.deepEqual(
  bareImports.filter((specifier) => !specifier.startsWith("node:")),
  [],
  "bundle contains a non-Node runtime import",
)

const plugin = await import(pathToFileURL(bundleUrl.pathname).href)
assert.equal(plugin.default?.id, "andresnator.skill-registry")
assert.equal(typeof plugin.default?.setup, "function")
assert.equal("server" in plugin.default, false, "V1 lifecycle leaked into the V2 entrypoint")
assert.equal(plugin.SKILL_REGISTRY_PLUGIN_ID, "andresnator.skill-registry")
assert.equal(typeof plugin.SkillRegistryPlugin, "function")
assert.equal("skillRegistryContracts" in plugin, false, "test-only contracts leaked into the published API")
assert.equal("tui" in plugin.default, false, "server entry must not also export a TUI plugin")

const packed = spawnSync("pnpm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
})
assert.equal(packed.status, 0, packed.stderr || packed.stdout)
const report = JSON.parse(packed.stdout)
const files = new Set(report.files.map((entry) => entry.path))
for (const required of ["dist/server.js", "dist/server.d.ts", "README.md", "LICENSE", "NOTICE.md"]) {
  assert.ok(files.has(required), `package is missing ${required}`)
}
for (const forbidden of ["src/server.ts", "tests/contracts.ts", ".github/workflows/ci.yml"]) {
  assert.ok(!files.has(forbidden), `package unexpectedly contains ${forbidden}`)
}

const isolatedRoot = await mkdtemp(path.join(tmpdir(), "skill-registry-package-"))
try {
  const installed = path.join(isolatedRoot, "node_modules", packageJson.name)
  await mkdir(installed, { recursive: true })
  const packedArtifact = spawnSync("pnpm", ["pack", "--pack-destination", isolatedRoot], { cwd: root, encoding: "utf8" })
  assert.equal(packedArtifact.status, 0, packedArtifact.stderr || packedArtifact.stdout)
  const unpacked = spawnSync("tar", ["-xzf", path.join(isolatedRoot, `${packageJson.name}-${packageJson.version}.tgz`), "--strip-components=1", "-C", installed], { encoding: "utf8" })
  assert.equal(unpacked.status, 0, unpacked.stderr || unpacked.stdout)
  const imported = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import assert from "node:assert/strict"
    for (const entry of ["opencode-skill-registry", "opencode-skill-registry/server"]) {
      const module = await import(entry)
      assert.equal(module.default.id, "andresnator.skill-registry")
      assert.equal(module.default.setup, module.SkillRegistryPlugin)
      assert.equal(typeof module.default.setup, "function")
      assert.equal("server" in module.default, false)
    }
  `], { cwd: isolatedRoot, encoding: "utf8" })
  assert.equal(imported.status, 0, imported.stderr || imported.stdout)
  const declarations = await readFile(path.join(installed, "dist/server.d.ts"), "utf8")
  assert.doesNotMatch(declarations, /from ["']\.\//, "declarations reference an unpublished internal module")
} finally {
  await rm(isolatedRoot, { recursive: true, force: true })
}
process.stdout.write(`PASS: package contains ${files.size} files; both packed V2 exports load with no runtime dependencies.\n`)
