# Ghost Ping Logger

A Valenced beta that detects mentions or replies that are later deleted or edited to remove the ping.

## Install

Add the following URL in **Valenced → Plugins → Advanced**, then install **Ghost Ping Logger** from **beta**.

```text
https://raw.githubusercontent.com/dariussbezy/Ghost-Ping-Logger/main/index.json
```

Version **1.0.0-beta** targets Discord **352.6** and Valenced Plugin API **1**.

## What this beta includes

- Detection for direct, role and everyone/here mentions and replies. Settings let you choose which types to track.
- Native Discord notifications, a searchable local history and details with **Jump to message** or **Open channel**.
- Optional local persistence of recent ping candidates and history. History stays in memory by default. You can clear it in Settings.
- Optional cooperation with [Adv. Message Logger](https://github.com/dariussbezy/Adv.-Message-Logger). This plugin works by itself and can use AML's recent snapshots when both are active.

This beta shows ghost pings in the journal and notifications. It does not retain deleted rows or recolor usernames in chat. Detection depends on messages and mention data received by this client. Logs are kept locally. Native mobile rendering still needs device testing.

## Development

Run `bun install --frozen-lockfile` and then `npm run publish:local` to build the ZIP and regenerate the index. Run `npm run lint:types` and `npm test` to check the build.
