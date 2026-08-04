import type { Plugin } from "@opencode-ai/plugin";
type SkillEntry = {
    name: string;
    version: string;
    status: string;
    description: string;
    path: string;
    mtimeMs: number;
    project: boolean;
};
export declare const SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry";
declare function scalar(frontmatter: string, key: string): string;
declare function triggerFrom(description: string): string;
declare function listSkillFiles(dir: string, seenDirs?: Set<string>): Promise<string[]>;
declare function discoverSkills(worktree: string): Promise<SkillEntry[]>;
type ConventionData = {
    rows: string;
    hashInput: string;
};
declare function collectConventions(worktree: string): Promise<ConventionData>;
declare function renderRegistry(skills: SkillEntry[], conventions: ConventionData): Promise<string>;
declare function ensureInfoExclude(worktree: string): Promise<void>;
declare function migrateLegacyAtl(worktree: string): Promise<void>;
declare function generateRegistry(worktree: string): Promise<void>;
declare function projectRoot(input: {
    worktree?: string;
    directory: string;
}): string;
export declare const skillRegistryContracts: {
    scalar: typeof scalar;
    triggerFrom: typeof triggerFrom;
    listSkillFiles: typeof listSkillFiles;
    discoverSkills: typeof discoverSkills;
    collectConventions: typeof collectConventions;
    renderRegistry: typeof renderRegistry;
    ensureInfoExclude: typeof ensureInfoExclude;
    migrateLegacyAtl: typeof migrateLegacyAtl;
    generateRegistry: typeof generateRegistry;
    projectRoot: typeof projectRoot;
};
export declare const SkillRegistryPlugin: Plugin;
declare const _default: {
    id: string;
    server: Plugin;
};
export default _default;
