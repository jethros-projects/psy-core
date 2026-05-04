import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";

import { classifyTargetPath } from "../src/paths.js";

test("classifies workspace memory files", () => {
  const env = { HOME: "/home/alice" };
  const workspaceDir = "/home/alice/.openclaw/workspace";

  assert.deepEqual(classifyTargetPath("MEMORY.md", { workspaceDir, env })?.memoryPath, "/memories/MEMORY.md");
  assert.deepEqual(classifyTargetPath("USER.md", { workspaceDir, env })?.memoryPath, "/memories/USER.md");
  assert.deepEqual(
    classifyTargetPath("memory/2026-05-01.md", { workspaceDir, env })?.memoryPath,
    "/memories/memory/2026-05-01.md",
  );
  assert.deepEqual(
    classifyTargetPath("memory/dreaming/rem/2026-05-01.md", { workspaceDir, env })?.memoryPath,
    "/memories/memory/dreaming/rem/2026-05-01.md",
  );
  assert.deepEqual(
    classifyTargetPath("memory/multimodal/diagram.png", { workspaceDir, env })?.memoryPath,
    "/memories/memory/multimodal/diagram.png",
  );
  assert.equal(classifyTargetPath("memory.md", { workspaceDir, env }), null);
  assert.equal(classifyTargetPath("notes/random.md", { workspaceDir, env }), null);
});

test("classifies workspace and shared skill roots", () => {
  const env = { HOME: "/home/alice" };
  const workspaceDir = "/home/alice/.openclaw/workspace";

  assert.equal(
    classifyTargetPath("skills/deploy/SKILL.md", { workspaceDir, env })?.memoryPath,
    "/skills/deploy/SKILL.md",
  );
  assert.equal(
    classifyTargetPath(".agents/skills/review/SKILL.md", { workspaceDir, env })?.memoryPath,
    "/.agents/skills/review/SKILL.md",
  );
  assert.equal(
    classifyTargetPath(path.join(env.HOME, ".openclaw", "skills", "global", "SKILL.md"), {
      workspaceDir,
      env,
    })?.memoryPath,
    "/managed-skills/global/SKILL.md",
  );
  assert.equal(
    classifyTargetPath(path.join(env.HOME, ".agents", "skills", "personal", "SKILL.md"), {
      workspaceDir,
      env,
    })?.memoryPath,
    "/agent-skills/personal/SKILL.md",
  );
  assert.equal(
    classifyTargetPath("/opt/openclaw-extra/reporting/SKILL.md", {
      workspaceDir,
      env,
      appConfig: { skills: { load: { extraDirs: ["/opt/openclaw-extra"] } } },
    })?.memoryPath,
    "/extra-skills/reporting/SKILL.md",
  );
});
