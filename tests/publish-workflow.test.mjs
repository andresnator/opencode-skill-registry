import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

const ROOT = new URL("../", import.meta.url)
const PUBLISH_WORKFLOW = new URL("../.github/workflows/publish.yml", import.meta.url)
const RELEASE_TAG_VERIFIER = new URL("../scripts/verify-release-tag.mjs", import.meta.url)
const workflow = await readFile(PUBLISH_WORKFLOW, "utf8")
const packageJson = JSON.parse(await readFile(new URL("package.json", ROOT), "utf8"))

function shouldRunOnlyForPublishedStableReleasesWhenTriggered() {
  assert.equal(workflow.match(/^on:\n([\s\S]*?)\npermissions:/m)?.[1].trim(), "release:\n    types: [published]")
  assert.ok(workflow.includes("github.event.release.draft == false && github.event.release.prerelease == false"))
}

function shouldUsePinnedToolingAndTheReleaseTag() {
  const actions = [...workflow.matchAll(/^\s*uses:\s*([^\s#]+)/gm)].map((match) => match[1])
  assert.deepEqual(actions, [
    "actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
    "actions/setup-node@820762786026740c76f36085b0efc47a31fe5020",
    "pnpm/action-setup@0977fd99725f1db4007ccb2928dbb4e90d06cc86",
  ])
  for (const text of [
    "ref: ${{ github.event.release.tag_name }}", "persist-credentials: false", "node-version: 22.23.2",
    "version: 10.34.5", "npm install --global npm@12.0.2",
  ]) assert.ok(workflow.includes(text), `workflow is missing ${text}`)
}

function shouldAcceptOnlyThePackageVersionTag() {
  assert.equal(runVerifier(`v${packageJson.version}`).status, 0)
  assert.equal(runVerifier("v999.999.999").status, 1)
}

function shouldPublishThroughOidcAfterAllGates() {
  assert.equal(workflow.match(/^permissions:\n([\s\S]*?)\n\nconcurrency:/m)?.[1].trim(), "contents: read\n  id-token: write")
  for (const command of [
    "pnpm install --frozen-lockfile", "pnpm run check", "pnpm run security:check",
    "git diff --exit-code -- dist", "npm publish --ignore-scripts --access public",
  ]) assert.ok(workflow.includes(command), `workflow is missing ${command}`)
  assert.doesNotMatch(workflow, /NPM_TOKEN|NODE_AUTH_TOKEN|secrets\./)
}

function runVerifier(releaseTag) {
  return spawnSync(process.execPath, [fileURLToPath(RELEASE_TAG_VERIFIER)], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, RELEASE_TAG: releaseTag },
  })
}

shouldRunOnlyForPublishedStableReleasesWhenTriggered()
shouldUsePinnedToolingAndTheReleaseTag()
shouldAcceptOnlyThePackageVersionTag()
shouldPublishThroughOidcAfterAllGates()
process.stdout.write("PASS: 4 npm publish workflow contracts.\n")
