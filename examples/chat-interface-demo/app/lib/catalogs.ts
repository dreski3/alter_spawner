import type { AlterCatalog } from "./types";

export const ALTER_CATALOGS: AlterCatalog[] = [
  {
    id: "general",
    name: "General",
    description: "Balanced reasoning and execution",
    model: "default/runtime",
    glyph: "G",
    tone: "mint",
  },
  {
    id: "research",
    name: "Research mesh",
    description: "Branched search with a synthesis pass",
    model: "catalog/research",
    glyph: "R",
    tone: "blue",
  },
  {
    id: "code-review",
    name: "Code review",
    description: "Isolated reviewer and risk checker",
    model: "catalog/reviewer",
    glyph: "C",
    tone: "violet",
  },
  {
    id: "adaptive",
    name: "Adaptive relay",
    description: "May define a specialist during the run",
    model: "catalog/adaptive-router",
    glyph: "A",
    tone: "amber",
  },
];

export const getCatalog = (id: string) => ALTER_CATALOGS.find((catalog) => catalog.id === id) || ALTER_CATALOGS[0];
