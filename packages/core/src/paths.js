import { fileURLToPath } from "node:url";
import path from "node:path";

export const ALTER_HOME_TEMPLATE_DIR = fileURLToPath(new URL("../templates/alter-home", import.meta.url));
export const TEMPLATE_AGENT = path.join(ALTER_HOME_TEMPLATE_DIR, ".opencode", "agents", "alter.md");
export const TEMPLATE_AGENTS_MD = path.join(ALTER_HOME_TEMPLATE_DIR, "AGENTS.md");
export const TEMPLATE_SKILL = path.join(ALTER_HOME_TEMPLATE_DIR, ".opencode", "skills", "alter", "SKILL.md");
export const TEMPLATE_SKILL_DIR = path.join(ALTER_HOME_TEMPLATE_DIR, ".opencode", "skills", "alter");

// The alter-home templates above are what a run home is built from. These are what an
// authored *project* is seeded with: a starting persona the author edits, and the shape
// of one skill. They are deliberately not the same files — a run home's AGENTS.md
// describes a generic Alter, while a project's is the one thing the author must replace.
export const ALTER_PROJECT_TEMPLATE_DIR = fileURLToPath(new URL("../templates/alter-project", import.meta.url));
export const TEMPLATE_PROJECT_AGENTS_MD = path.join(ALTER_PROJECT_TEMPLATE_DIR, "AGENTS.md");
export const TEMPLATE_PROJECT_SKILL = path.join(ALTER_PROJECT_TEMPLATE_DIR, "SKILL.md");
