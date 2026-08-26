import assert from "node:assert/strict"
import { validatePullRequestTitle } from "../scripts/validate-pr-title.mjs"

function shouldAcceptSupportedConventionalTitlesWhenSyntaxIsValid() {
  const titles = [
    "fix: preserve project skill precedence",
    "feat(registry): add a discovery root",
    "feat!: remove legacy output",
    "chore(main): release opencode-skill-registry 0.1.1",
    "deps: update development dependencies",
  ]
  assert.ok(titles.map(validatePullRequestTitle).every((result) => result.valid))
}

function shouldRejectUnsupportedOrMalformedTitlesWhenSyntaxIsInvalid() {
  const titles = ["Improve registry", "Fix: upper-case type", "fix missing colon", "fix: ", "security: add gate"]
  assert.ok(titles.map(validatePullRequestTitle).every((result) => !result.valid))
}

shouldAcceptSupportedConventionalTitlesWhenSyntaxIsValid()
shouldRejectUnsupportedOrMalformedTitlesWhenSyntaxIsInvalid()
process.stdout.write("PASS: 2 pull request title contracts.\n")
