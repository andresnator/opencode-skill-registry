import type { ConventionEntry, OpenCodeSkill } from "./source.js"

export type SkillSource = "opencode" | "agents" | "claude"

const SOURCE_SECTIONS: ReadonlyArray<{ source: SkillSource; heading: string }> = [
  { source: "opencode", heading: "OpenCode Skills" },
  { source: "agents", heading: "Agent Skills" },
  { source: "claude", heading: "Claude Skills" },
]

const AGENTS_SKILL_PATH = /(?:^|\/)\.agents\/skills(?:\/|$)/
const CLAUDE_SKILL_PATH = /(?:^|\/)\.claude\/skills(?:\/|$)/

export function classifySkillSource(location: string): SkillSource {
  const normalized = location.replaceAll("\\", "/")
  if (AGENTS_SKILL_PATH.test(normalized)) return "agents"
  if (CLAUDE_SKILL_PATH.test(normalized)) return "claude"
  return "opencode"
}

function tableCell(value: string) {
  return value.replace(/\|/g, "\\|").replace(/\r?\n/g, " ").trim()
}

function compareNames(left: OpenCodeSkill, right: OpenCodeSkill) {
  if (left.name < right.name) return -1
  if (left.name > right.name) return 1
  return 0
}

function renderSkillSection(heading: string, skills: OpenCodeSkill[]) {
  const rows = skills
    .sort(compareNames)
    .map((skill) => `| ${tableCell(skill.description ?? "-")} | ${tableCell(skill.name)} | ${tableCell(skill.location)} |`)
    .join("\n")

  return `## ${heading}

| Description | Skill | Location |
|---|---|---|
${rows || "| - | - | - |"}`
}

export function renderRegistry(skills: OpenCodeSkill[], conventions: ConventionEntry[]) {
  const skillSections = SOURCE_SECTIONS.map(({ source, heading }) =>
    renderSkillSection(heading, skills.filter((skill) => classifySkillSource(skill.location) === source)),
  ).join("\n\n")
  const conventionRows = conventions
    .map((entry) => `| ${tableCell(entry.file)} | ${tableCell(entry.path)} | ${tableCell(entry.notes)} |`)
    .join("\n")

  return `# Skill Registry

Auto-generated — do not edit. Discovery index of the skills active in this OpenCode session. Match a description, then load the skill with OpenCode's \`skill\` tool; filesystem locations can also be read directly.

${skillSections}

## Detected Convention Files

Compatibility inventory only. These files are not presented as the active instruction set resolved by OpenCode.

| File | Path | Notes |
|---|---|---|
${conventionRows || "| - | - | - |"}
`
}
