import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import { ALLOWED_TYPES } from "../scripts/validate-pr-title.mjs"

const root = new URL("../", import.meta.url)
const packageJson = JSON.parse(await readFile(new URL("package.json", root), "utf8"))
const manifest = JSON.parse(await readFile(new URL(".release-please-manifest.json", root), "utf8"))
const releaseConfig = JSON.parse(await readFile(new URL("release-please-config.json", root), "utf8"))

function shouldKeepReleaseStateAlignedWhenAutomationIsConfigured() {
  const rootPackage = releaseConfig.packages["."]
  assert.equal(packageJson.version, manifest["."])
  assert.match(packageJson.version, /^\d+\.\d+\.\d+$/)
  assert.deepEqual(rootPackage, {
    "release-type": "node",
    "include-component-in-tag": false,
    "include-v-in-tag": true,
  })
}

function shouldApplyThePreMajorVersionPolicyWhenChangesReachMain() {
  const sections = releaseConfig["changelog-sections"]
  assert.equal(releaseConfig["bump-minor-pre-major"], true)
  assert.equal(releaseConfig["bump-patch-for-minor-pre-major"], true)
  assert.deepEqual(sections.map((section) => section.type).sort(), [...ALLOWED_TYPES].sort())
  assert.deepEqual(
    sections.filter((section) => section.hidden !== true).map((section) => section.type).sort(),
    ["deps", "feat", "fix"],
  )
}

shouldKeepReleaseStateAlignedWhenAutomationIsConfigured()
shouldApplyThePreMajorVersionPolicyWhenChangesReachMain()
process.stdout.write("PASS: 2 release policy contracts.\n")
