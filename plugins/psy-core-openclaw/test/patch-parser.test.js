import assert from "node:assert/strict";
import test from "node:test";

import { extractPatchTargets } from "../src/patch-parser.js";

test("extracts apply_patch file operations", () => {
  const patch = [
    "*** Begin Patch",
    "*** Add File: memory/2026-05-01.md",
    "+hello",
    "*** Update File: skills/demo/SKILL.md",
    "@@",
    "-old",
    "+new",
    "*** Delete File: skills/old/SKILL.md",
    "*** End Patch",
  ].join("\n");

  assert.deepEqual(extractPatchTargets(patch), [
    { operation: "create", path: "memory/2026-05-01.md" },
    { operation: "str_replace", path: "skills/demo/SKILL.md" },
    { operation: "delete", path: "skills/old/SKILL.md" },
  ]);
});

test("treats update hunks with Move to as delete plus create", () => {
  const patch = [
    "*** Begin Patch",
    "*** Update File: skills/old/SKILL.md",
    "*** Move to: skills/new/SKILL.md",
    "@@",
    "-old",
    "+new",
    "*** End Patch",
  ].join("\n");

  assert.deepEqual(extractPatchTargets(patch), [
    { operation: "delete", path: "skills/old/SKILL.md" },
    { operation: "create", path: "skills/new/SKILL.md" },
  ]);
});
