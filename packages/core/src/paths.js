import { fileURLToPath } from "node:url";
import path from "node:path";

export const ALTER_HOME_TEMPLATE_DIR = fileURLToPath(new URL("../templates/alter-home", import.meta.url));
export const TEMPLATE_AGENT = path.join(ALTER_HOME_TEMPLATE_DIR, ".opencode", "agents", "alter.md");
export const TEMPLATE_AGENTS_MD = path.join(ALTER_HOME_TEMPLATE_DIR, "AGENTS.md");
export const TEMPLATE_SKILL = path.join(ALTER_HOME_TEMPLATE_DIR, ".opencode", "skills", "alter", "SKILL.md");
export const TEMPLATE_SKILL_DIR = path.join(ALTER_HOME_TEMPLATE_DIR, ".opencode", "skills", "alter");
