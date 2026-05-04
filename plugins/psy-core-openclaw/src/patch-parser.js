export function extractPatchTargets(input) {
  if (typeof input !== "string" || !input.trim()) return [];
  const targets = [];
  const lines = input.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const add = /^\*\*\* Add File: (.+)$/.exec(line);
    if (add) {
      targets.push({ operation: "create", path: add[1].trim() });
      continue;
    }
    const del = /^\*\*\* Delete File: (.+)$/.exec(line);
    if (del) {
      targets.push({ operation: "delete", path: del[1].trim() });
      continue;
    }
    const update = /^\*\*\* Update File: (.+)$/.exec(line);
    if (update) {
      const sourcePath = update[1].trim();
      const next = lines[i + 1] || "";
      const move = /^\*\*\* Move to: (.+)$/.exec(next);
      if (move) {
        targets.push({ operation: "delete", path: sourcePath });
        targets.push({ operation: "create", path: move[1].trim() });
      } else {
        targets.push({ operation: "str_replace", path: sourcePath });
      }
    }
  }
  return targets;
}
