import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import test from "node:test";
import { unzipSync } from "fflate";

test("the standalone beta catalog matches the compiled plugin and manifest", () => {
  const root = new URL("../", import.meta.url);
  const read = path => fs.readFileSync(new URL(path, root));
  const config = JSON.parse(read("repo.config.json"));
  const id = Object.keys(config.channels)[0];
  const dir = id.includes("ghost-ping") ? "plugins/GPL" : "plugins/AML";
  const manifest = JSON.parse(read(dir + "/manifest.json"));
  const item = JSON.parse(read("index.json")).plugins[id];
  assert.equal(item.channels.beta, "1.0.1-beta");
  assert.deepEqual(Object.keys(manifest.dependencies).sort(), ["discord", "valenced.api"]);
  const filename = id + "@" + manifest.version + ".zip";
  const archive = read("pool/" + filename);
  const entry = item.versions[manifest.version];
  assert.match(entry.url, /^https:\/\/raw\.githubusercontent\.com\/dariussbezy\/Ghost-Ping-Logger\/[0-9a-f]{40}\/pool\//,
    "same-version GPL replacements must reference an immutable archive");
  assert.equal(entry.size, archive.length);
  assert.equal(entry.sha256, createHash("sha256").update(archive).digest("hex"));
  const files = unzipSync(archive);
  assert.deepEqual(JSON.parse(Buffer.from(files["manifest.json"])), manifest);
  assert.deepEqual(Buffer.from(files[manifest.dist.script]), read(dir + "/build/js/index.js"));
});
