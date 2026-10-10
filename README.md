# Ghost Ping Logger

A Kettu plugin that detects deleted messages that pinged you, keeps them available for jump navigation, and works on its own or alongside Advanced Message Logger.

## Features

- **Ghost ping detection** for deleted messages that mention you or reply to your messages. Each type can be enabled separately.
- **Ghost ping alerts** show a prompt with the message and options to jump to it or dismiss the alert.
- **Retained ghost pings** remain visible in chat with red message text and, optionally, a red username.
- **Ghost ping history** is saved locally, with a configurable retention period of 7 days, 30 days, or forever. Up to 200 entries are kept.
- **Capture modes** offer Loaded Only or All Channels. All Channels keeps a bounded cache of messages Discord delivers while Kettu runs; it does not fetch channel history.
- **Maximum cached messages** is configurable; the default is 200 in All Channels mode.
- **Ignore bots** is enabled by default. Alerts and red usernames can also be toggled in settings.
- Includes a test alert to preview the ghost ping notification.
- Works independently or alongside Advanced Message Logger, with coordination to avoid duplicate retention and alerts.

## Installation

In Kettu, go to **Settings → Plugins**, tap **+**, and paste:

```text
https://raw.githubusercontent.com/dariussbezy/Ghost-Ping-Logger/main/GPL/
```

Enable the plugin, then open its settings to choose what to track and display.

## Compatibility

The existing project notes report testing on iOS 27 with Kettu 1.4.3 and Discord 305.1. Android and other client versions may behave differently.
Please report bugs, crashes, and suggestions in the project's feedback channel.

## Recommended for use with the Advanced Message Logger plugin.
https://github.com/dariussbezy/Advanced-Message-Logger/

## Screenshots:

<img width="1179" height="547" alt="image" src="https://github.com/user-attachments/assets/71bdae99-d46d-4e02-ad0a-13915952a86e" />
<img width="919" height="786" alt="image" src="https://github.com/user-attachments/assets/430528e9-04c8-473a-b11d-137ad7f586a3" />
<img width="1179" height="2404" alt="image" src="https://github.com/user-attachments/assets/2c82e2bf-41bc-4658-bcc9-d95c9b13667e" />
<img width="1179" height="2416" alt="image" src="https://github.com/user-attachments/assets/4efbfc25-a64f-4ec3-978e-5f578a5cc9b3" />
<img width="1179" height="1260" alt="image" src="https://github.com/user-attachments/assets/da9f17af-6f7e-41cf-9f6a-edb4788a50e7" />
<img width="1179" height="360" alt="image" src="https://github.com/user-attachments/assets/30474382-1a50-47ed-933e-2e1cd96fbb78" />
