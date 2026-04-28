// Phase 14 — graph-ready entity surfaces.
// Shared visual grammar for anything that could become a graph node in a
// future phase. Consumers should reach for these primitives before writing
// a new ad-hoc chip or row.
export { EntityChip } from "./EntityChip";
export type { EntityChipKind, EntityChipTone } from "./EntityChip";
export { DependencyRow } from "./DependencyRow";
