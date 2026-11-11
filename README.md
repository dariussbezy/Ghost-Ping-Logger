# Ghost Ping Logger

A Valenced beta that detects mentions or replies that are later deleted or edited to remove the ping.

## Install

Add the following URL in **Valenced → Plugins → Advanced**, then install **Ghost Ping Logger** from **beta**.

```text
https://raw.githubusercontent.com/dariussbezy/Ghost-Ping-Logger/main/index.json
```

Version **1.0.8-beta** requires Valenced Plugin API **1**.

## What this beta includes

- Detection for direct, role and everyone/here mentions and replies, with a setting for each type.
- Native alerts with jump and dismiss actions, a test alert, and a searchable journal with saved filters and individual entry removal.
- Optional in-chat retention of deleted ghost pings and red usernames. All or Loaded-only capture, a configurable recent cache, and separate save and clear controls for the journal and recent cache.
- Optional cooperation with [Adv. Message Logger](https://github.com/dariussbezy/Adv.-Message-Logger). Ghost Ping Logger works on its own and can use AML's recent snapshots when both are active.

Detection uses message and mention data received by this Discord client. Retaining a deleted row requires the original message in Discord's cache. Logs stay on this device.
## Development

Run `bun install --frozen-lockfile` and then `npm run publish:local` to build the ZIP and regenerate the index. Run `npm run lint:types` and `npm test` to check the build.
