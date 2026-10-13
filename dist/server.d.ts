import type { Plugin } from "@opencode/plugin";
export declare const SKILL_REGISTRY_PLUGIN_ID = "andresnator.skill-registry";
export declare const SkillRegistryPlugin: Plugin.Plugin["setup"];
declare const _default: {
    id: string;
    setup: (context: Plugin.Context) => Promise<Plugin.Cleanup | void> | Plugin.Cleanup | void;
};
export default _default;
