(() => {
  "use strict";
  const { metro, patcher, plugin, ui } = vendetta;
  const vstorage = vendetta.storage;
  const { findByProps, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_PINGS = 200;
  const MAX_RECENT_MESSAGES = 1000;
  const MAX_SNIPPET = 300;
  const DEFAULT_NOTIFICATION_SECONDS = 15;
  const MIN_NOTIFICATION_SECONDS = 3;
  const MAX_NOTIFICATION_SECONDS = 120;
  const BUILD = "v1.5";
  const PAGE = 40;
  const DAY = 86400000;
  const RED = "#ED4245";
  const KINDS = { dm: "DM", reply: "Reply", mention: "Mention" };

  const unpatches = [];
  let pings = [];
  const recentMessages = new Map();
  let MessageStore;
  let UserStore;
  let ChannelStore;
  let SelectedChannelStore;
  let ThemeStore;
  let appStateSub = null;
  let lastSettingsNavigation = null;

  const cfg = () => plugin.storage;
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (_) {} };
  const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

  function fmtTime(ms) {
    const d = new Date(ms);
    const p = (n) => (n < 10 ? "0" : "") + n;
    const t = p(d.getHours()) + ":" + p(d.getMinutes());
    if (d.toDateString() === new Date().toDateString()) return t;
    return p(d.getDate()) + "/" + p(d.getMonth() + 1) + " " + t;
  }

  function nameOf(u) {
    if (!u) return "Unknown";
    return u.globalName || u.global_name || u.username || "Unknown";
  }

  function loadStores() {
    MessageStore = MessageStore || findByStoreName("MessageStore");
    UserStore = UserStore || findByStoreName("UserStore");
    ChannelStore = ChannelStore || findByStoreName("ChannelStore");
    return !!(MessageStore && UserStore && FluxDispatcher);
  }

  const getMessage = (c, id) => { try { return MessageStore.getMessage(c, id) || null; } catch (_) { return null; } };
  function rememberMessage(message) {
    if (!message || !message.id) return;
    const channelId = message.channel_id || message.channelId;
    if (!channelId) return;
    const previous = recentMessages.get(message.id);
    const merged = previous ? { ...previous, ...message } : message;
    const reference = merged.messageReference || merged.message_reference || merged.reference;
    const embedded = merged.referencedMessage && (merged.referencedMessage.message || merged.referencedMessage) || merged.referenced_message;
    const snapshot = {
      id: String(merged.id),
      channel_id: String(channelId),
      guild_id: merged.guild_id || merged.guildId || null,
      content: clip(merged.content, MAX_SNIPPET),
      author: merged.author ? {
        id: merged.author.id,
        username: merged.author.username,
        globalName: merged.author.globalName,
        global_name: merged.author.global_name,
        bot: !!merged.author.bot,
      } : previous && previous.author,
      mentions: Array.isArray(merged.mentions) ? merged.mentions.map((user) => typeof user === "string" ? user : user && user.id).filter(Boolean) : previous && previous.mentions || [],
      mentioned: typeof merged.mentioned === "boolean" ? merged.mentioned : previous && previous.mentioned,
      messageReference: reference ? {
        message_id: reference.message_id || reference.messageId,
        channel_id: reference.channel_id || reference.channelId || String(channelId),
      } : previous && previous.messageReference,
      referencedMessage: embedded && embedded.author ? { message: { author: { id: embedded.author.id } } } : previous && previous.referencedMessage,
    };
    recentMessages.delete(snapshot.id);
    recentMessages.set(snapshot.id, snapshot);
    while (recentMessages.size > MAX_RECENT_MESSAGES) recentMessages.delete(recentMessages.keys().next().value);
  }
  function getKnownMessage(channelId, id) { return getMessage(channelId, id); }
  const getChannel = (id) => { try { return id ? ChannelStore.getChannel(id) : null; } catch (_) { return null; } };
  const guildOf = (c) => { const ch = getChannel(c); return ch && ch.guild_id ? ch.guild_id : null; };
  const isDM = (ch) => !!ch && (ch.type === 1 || ch.type === 3);
  const myId = () => { try { return UserStore.getCurrentUser()?.id || null; } catch (_) { return null; } };

  function currentChannelId() {
    try {
      SelectedChannelStore = SelectedChannelStore || findByStoreName("SelectedChannelStore");
      return SelectedChannelStore.getChannelId();
    } catch (_) { return null; }
  }

  function channelLabel(channelId, guildId) {
    const ch = getChannel(channelId);
    if (!ch) return "Unknown channel";
    if (isDM(ch)) {
      let name = ch.name;
      if (!name) {
        try { name = (ch.recipients || []).map((id) => UserStore.getUser(id)?.username).filter(Boolean).join(", "); } catch (_) {}
      }
      return "DM · " + (name || "Unknown");
    }
    let guild = null;
    try { guild = findByStoreName("GuildStore").getGuild(guildId || ch.guild_id)?.name; } catch (_) {}
    return "#" + (ch.name || "channel") + (guild ? " · " + guild : "");
  }

  function save() {
    try { cfg().pings = pings.slice(); } catch (_) {}
  }

  function notificationSeconds() {
    const value = Number(cfg().notificationDuration);
    if (!Number.isFinite(value)) return DEFAULT_NOTIFICATION_SECONDS;
    return Math.max(MIN_NOTIFICATION_SECONDS, Math.min(MAX_NOTIFICATION_SECONDS, Math.round(value)));
  }

  function closePingAlert() {
    try {
      const alerts = findByProps("openLazy", "close");
      if (alerts && typeof alerts.close === "function") alerts.close();
    } catch (_) {}
  }

  function NotificationDurationModal(props) {
    const [value, setValue] = React.useState(String(props.initialValue || DEFAULT_NOTIFICATION_SECONDS));
    const [error, setError] = React.useState("");
    const colors = palette();
    const close = () => closePingAlert();
    const save = () => {
      const seconds = Number(String(value).trim());
      if (!Number.isInteger(seconds) || seconds < MIN_NOTIFICATION_SECONDS || seconds > MAX_NOTIFICATION_SECONDS) {
        setError("Enter a whole number from " + MIN_NOTIFICATION_SECONDS + " to " + MAX_NOTIFICATION_SECONDS + ".");
        return;
      }
      closePingAlert();
      if (typeof props.onSave === "function") props.onSave(seconds);
    };
    const action = (label, onPress, primary) => React.createElement(RN.Pressable, {
      key: label,
      onPress,
      accessibilityRole: "button",
      style: {
        minHeight: 44,
        paddingHorizontal: 16,
        borderRadius: 8,
        marginLeft: primary ? 10 : 0,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: primary ? "#5865F2" : "rgba(128,128,128,0.22)",
      },
    }, React.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" } }, label));
    return React.createElement(RN.View, {
      style: {
        width: "100%",
        maxWidth: 440,
        alignSelf: "center",
        padding: 20,
        borderRadius: 14,
        backgroundColor: colors.text === "#FFFFFF" ? "#2B2D31" : "#FFFFFF",
      },
    },
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 20, fontWeight: "700", marginBottom: 8 } }, "Alert duration"),
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 14, marginBottom: 16 } }, "Choose 3–120 seconds before the alert closes automatically."),
      React.createElement(RN.TextInput, {
        value,
        onChangeText: (next) => { setValue(next); setError(""); },
        keyboardType: "number-pad",
        placeholder: String(DEFAULT_NOTIFICATION_SECONDS),
        accessibilityLabel: "Alert duration in seconds",
        style: {
          minHeight: 48,
          paddingHorizontal: 12,
          borderRadius: 8,
          color: colors.text,
          fontSize: 17,
          backgroundColor: "rgba(128,128,128,0.16)",
        },
      }),
      error ? React.createElement(RN.Text, { style: { color: RED, fontSize: 13, marginTop: 8 } }, error) : null,
      React.createElement(RN.View, { style: { flexDirection: "row", justifyContent: "flex-end", marginTop: 18 } },
        action("Cancel", close, false), action("Save", save, true)));
  }

  function GhostPingAlert(props) {
    const entry = props.entry;
    const seconds = props.seconds;
    const isTest = String(entry.id).startsWith("test-");
    React.useEffect(() => {
      const timer = setTimeout(closePingAlert, seconds * 1000);
      return () => clearTimeout(timer);
    }, [entry.id, seconds]);

    const close = () => closePingAlert();
    const jump = () => {
      closePingAlert();
      if (!isTest) setTimeout(() => jumpTo(entry.c, entry.g, entry.id, lastSettingsNavigation), 180);
    };
    const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message that mentioned you";
    const colors = palette();
    const button = (label, onPress, primary) => React.createElement(RN.Pressable, {
      key: label,
      onPress,
      accessibilityRole: "button",
      style: {
        minHeight: 46,
        paddingHorizontal: 16,
        borderRadius: 8,
        alignItems: "center",
        justifyContent: "center",
        marginLeft: primary ? 10 : 0,
        backgroundColor: primary ? "#5865F2" : "rgba(128,128,128,0.22)",
      },
    }, React.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" } }, label));
    return React.createElement(RN.View, {
      style: {
        width: "100%",
        maxWidth: 440,
        alignSelf: "center",
        padding: 20,
        borderRadius: 14,
        backgroundColor: colors.text === "#FFFFFF" ? "#2B2D31" : "#FFFFFF",
      },
    },
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 20, fontWeight: "700", marginBottom: 12 } }, "Ghost Ping Logger"),
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 15, lineHeight: 21 } },
        "Ghost ping: " + entry.an + " " + what + "\n\n" + (entry.t || "(no message text)")),
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 13, marginTop: 14, marginBottom: 18 } },
        "This alert closes in " + seconds + " seconds."),
      React.createElement(RN.View, { style: { flexDirection: "row", justifyContent: "flex-end" } },
        !isTest ? button("Dismiss", close, false) : null,
        button(isTest ? "Close" : "Jump to message", isTest ? close : jump, true)));
  }

  function showPingAlert(entry) {
    const seconds = notificationSeconds();
    try {
      if (ui.alerts && typeof ui.alerts.showCustomAlert === "function") {
        ui.alerts.showCustomAlert(GhostPingAlert, { entry, seconds });
        return;
      }
    } catch (_) {}
    const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message that mentioned you";
    toast("Ghost ping: " + entry.an + " " + what);
  }

  function purge() {
    const days = cfg().retentionDays;
    if (!days) return false;
    const cutoff = Date.now() - days * DAY;
    const kept = pings.filter((p) => p.at >= cutoff);
    if (kept.length === pings.length) return false;
    pings = kept;
    return true;
  }

  function isReplyToMe(msg, channelId, me) {
    const ref = msg.messageReference;
    if (!ref) return false;
    const refId = ref.message_id || ref.messageId;
    const refChannel = ref.channel_id || ref.channelId || channelId;
    const target = refId ? getKnownMessage(refChannel, refId) : null;
    if (target && target.author && target.author.id === me) return true;
    const embedded = msg.referencedMessage && msg.referencedMessage.message;
    const alt = embedded || msg.referenced_message;
    return !!(alt && alt.author && alt.author.id === me);
  }

  function mentionsMe(msg, me) {
    if (msg.mentioned === true) return true;
    try {
      for (const m of msg.mentions || []) {
        if ((typeof m === "string" ? m : m && m.id) === me) return true;
      }
    } catch (_) {}
    return false;
  }

  function addPing(entry) {
    pings.unshift(entry);
    if (pings.length > MAX_PINGS) pings.length = MAX_PINGS;
    save();
    if (cfg().showToast) showPingAlert(entry);
  }

  function check(msg, channelId, guildId) {
    const s = cfg();
    if (!s.enabled) return;
    const me = myId();
    if (!me || !msg.author || msg.author.id === me) return;
    if (s.skipBots && msg.author.bot) return;
    let kind = null;
    if (s.pingDMs && isDM(getChannel(channelId))) kind = "dm";
    if (!kind && s.pingReplies && isReplyToMe(msg, channelId, me)) kind = "reply";
    if (!kind && s.pingMentions && mentionsMe(msg, me)) kind = "mention";
    if (!kind || pings.some((p) => p.id === msg.id)) return;
    addPing({
      id: msg.id, c: channelId, g: guildId || null, ai: msg.author.id, an: nameOf(msg.author),
      t: clip(msg.content, MAX_SNIPPET), k: kind, at: Date.now(),
    });
  }

  function handle(channelId, guildId, ids) {
    const g = guildId || guildOf(channelId);
    for (const id of ids) {
      if (!id) continue;
      const msg = getKnownMessage(channelId, id);
      if (msg) check(msg, channelId, g);
    }
  }

  function hookDispatch(args) {
    const e = args[0];
    if (!e) return;
    try {
      if (e.loggerRemoval) return;
      if (e.type === "MESSAGE_DELETE") handle(e.channelId, e.guildId, [e.id]);
      else if (e.type === "MESSAGE_DELETE_BULK") handle(e.channelId, e.guildId, [].concat(e.ids || [], e.loggerKept || []));
      else if (e.type === "MESSAGE_LOGGER_BLOCKED" && e.original) {
        const o = e.original;
        if (o.type === "MESSAGE_DELETE") handle(o.channelId, o.guildId, [o.id]);
        else if (o.type === "MESSAGE_DELETE_BULK") handle(o.channelId, o.guildId, [].concat(o.ids || [], o.loggerKept || []));
      }
    } catch (_) {}
  }

  function addTestPing() {
    const c = currentChannelId() || "0";
    const entry = {
      id: "test-" + Date.now(), c, g: guildOf(c), ai: "0", an: "Test user",
      t: "This is a test ghost ping.", k: "mention", at: Date.now(),
    };
    pings.unshift(entry);
    if (pings.length > MAX_PINGS) pings.length = MAX_PINGS;
    save();
    showPingAlert(entry);
  }

  function removePing(id) {
    pings = pings.filter((p) => p.id !== id);
    save();
  }

  function jumpTo(channelId, guildId, messageId, navigation) {
    const real = messageId && !String(messageId).startsWith("test-") ? messageId : null;
    const openMessagesTab = () => {
      let current = navigation;
      for (let depth = 0; current && depth < 8; depth++) {
        let state = null;
        try { state = typeof current.getState === "function" ? current.getState() : null; } catch (_) {}
        const routes = state && Array.isArray(state.routes) ? state.routes : [];
        const target = routes.find((route) => /^(home|messages|messagestab|hometab|directmessages)$/i.test(String(route.name || ""))) ||
          routes.find((route) => /home|messages|direct.?messages/i.test(String(route.name || "")) && !/setting|profile|you/i.test(String(route.name || "")));
        if (target) {
          try {
            if (typeof current.jumpTo === "function") current.jumpTo(target.name);
            else if (typeof current.navigate === "function") current.navigate(target.name);
            else return false;
            return true;
          } catch (_) {}
        }
        try { current = typeof current.getParent === "function" ? current.getParent() : null; }
        catch (_) { current = null; }
      }
      return false;
    };
    const dismissProfileRoute = () => {
      let current = navigation;
      for (let depth = 0; current && depth < 8; depth++) {
        let state = null;
        try { state = typeof current.getState === "function" ? current.getState() : null; } catch (_) {}
        const routes = state && Array.isArray(state.routes) ? state.routes : [];
        const active = routes[state && Number.isInteger(state.index) ? state.index : routes.length - 1];
        const routeName = String(active && active.name || "");
        if (/user.?profile|profile.?modal/i.test(routeName) && !/you|settings/i.test(routeName)) {
          try {
            if (typeof current.goBack === "function" && current.canGoBack()) current.goBack();
            else if (typeof current.dismiss === "function") current.dismiss();
            return true;
          } catch (_) {}
        }
        try { current = typeof current.getParent === "function" ? current.getParent() : null; }
        catch (_) { current = null; }
      }
      return false;
    };
    const selectAfterClose = () => {
      setTimeout(() => {
        // UserProfile is often presented as a modal above the tab navigator.
        // Closing only the plugin settings route leaves that profile modal
        // visible, so close the app modal stack before selecting Messages.
        try {
          const modalActions = findByProps("closeAllModals");
          if (modalActions && typeof modalActions.closeAllModals === "function") modalActions.closeAllModals();
        } catch (_) {}
        try { FluxDispatcher.dispatch({ type: "USER_PROFILE_MODAL_CLOSE" }); } catch (_) {}
        try { FluxDispatcher.dispatch({ type: "USER_SETTINGS_MODAL_CLOSE" }); } catch (_) {}
        setTimeout(() => {
          dismissProfileRoute();
          setTimeout(() => {
            openMessagesTab();
            setTimeout(() => {
              // Use the client's channel router so navigation leaves the
              // profile tab and enters the actual Kettu conversation route.
              try {
                const channelRouter = findByProps("transitionToChannel");
                if (channelRouter && typeof channelRouter.transitionToChannel === "function") {
                  channelRouter.transitionToChannel(String(channelId));
                }
              } catch (_) {}
              try {
                const navigationRouter = findByProps("transitionTo");
                const path = guildId
                  ? "/channels/" + String(guildId) + "/" + String(channelId)
                  : "/channels/@me/" + String(channelId);
                if (navigationRouter && typeof navigationRouter.transitionTo === "function") navigationRouter.transitionTo(path);
              } catch (_) {}
              try { FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", guildId: guildId || null, channelId }); } catch (_) {}
              if (!real) return;
              const actions = findByProps("jumpToMessage");
              if (!actions || typeof actions.jumpToMessage !== "function") {
                toast("Could not find Kettu's message navigation action");
                return;
              }
              const jumpWhenChannelIsReady = (attemptsLeft) => {
                if (String(currentChannelId() || "") !== String(channelId) && attemptsLeft > 0) {
                  return setTimeout(() => jumpWhenChannelIsReady(attemptsLeft - 1), 120);
                }
                try {
                  actions.jumpToMessage({ channelId, messageId: real, flash: true, jumpType: "INSTANT" });
                } catch (_) {
                  try { actions.jumpToMessage(channelId, real, true); }
                  catch (_) { toast("Kettu could not jump to that message"); }
                }
              };
              jumpWhenChannelIsReady(25);
          }, 220);
          }, 160);
        }, 250);
      }, 250);
    };
    // The plugin settings are nested above the profile view. Unwind their
    // routes first; the modal and profile route are closed afterward.
    const nav = navigation;
    let depth = 0;
    const closeOne = () => {
      if (!nav || depth++ >= 8) return selectAfterClose();
      let canGoBack = false;
      try { canGoBack = typeof nav.canGoBack === "function" && nav.canGoBack(); } catch (_) {}
      if (canGoBack && typeof nav.goBack === "function") {
        try { nav.goBack(); } catch (_) {}
        return setTimeout(closeOne, 120);
      }
      try {
        if (typeof nav.dismiss === "function") nav.dismiss();
      } catch (_) {}
      selectAfterClose();
    };
    closeOne();
  }

  function ask(title, message, buttons) {
    const ios = RN.Platform && RN.Platform.OS === "ios";
    const list = buttons.slice(0, ios ? 6 : 3);
    if (ios) list.push({ text: "Cancel", style: "cancel" });
    try { RN.Alert.alert(title, message, list, { cancelable: true }); } catch (_) {}
  }

  function palette() {
    let light = false;
    try {
      ThemeStore = ThemeStore || findByStoreName("ThemeStore");
      light = !!ThemeStore && ThemeStore.theme === "light";
    } catch (_) {}
    return light ? { text: "#060607", sub: "#5C5E66" } : { text: "#FFFFFF", sub: "#B5BAC1" };
  }

  function Settings() {
    vstorage.useProxy(plugin.storage);
    const [screen, setScreen] = React.useState("main");
    const [limit, setLimit] = React.useState(PAGE);
    const [, bump] = React.useState(0);
    let settingsNavigation = null;
    try {
      const navigationModule = findByProps("useNavigation");
      const useNavigation = navigationModule && navigationModule.useNavigation;
      if (typeof useNavigation === "function") settingsNavigation = useNavigation();
    } catch (_) {}
    lastSettingsNavigation = settingsNavigation;
    const refreshUI = () => bump((x) => x + 1);
    const F = ui.components && ui.components.Forms;
    const C = palette();
    const h = React.createElement;

    const Text = (props, ...kids) => h(RN.Text, props, ...kids);
    const Section = (title) =>
      h(RN.View, { key: "sec-" + title, style: { paddingHorizontal: 16, paddingTop: 18, paddingBottom: 4 } },
        Text({ style: { color: C.sub, fontSize: 12, fontWeight: "600" } }, title.toUpperCase()));

    const PressRow = (key, label, sub, onPress, right) =>
      h(RN.Pressable, { key, onPress, style: { paddingHorizontal: 16, paddingVertical: 12, flexDirection: "row", alignItems: "center" } },
        h(RN.View, { style: { flex: 1 } },
          Text({ style: { color: C.text, fontSize: 16 } }, label),
          sub ? Text({ style: { color: C.sub, fontSize: 13, marginTop: 2 } }, sub) : null),
        right ? Text({ style: { color: C.sub, fontSize: 15 } }, right) : null);

    const Switch = (key, label, sub) => {
      const value = !!cfg()[key];
      const change = (v) => { cfg()[key] = v; refreshUI(); };
      return F && F.FormSwitchRow
        ? h(F.FormSwitchRow, { key, label, subLabel: sub, value, onValueChange: change })
        : h(RN.View, { key, style: { flexDirection: "row", alignItems: "center", padding: 16 } },
            h(RN.View, { style: { flex: 1 } },
              Text({ style: { color: C.text, fontSize: 16 } }, label),
              Text({ style: { color: C.sub, fontSize: 13 } }, sub)),
            h(RN.Switch, { value, onValueChange: change }));
    };

    const Btn = (key, title, onPress, color) =>
      h(RN.View, { key, style: { paddingHorizontal: 16, paddingVertical: 6 } }, h(RN.Button, { title, onPress, color }));

    const retentionLabel = () => (cfg().retentionDays === 7 ? "7 days" : cfg().retentionDays === 30 ? "30 days" : "Forever");
    const cycleRetention = () => {
      const cur = cfg().retentionDays || 0;
      cfg().retentionDays = cur === 0 ? 7 : cur === 7 ? 30 : 0;
      if (purge()) save();
      refreshUI();
    };
    const editNotificationDuration = () => {
      try {
        ui.alerts.showCustomAlert(NotificationDurationModal, {
          initialValue: notificationSeconds(),
          onSave: (seconds) => {
            cfg().notificationDuration = seconds;
            refreshUI();
          },
        });
      } catch (_) { toast("Could not open alert duration settings"); }
    };

    let content;
    if (screen === "history") {
      content = [
        Btn("back", "< Back", () => { setScreen("main"); setLimit(PAGE); }),
        h(RN.View, { key: "title", style: { paddingHorizontal: 16, paddingVertical: 8 } },
          Text({ style: { color: C.text, fontSize: 20, fontWeight: "700" } }, "Ghost pings (" + pings.length + ")")),
      ];
      if (pings.length) {
        content.push(Btn("clear", "Clear history", () => {
          ask("Clear ghost ping history?", "This removes every saved ghost ping.", [
            { text: "Clear", style: "destructive", onPress: () => { pings = []; save(); refreshUI(); } },
          ]);
        }, RED));
      } else {
        content.push(Text({ key: "empty", style: { color: C.sub, padding: 16 } }, "No ghost pings yet."));
      }
      pings.slice(0, limit).forEach(function (entry) {
        // Keep each row's identity and action bound to the same immutable
        // values. This mirrors the isolated row callbacks used by AML logs.
        const pingId = String(entry.id);
        const channelId = entry.c == null ? null : String(entry.c);
        const guildId = entry.g == null ? null : String(entry.g);
        const kind = KINDS[entry.k] || "Ghost ping";
        const authorName = String(entry.an || "Unknown");
        const messageText = String(entry.t || "");
        const occurredAt = Number(entry.at) || 0;
        const rowKey = "ghost-history-" + pingId;
        content.push(PressRow(rowKey, clip(messageText, 200) || "(no text)",
          kind + " · " + authorName + " · " + channelLabel(channelId, guildId) + " · " + fmtTime(occurredAt), function () {
            ask(kind + " from " + authorName, clip(messageText, 600), [
              { text: "Jump to message", onPress: () => jumpTo(channelId, guildId, pingId, settingsNavigation) },
              { text: "Remove", style: "destructive", onPress: () => { removePing(pingId); refreshUI(); } },
            ]);
          }));
      });
      if (pings.length > limit) content.push(Btn("more", "Show more", () => setLimit(limit + PAGE)));
    } else {
      content = [
        Section("Detection"),
        Switch("enabled", "Ghost ping logger", "Notify when a message that pinged you gets deleted"),
        Switch("pingMentions", "Mentions", "Messages that mentioned you"),
        Switch("pingReplies", "Replies", "Replies to your messages"),
        Switch("pingDMs", "Direct messages", "Every deleted message in your DMs"),
        Switch("skipBots", "Ignore bots", "Do not report deleted bot messages"),
        Section("Alerts"),
        Switch("showToast", "Show ghost ping alert", "Show a modal with Jump to message and Dismiss"),
        PressRow("duration", "Alert duration", "Automatically dismiss the alert after this many seconds", editNotificationDuration, notificationSeconds() + " sec"),
        Section("History"),
        PressRow("nav", "Ghost ping history", pings.length + " saved", () => { setLimit(PAGE); setScreen("history"); }, ">"),
        PressRow("retention", "Keep history for", "Older entries are removed automatically", cycleRetention, retentionLabel()),
        Btn("test", "Send a test ghost ping", () => { addTestPing(); refreshUI(); }),
      ];
    }
    content.unshift(h(RN.View, { key: "build", style: { paddingHorizontal: 16, paddingTop: 8 } },
      Text({ style: { color: C.sub, fontSize: 11 } }, "Build " + BUILD)));
    return h(RN.ScrollView, null, ...content);
  }

  function onLoad() {
    const s = cfg();
    const defaults = { enabled: true, pingMentions: true, pingReplies: true, pingDMs: true, skipBots: false, showToast: true, notificationDuration: DEFAULT_NOTIFICATION_SECONDS, retentionDays: 0 };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];

    if (!loadStores()) { toast("Ghost Ping Logger: required Discord modules not found"); return; }
    recentMessages.clear();
    try { pings = Array.isArray(s.pings) ? JSON.parse(JSON.stringify(s.pings)) : []; } catch (_) { pings = []; }
    if (purge()) save();

    try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); } catch (_) { return; }
    try {
      appStateSub = RN.AppState.addEventListener("change", (state) => { if (state === "active" && purge()) save(); });
    } catch (_) {}
  }

  function onUnload() {
    for (const u of unpatches.splice(0)) { try { u(); } catch (_) {} }
    if (appStateSub && appStateSub.remove) { try { appStateSub.remove(); } catch (_) {} }
    appStateSub = null;
    lastSettingsNavigation = null;
    recentMessages.clear();
    pings = [];
  }

  return { onLoad, onUnload, settings: Settings };
})()
