import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = new URL("../", import.meta.url);
const dir = fileURLToPath(root);
const code = fs.existsSync(path.join(dir, "plugins/AML")) ? "AML" : "GPL";
const build = path.join(dir, "build/native");
fs.mkdirSync(build, { recursive: true });
const javaHome = process.env.JAVA_HOME || "C:/Program Files/Android/Android Studio/jbr";
const sdk = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA || "", "Android/Sdk");
function run(exe, args) {
  const result = spawnSync(exe, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error("Native compilation failed");
}
// Compile-only declarations of the public host ABI. These are never packaged.
const stubs = {
  "kotlin/Unit.java": "package kotlin; public final class Unit { public static final Unit INSTANCE = new Unit(); }",
  "kotlin/jvm/functions/Function1.java": "package kotlin.jvm.functions; public interface Function1<P,R> { R invoke(P value); }",
  "app/valenced/plugins/PluginBuilder.java": "package app.valenced.plugins; public class PluginBuilder { public void start(kotlin.jvm.functions.Function1<PluginScope,kotlin.Unit> f) {} public void stop(kotlin.jvm.functions.Function1<PluginScope,kotlin.Unit> f) {} }",
  "app/valenced/plugins/PluginScope.java": "package app.valenced.plugins; public interface PluginScope { ClassLoader getClassLoader(); app.valenced.bridge.ValencedBridge getBridge(); }",
  "app/valenced/bridge/ValencedBridge.java": "package app.valenced.bridge; public interface ValencedBridge { void registerMethod(String name,kotlin.jvm.functions.Function1 handler); }",
};
const sources = [];
for (const [name, content] of Object.entries(stubs)) {
  const file = path.join(build, "stubs", name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  sources.push(file);
}
const xposed = path.join(build, "xposed-api.jar");
if (!fs.existsSync(xposed)) {
  const response = await fetch("https://api.xposed.info/de/robv/android/xposed/api/82/api-82.jar");
  if (!response.ok) throw new Error("Xposed API download failed " + response.status);
  fs.writeFileSync(xposed, Buffer.from(await response.arrayBuffer()));
}
const platforms = fs.readdirSync(path.join(sdk, "platforms")).sort().reverse();
const android = path.join(sdk, "platforms", platforms[0], "android.jar");
const javac = path.join(javaHome, "bin", process.platform === "win32" ? "javac.exe" : "javac");
const separator = path.delimiter;
run(javac, ["--release", "8", "-d", path.join(build, "abi"), ...sources]);
run(javac, ["--release", "8", "-classpath", [path.join(build, "abi"), android, xposed].join(separator),
  "-d", path.join(build, "classes"), path.join(dir, "plugins", code, "native/HistoryStyle.java")]);
const classes = fs.readdirSync(path.join(build, "classes/app/dariuss/logger")).filter(n => n.endsWith(".class"))
  .map(n => path.join(build, "classes/app/dariuss/logger", n));
const tools = fs.readdirSync(path.join(sdk, "build-tools")).sort().reverse()[0];
run(path.join(javaHome, "bin", process.platform === "win32" ? "java.exe" : "java"), [
  "-cp", path.join(sdk, "build-tools", tools, "lib/d8.jar"), "com.android.tools.r8.D8",
  "--min-api", "24", "--lib", android, "--classpath", path.join(build, "abi"), "--classpath", xposed,
  "--output", path.join(build, "plugin.jar"), ...classes,
]);
