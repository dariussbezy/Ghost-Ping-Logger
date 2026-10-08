# Ghost Ping Logger

A Kettu plugin that detects deleted messages that pinged you, keeps them available for jump navigation, and can track edited-message history.

## Features

- **Ghost ping detection** for deleted messages in DMs, replies to your messages, and messages that mention you. Each type can be enabled or disabled separately.
- **Ghost ping alerts** can show a modal with the message and options to jump to it or dismiss the alert.
- **Retained ghost pings** remain visible in chat with red message text and, optionally, a red username so you can still use Jump to message after deletion.
- **Ghost ping history** is saved locally, with a configurable retention period of 7 days, 30 days, or forever. Up to 200 entries are kept.
- **Edited-message tracking** keeps previous versions for the current session and displays them above the edited message in gray. Up to 200 messages and five previous versions per message are kept.
- **Edit history** is available in plugin settings and includes a Jump to message action.
- **Edit notifications** can be enabled separately and show a toast for edited messages in DMs only.
- **Capture modes** offer Loaded Only or Expanded Cache. Expanded Cache retains a bounded number of incoming messages from channels you have not opened; it does not fetch channel history.
- **Maximum cached messages** is configurable. The default is 200 messages in Expanded Cache.
- **Ignore bots** is enabled by default. Red usernames on ghost pings and ghost ping alerts can also be toggled in settings.
- Includes a test alert to preview the ghost ping notification.
- Works on its own or alongside Advanced Message Logger. When both are active, the plugins coordinate message retention and DM notifications to avoid duplicate handling and alerts.

## Installation
In Kettu, go to **Settings → Plugins**, tap **+**, and paste:

```text
https://raw.githubusercontent.com/dariussbezy/Ghost-Ping-Logger/main/GPL/
```

## Compatibility

Built for Kettu. Behavior may vary across operating systems and Kettu or Discord versions. 
Please report any discrepancies, bugs, crashes, or suggestions in the project's feedback channel.

## Recommended for use with the Advanced Message Logger plugin.
https://github.com/dariussbezy/Advanced-Message-Logger/
