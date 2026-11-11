import { readFile, mkdir, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { basename, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { zipSync } from "fflate";

const root = fileURLToPath(new URL("..", import.meta.url));
process.chdir(root);
const config = JSON.parse(await readFile("repo.config.json", "utf8"));
const pluginId = Object.keys(config.channels)[0];
const code = pluginId.includes("ghost-ping") ? "GPL" : "AML";
const source = "plugins/" + code;
const manifest = await readFile(source + "/manifest.json");
const { id, version, dist } = JSON.parse(manifest);
const filename = id + "@" + version + ".zip";
const cli = resolve("node_modules/@valenced/plugin-cli/bin/valenced-plugin.js");
function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Valenced CLI failed: " + args[0]);
}
run("build", "--plugins-dir", "plugins");
const script = await readFile(source + "/build/js/" + basename(dist.script));
await mkdir("pool", { recursive: true });
await writeFile("pool/" + filename, zipSync({ "manifest.json": manifest, [dist.script]: script }, { level: 9 }));
const repository = code === "GPL" ? "Ghost-Ping-Logger" : "Adv.-Message-Logger";
run("generate-index", "--dist", "pool", "--base-url",
  "https://raw.githubusercontent.com/dariussbezy/" + repository + "/refs/heads/main/pool",
  "--out", "index.json");
