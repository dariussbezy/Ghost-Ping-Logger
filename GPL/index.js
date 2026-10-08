(() => {
  "use strict";
  const { metro, patcher, plugin, ui } = vendetta;
  const vstorage = vendetta.storage;
  const { findByProps, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_PINGS = 200;
  const MAX_SNIPPET = 300;
  const BUILD = "v1";
  const PAGE = 40;
  const DAY = 86400000;
  const RED = "#ED4245";
  const KINDS = { dm: "DM", reply: "Reply", mention: "Mention" };
  const JUMP_METHODS = ["App link", "Jump action (experimental)", "System link"];

  const unpatches = [];
  let pings = [];
  let MessageStore;
  let UserStore;
  let ChannelStore;
  let SelectedChannelStore;
  let ThemeStore;
  let appStateSub = null;

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
    const target = refId ? getMessage(refChannel, refId) : null;
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
    if (cfg().showToast) {
      const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message that mentioned you";
      toast("Ghost ping: " + entry.an + " " + what);
    }
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
      const msg = getMessage(channelId, id);
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
    toast("Ghost ping: " + entry.an + " deleted a message that mentioned you");
  }

  function removePing(id) {
    pings = pings.filter((p) => p.id !== id);
    save();
  }

  function jumpApp(channelId, guildId, messageId, link) {
    const u = metro.common.url || findByProps("openURL", "openDeeplink");
    if (u && typeof u.openURL === "function") { u.openURL(link); return true; }
    return false;
  }

  function jumpAction(channelId, guildId, messageId) {
    const actions = findByProps("jumpToMessage");
    if (!actions || typeof actions.jumpToMessage !== "function") return false;
    try { FluxDispatcher.dispatch({ type: "CHANNEL_SELECT", guildId: guildId || null, channelId }); } catch (_) {}
    if (messageId) actions.jumpToMessage({ channelId, messageId, flash: true, jumpType: "ANIMATED" });
    return true;
  }

  function jumpSystem(channelId, guildId, messageId, link) {
    const u = metro.common.url || findByProps("openDeeplink");
    if (u && typeof u.openDeeplink === "function") { u.openDeeplink(link); return true; }
    RN.Linking.openURL(link);
    return true;
  }

  function jumpTo(channelId, guildId, messageId) {
    const real = messageId && !String(messageId).startsWith("test-") ? messageId : null;
    const link = "https://discord.com/channels/" + (guildId || "@me") + "/" + channelId + (real ? "/" + real : "");
    const method = cfg().jumpMethod || 1;
    const order = method === 2 ? [jumpAction, jumpApp, jumpSystem] : method === 3 ? [jumpSystem, jumpApp] : [jumpApp, jumpAction, jumpSystem];
    for (const fn of order) {
      try { if (fn(channelId, guildId, real, link)) return; } catch (_) {}
    }
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
      for (const p of pings.slice(0, limit)) {
        content.push(PressRow(p.id, clip(p.t, 200) || "(no text)",
          KINDS[p.k] + " · " + p.an + " · " + channelLabel(p.c, p.g) + " · " + fmtTime(p.at), () => {
            ask(KINDS[p.k] + " from " + p.an, clip(p.t, 600), [
              { text: "Jump to message", onPress: () => jumpTo(p.c, p.g, p.id) },
              { text: "Remove", style: "destructive", onPress: () => { removePing(p.id); refreshUI(); } },
            ]);
          }));
      }
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
        Switch("showToast", "Show an alert", "Shows a banner at the top of the app when it happens"),
        Section("History"),
        PressRow("nav", "Ghost ping history", pings.length + " saved", () => { setLimit(PAGE); setScreen("history"); }, ">"),
        PressRow("retention", "Keep history for", "Older entries are removed automatically", cycleRetention, retentionLabel()),
        PressRow("jump", "Jump to message method", "Tap to switch if jumping opens the wrong app",
          () => { cfg().jumpMethod = (cfg().jumpMethod || 1) % 3 + 1; refreshUI(); }, JUMP_METHODS[(cfg().jumpMethod || 1) - 1]),
        Btn("test", "Send a test ghost ping", () => { addTestPing(); refreshUI(); }),
      ];
    }
    content.unshift(h(RN.View, { key: "build", style: { paddingHorizontal: 16, paddingTop: 8 } },
      Text({ style: { color: C.sub, fontSize: 11 } }, "Build " + BUILD)));
    return h(RN.ScrollView, null, ...content);
  }

  function onLoad() {
    const s = cfg();
    const defaults = { enabled: true, pingMentions: true, pingReplies: true, pingDMs: true, skipBots: false, showToast: true, retentionDays: 0, jumpMethod: 1 };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];

    if (!loadStores()) { toast("Ghost Ping Logger: required Discord modules not found"); return; }
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
    pings = [];
  }

  return { onLoad, onUnload, settings: Settings };
})()
