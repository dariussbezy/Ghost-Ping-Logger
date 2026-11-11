import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";
import React from "react";
import { act, create } from "react-test-renderer";
import * as JSX from "react/jsx-runtime";
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("profile Ignore changes to Stop ignoring without reopening the profile", async () => {
  const listeners = new Set();
  let revision = 0, ignored = false, opened, lastScope;
  const Row = props => React.createElement("MenuRow", props);
  Row.Group = props => React.createElement("MenuGroup", props);
  Row.Icon = () => null;
  const sheets = {
    openLazy: async promise => { opened = (await promise).default; },
    hideActionSheet() {},
  };
  const profile = { default: () => React.createElement("ContextMenu", { items: [] }) };
  const module = { exports: {} };
  const imports = {
    react: React, "react/jsx-runtime": JSX,
    "@valenced/assets": { getAssetIdByName: () => 0 },
    "@valenced/discord/actions": { ActionSheetActionCreators: sheets },
    "@valenced/discord/design": { Design: { ContextMenu: "ContextMenu", ActionSheet: "ActionSheet", ActionSheetRow: Row } },
    "@valenced/modules/finders": { getModules: (name, callback) => {
      if (name === "UserProfileOverflowMenu") callback(profile);
      return () => {};
    } },
    "@valenced/modules/finders/filters": { withName: name => name },
    "@valenced/patcher": {
      before: (target, key, hook) => {
        const original = target[key];
        target[key] = (...args) => original(...(hook(args) ?? args));
        return () => { target[key] = original; };
      },
      instead: (target, key, hook) => {
        const original = target[key];
        target[key] = function (...args) { return hook.call(this, args, original); };
        return () => { target[key] = original; };
      },
    },
  };
  const source = fs.readFileSync(new URL("../plugins/GPL/js/menus.tsx", import.meta.url), "utf8");
  const code = ts.transpileModule(source, { compilerOptions: {
    module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, jsx: ts.JsxEmit.ReactJSX,
  } }).outputText;
  vm.runInNewContext(code, { module, exports: module.exports, require: id => imports[id] });
  const stop = module.exports.installMenus({
    subscribe: listener => { listeners.add(listener); return () => listeners.delete(listener); },
    version: () => revision, nameFor: () => "Alice", isIgnored: () => ignored,
    toggleIgnored: (_id, scope) => { lastScope = scope; ignored = !ignored; revision++; for (const listener of listeners) listener(); },
    entriesFor: () => [], inspect() {}, remove() {}, report: error => { throw error; },
  });
  let tree;
  await act(async () => { tree = create(React.createElement(profile.default, { userId: "u" })); });
  const item = () => tree.root.findByType("ContextMenu").props.items.at(-1);
  assert.equal(item().label, "Ignore Alice in logger");
  await act(async () => { item().action(); });
  assert.equal(item().label, "Stop ignoring Alice in logger");
  await act(async () => { item().action(); });
  assert.equal(item().label, "Ignore Alice in logger");
  await act(async () => { tree.unmount(); });
  for (const [key, props, scope] of [
    ["GuildActionSheet", {guildId:"g"}, "server"],
    ["ChannelLongPressActionSheet", {channel:{id:"d",type:1}}, "DM"],
  ]) {
    await sheets.openLazy(Promise.resolve({default:() => React.createElement("ActionSheet",null)}), key);
    await act(async () => { tree=create(React.createElement(opened,props)); });
    await act(async () => { tree.root.findByType("MenuRow").props.onPress(); });
    assert.equal(lastScope,scope);
    await act(async () => { tree.unmount(); });
  }
  stop();
});
