import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pluginRoot = path.resolve(__dirname, "..");

function readJson(relativePath) {
  return JSON.parse(fs.readFileSync(path.join(pluginRoot, relativePath), "utf8"));
}

function readText(relativePath) {
  return fs.readFileSync(path.join(pluginRoot, relativePath), "utf8");
}

test("package ships agent-facing install docs and bundled skill", () => {
  const pkg = readJson("package.json");
  const manifest = readJson("openclaw.plugin.json");

  assert.deepEqual(manifest.skills, ["./skills"]);
  assert.ok(pkg.files.includes("AGENT_INSTALL.md"));
  assert.ok(pkg.files.includes("skills"));
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.openclaw.install.defaultChoice, "npm");
  assert.equal(pkg.openclaw.install.localPath, "plugins/psy-core-openclaw");
  assert.equal(pkg.openclaw.install.minHostVersion, ">=2026.4.29");
  assert.equal(pkg.openclaw.compat.pluginApi, ">=2026.4.29");
  assert.equal(pkg.openclaw.release.publishToNpm, true);
  assert.equal(pkg.peerDependencies.openclaw, ">=2026.4.29");

  const skill = readText("skills/psy-core-openclaw/SKILL.md");
  assert.match(skill, /^---\nname: psy-core-openclaw\n/m);
  assert.match(skill, /metadata: \{"openclaw":\{"requires":\{"config":\["plugins\.entries\.psy-core\.enabled"\]\}\}\}/);

  const guide = readText("AGENT_INSTALL.md");
  assert.match(guide, /openclaw plugins install <absolute path to plugins\/psy-core-openclaw>/);
  assert.doesNotMatch(guide, /unless .*dangerously-force-unsafe-install/);
  assert.doesNotMatch(guide, /psyBinary "\$\(command -v psy\)"/);
  assert.match(guide, /PSY_AUDIT_DB_PATH="\$HOME\/\.psy\/audit\.db"/);
});

test("runtime source avoids OpenClaw dangerous-code scan patterns", () => {
  const source = readText("src/ingest-client.js");
  assert.doesNotMatch(source, /node:child_process|child_process/);
  assert.doesNotMatch(source, /\b(?:spawn|spawnSync|execFile|execFileSync)\s*\(/);
});
