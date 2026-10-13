import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"

const workflow = await readFile(new URL("../.github/workflows/ci.yml", import.meta.url), "utf8")
const workspace = await readFile(new URL("../pnpm-workspace.yaml", import.meta.url), "utf8")
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"))
const nodeVersion = (await readFile(new URL("../.node-version", import.meta.url), "utf8")).trim()
const OPENCODE_PACKAGES = [
  "ai", "cli", "client", "plugin", "protocol", "schema", "util",
  "cli-darwin-arm64", "cli-darwin-x64-baseline", "cli-darwin-x64",
  "cli-linux-arm64-musl", "cli-linux-arm64", "cli-linux-x64-baseline-musl", "cli-linux-x64-baseline",
  "cli-linux-x64-musl", "cli-linux-x64", "cli-windows-arm64", "cli-windows-x64-baseline", "cli-windows-x64",
]

function shouldTestCleanCacheInstallationAcrossSupportedOpenCodeVersions() {
  // Given
  const versions = ["2.0.28", '"2"']

  // When / Then
  for (const version of versions) assert.ok(workflow.includes(`version: ${version}`), `CI is missing OpenCode ${version}`)
  for (const contract of [
    'npm install --prefix "$OPENCODE_INSTALL_ROOT" --no-audit --no-fund "@opencode/cli@$OPENCODE_VERSION"',
    "OPENCODE_BIN: ${{ runner.temp }}/opencode-${{ matrix.id }}/node_modules/.bin/opencode",
    "pnpm run test:install",
  ]) assert.ok(workflow.includes(contract), `CI is missing compatibility contract: ${contract}`)
  assert.doesNotMatch(workflow, /latest-v1|opencode-ai@|version: 1\.17\.15|version: 1\.18\.20/)
}

function shouldKeepStrictSecurityPoliciesWhenV2ExceptionsAreApplied() {
  // Given
  const exclusions = workspace.match(/minimumReleaseAgeExclude:\n([\s\S]*?)\ntrustPolicy:/)?.[1]
    .split("\n").map((line) => line.trim().replace(/^- ['"]?|['"]$/g, "")).sort()

  // When / Then
  assert.deepEqual(exclusions, OPENCODE_PACKAGES.map((name) => `@opencode/${name}@2.0.28`).sort())
  for (const policy of [
    "minimumReleaseAge: 1440", "trustPolicy: no-downgrade", "blockExoticSubdeps: true",
    "strictDepBuilds: true", "pmOnFail: error", "verifyDepsBeforeRun: error", "engineStrict: true",
  ]) assert.ok(workspace.includes(policy), `workspace is missing security policy: ${policy}`)
  assert.doesNotMatch(workspace, /trustPolicyExclude|effect@4\.0\.0-beta|opencode-ai@/)
  assert.equal(nodeVersion, "24.20.0")
  assert.equal(packageJson.packageManager, "pnpm@12.11.2")
  assert.equal(packageJson.engines.opencode, ">=2.0.28 <3")
  assert.ok(workspace.includes(`nodeVersion: ${nodeVersion}`))
  assert.equal(workflow.match(/version: 12\.11\.2/g)?.length, 2)
  assert.ok(workflow.includes("node-version-file: .node-version"))
}

shouldTestCleanCacheInstallationAcrossSupportedOpenCodeVersions()
shouldKeepStrictSecurityPoliciesWhenV2ExceptionsAreApplied()
process.stdout.write("PASS: V2 compatibility matrix and strict toolchain/security contracts.\n")
