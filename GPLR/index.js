const rainRuntime = globalThis.rain;
if (!rainRuntime || !rainRuntime.api || !rainRuntime.api.storage) throw new Error("Discord plugin API unavailable");
const rainStore = rainRuntime.api.storage.createPluginStore("gpl", {});
const pluginStorage = rainStore.settings;
const implementation = (() => {
  "use strict";
  const { metro } = rainRuntime;
  const patcher = rainRuntime.api.patcher;
  const ui = rainRuntime.api.ui;
  const { findByName, findByProps, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_PINGS = 200;
  const DEFAULT_RECENT_MESSAGES = 5000;
  const MIN_RECENT_MESSAGES = 100;
  const MAX_RECENT_MESSAGES = 20000;
  const MAX_RECENT_CACHE_BYTES = 8 * 1024 * 1024;
  const RECENT_ARCHIVE_SAVE_DELAY = 30000;
  const MAX_SNIPPET = 300;
  const BUILD = "v1.0.2";
  const GPL_ALERT_BRIDGE_KEY = "__ghost_ping_logger_aml_bridge_v1__";
  const PAGE = 40;
  const DAY = 86400000;
  const RED = "#ED4245";
  const INLINE = new Set(["text", "strong", "em", "u", "s", "inlineCode"]);
  const KINDS = { dm: "DM", reply: "Reply", mention: "Mention" };

  const unpatches = [];
  const AML_BRIDGE_KEY = "__advanced_message_logger_gpl_bridge_v1__";
  let pings = [];
  const recentMessages = new Map();
  const recentMessageSizes = new Map();
  const recentArchiveIds = new Set();
  let recentMessageBytes = 0;
  let receivedThisSession = 0;
  let receivedDMsThisSession = 0;
  const receivedChannelsThisSession = new Set();
  let recentArchiveDirty = false;
  let recentArchiveTimer = null;
  const retainedPings = new Map();
  let MessageStore;
  let UserStore;
  let ChannelStore;
  let SelectedChannelStore;
  let ThemeStore;
  let appStateSub = null;
  let renderUnpatch = null;
  let lastSettingsNavigation = null;
  const alertedPings = new Set();

  const cfg = () => pluginStorage;
  const toast = (t) => { try { ui.toasts.showToast(t); } catch (_) {} };
  const clip = (s, n) => String(s == null ? "" : s).slice(0, n);

  function amlOwnsRetention(message, channelId, guildId) {
    try {
      const bridge = globalThis[AML_BRIDGE_KEY];
      return !!(bridge && bridge.active && typeof bridge.shouldRetainDelete === "function" && bridge.shouldRetainDelete(message, channelId, guildId));
    } catch (_) { return false; }
  }
  function amlOwnsDeletedMessage(id) {
    try {
      const bridge = globalThis[AML_BRIDGE_KEY];
      return !!(bridge && bridge.active && typeof bridge.ownsDeletedMessage === "function" && bridge.ownsDeletedMessage(id));
    } catch (_) { return false; }
  }
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
  function rememberMessage(message, persistArchive) {
    if (cfg().captureMode !== "expanded" || !message || !message.id) return;
    const channelId = message.channel_id || message.channelId;
    if (!channelId) return;
    const previous = recentMessages.get(message.id);
    if (!previous && !(message.author && typeof message.author === "object")) return;
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
      mentionEveryone: !!(merged.mention_everyone === true || merged.mentionEveryone === true || previous && previous.mentionEveryone),

      mentioned: typeof merged.mentioned === "boolean" ? merged.mentioned : previous && previous.mentioned,
      messageReference: reference ? {
        message_id: reference.message_id || reference.messageId,
        channel_id: reference.channel_id || reference.channelId || String(channelId),
      } : previous && previous.messageReference,
      referencedMessage: embedded && embedded.author ? { message: { author: { id: embedded.author.id } } } : previous && previous.referencedMessage,
    };
    const size = 512 + snapshot.content.length * 2 + (snapshot.mentions || []).length * 32 +
      String(snapshot.author && snapshot.author.username || "").length * 2 +
      String(snapshot.author && (snapshot.author.globalName || snapshot.author.global_name) || "").length * 2;
    if (size > MAX_RECENT_CACHE_BYTES) return;
    if (recentMessages.has(snapshot.id)) {
      recentMessageBytes = Math.max(0, recentMessageBytes - (recentMessageSizes.get(snapshot.id) || 0));
      recentMessages.delete(snapshot.id);
    }
    recentMessages.set(snapshot.id, snapshot);
    recentMessageSizes.set(snapshot.id, size);
    recentMessageBytes += size;
    trimRecentMessages();
    if (persistArchive !== false && cfg().rememberReceivedMessages !== false) {
      recentArchiveIds.add(snapshot.id);
      scheduleRecentArchiveSave();
    }
  }

  function flushRecentArchive() {
    if (recentArchiveTimer) { clearTimeout(recentArchiveTimer); recentArchiveTimer = null; }
    if (!recentArchiveDirty) return;
    recentArchiveDirty = false;
    try {
      cfg().receivedMessages = cfg().rememberReceivedMessages === false ? [] : Array.from(recentArchiveIds).map((id) => recentMessages.get(id)).filter(Boolean);
    } catch (_) {
      recentArchiveDirty = true;
      if (cfg().rememberReceivedMessages !== false && !recentArchiveTimer) recentArchiveTimer = setTimeout(flushRecentArchive, 60000);
    }
  }

  function scheduleRecentArchiveSave() {
    if (cfg().rememberReceivedMessages === false) return;
    recentArchiveDirty = true;
    if (!recentArchiveTimer) recentArchiveTimer = setTimeout(flushRecentArchive, RECENT_ARCHIVE_SAVE_DELAY);
  }

  function restoreRecentArchive() {
    if (cfg().rememberReceivedMessages === false) return;
    const saved = Array.isArray(cfg().receivedMessages) ? cfg().receivedMessages : [];
    for (const message of saved) rememberMessage(message);
    recentArchiveDirty = false;
    if (recentArchiveTimer) { clearTimeout(recentArchiveTimer); recentArchiveTimer = null; }
  }
  function trimRecentMessages() {
    while (recentMessages.size > recentMessageLimit() || recentMessageBytes > MAX_RECENT_CACHE_BYTES) {
      const oldest = recentMessages.keys().next().value;
      if (oldest === undefined) break;
      recentMessages.delete(oldest);
      recentArchiveIds.delete(oldest);
      recentMessageBytes = Math.max(0, recentMessageBytes - (recentMessageSizes.get(oldest) || 0));
      recentMessageSizes.delete(oldest);
    }
  }
  function clearRecentMessages() {
    recentMessages.clear();
    recentMessageSizes.clear();
    recentArchiveIds.clear();
    recentMessageBytes = 0;
  }
  function recentMessageLimit() {
    const value = Number(cfg().maxCachedMessages);
    if (!Number.isFinite(value)) return DEFAULT_RECENT_MESSAGES;
    return Math.max(MIN_RECENT_MESSAGES, Math.min(MAX_RECENT_MESSAGES, Math.round(value)));
  }
  function getKnownMessage(channelId, id) {
    const cached = getMessage(channelId, id);
    if (cached) return cached;
    if (cfg().captureMode === "expanded") {
      const recent = recentMessages.get(String(id));
      if (recent && String(recent.channel_id) === String(channelId)) return recent;
    }
    // AML may have received this message through a client event path that did
    // not populate GPL's own cache. Use that cache only as an optional fallback;
    // GPL's local MessageStore/recentMessages remain sufficient when AML is off.
    try {
      const bridge = globalThis[AML_BRIDGE_KEY];
      if (bridge && bridge.active && typeof bridge.getKnownMessage === "function") {
        const shared = bridge.getKnownMessage(channelId, id);
        if (shared && (!shared.channel_id || String(shared.channel_id) === String(channelId))) return shared;
      }
    } catch (_) {}
    return null;
  }
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

  function closePingAlert() {
    try {
      const alerts = findByProps("openLazy", "close");
      if (alerts && typeof alerts.close === "function") alerts.close();
    } catch (_) {}
  }

  function closeSettingsAlert() {
    try {
      const alerts = findByProps("openLazy", "close");
      if (alerts && typeof alerts.close === "function") alerts.close();
    } catch (_) {}
  }

  function MessageCacheLimitModal(props) {
    const [value, setValue] = React.useState(String(props.initialValue || DEFAULT_RECENT_MESSAGES));
    const [error, setError] = React.useState("");
    const colors = palette();
    const action = (label, onPress, primary) => React.createElement(RN.Pressable, {
      key: label,
      onPress,
      accessibilityRole: "button",
      style: { minHeight: 46, paddingHorizontal: 18, borderRadius: 14, marginLeft: primary ? 10 : 0, alignItems: "center", justifyContent: "center", backgroundColor: primary ? colors.acc : "rgba(128,128,128,0.22)" },
    }, React.createElement(RN.Text, { style: { color: "#FFFFFF", fontSize: 15, fontWeight: "600" } }, label));
    const save = () => {
      const count = Number(String(value).trim());
      if (!Number.isInteger(count) || count < MIN_RECENT_MESSAGES || count > MAX_RECENT_MESSAGES) {
        setError("Enter a whole number from " + MIN_RECENT_MESSAGES + " to " + MAX_RECENT_MESSAGES + ".");
        return;
      }
      closeSettingsAlert();
      if (typeof props.onSave === "function") props.onSave(count);
    };
    return React.createElement(RN.View, { style: { width: "92%", maxWidth: 440, alignSelf: "center", padding: 18, borderRadius: 22, backgroundColor: colors.text === "#FFFFFF" ? "#2B2D31" : "#FFFFFF" } },
      React.createElement(RN.Text, { style: { color: colors.text, fontSize: 20, fontWeight: "700", marginBottom: 8 } }, "Maximum cached messages"),
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 14, marginBottom: 16 } }, "Keeps messages Discord delivers while running. The cache uses an estimated 8 MiB budget and does not download history."),
      React.createElement(RN.TextInput, { value, onChangeText: (next) => { setValue(next); setError(""); }, keyboardType: "number-pad", accessibilityLabel: "Maximum cached messages", style: { minHeight: 48, paddingHorizontal: 14, borderRadius: 14, color: colors.text, fontSize: 17, backgroundColor: "rgba(128,128,128,0.16)" } }),
      error ? React.createElement(RN.Text, { style: { color: RED, fontSize: 13, marginTop: 8 } }, error) : null,
      React.createElement(RN.View, { style: { flexDirection: "row", justifyContent: "flex-end", marginTop: 18 } },
        action("Cancel", closeSettingsAlert, false), action("Save", save, true)));
  }

  function GhostPingAlert(props) {
    const entry = props.entry;
    const isTest = String(entry.id).startsWith("test-");
    const close = () => closePingAlert();
    const jump = () => {
      closePingAlert();
      if (!isTest) setTimeout(() => jumpTo(entry.c, entry.g, entry.id, lastSettingsNavigation), 180);
    };
    const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message with a mention";
    const colors = palette();
    const h = React.createElement;
    const dark = colors.text === "#FFFFFF";
    const btn = (label, onPress, primary) => h(RN.Pressable, {
      key: label, onPress, accessibilityRole: "button",
      style: ({ pressed }) => ({ flex: 1, minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", marginLeft: primary ? 10 : 0, backgroundColor: primary ? (pressed ? colors.accPressed : colors.acc) : (pressed ? "rgba(128,128,128,0.32)" : "rgba(128,128,128,0.22)") }),
    }, h(RN.Text, { style: { color: primary ? "#FFFFFF" : colors.text, fontSize: 15, fontWeight: "700" } }, label));
    return h(RN.View, { style: { width: "100%", maxWidth: 440, alignSelf: "center", padding: 22, borderRadius: 22, backgroundColor: dark ? "#2B2D31" : "#FFFFFF" } },
      h(RN.View, { style: { flexDirection: "row", alignItems: "center" } },
        h(RN.View, { style: { width: 48, height: 48, borderRadius: 24, alignItems: "center", justifyContent: "center", backgroundColor: "rgba(237,66,69,0.16)" } },
          h(RN.Text, { style: { fontSize: 24 } }, "\uD83D\uDC7B")),
        h(RN.View, { style: { flex: 1, marginLeft: 14 } },
          h(RN.Text, { style: { color: RED, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 } }, "GHOST PING"),
          h(RN.Text, { style: { color: colors.text, fontSize: 18, fontWeight: "700", marginTop: 2 }, numberOfLines: 1 }, String(entry.an || "Unknown")))),
      h(RN.Text, { style: { color: colors.sub, fontSize: 14, marginTop: 14 } }, what),
      h(RN.View, { style: { marginTop: 10, padding: 14, borderRadius: 14, borderLeftWidth: 4, borderLeftColor: RED, backgroundColor: "rgba(237,66,69,0.10)" } },
        h(RN.Text, { style: { color: colors.text, fontSize: 15, lineHeight: 21 } }, entry.t || "(no message text)")),
      h(RN.View, { style: { flexDirection: "row", marginTop: 20 } },
        !isTest ? btn("Dismiss", close, false) : null,
        btn(isTest ? "Close" : "Jump to message", isTest ? close : jump, true)));
  }

  function showPingAlert(entry) {
    const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message with a mention";
    const isTest = String(entry.id).startsWith("test-");
    const buttons = [];
    if (!isTest) buttons.push({ text: "Dismiss", style: "cancel" });
    buttons.push({ text: isTest ? "Close" : "Jump to message", onPress: () => {
      if (!isTest) setTimeout(() => jumpTo(entry.c, entry.g, entry.id, lastSettingsNavigation), 180);
    } });
    const message = String(entry.an || "Unknown") + " " + what + ":\n\n" + (entry.t || "(no message text)");
    try {
      showDiscordAlert("gpl-ghost-ping", "Ghost ping", message, buttons);
    } catch (_) {
      toast("Ghost ping: " + entry.an + " " + what);
    }
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
    if (cfg().showToast) {
      alertedPings.add(String(entry.id));
      while (alertedPings.size > MAX_PINGS) alertedPings.delete(alertedPings.values().next().value);
      showPingAlert(entry);
    }
    return entry;
  }

  function pingKindFor(msg, channelId) {
    const s = cfg();
    if (!s.enabled) return null;
    const me = myId();
    if (!me || !msg || !msg.author || msg.author.id === me) return null;
    if (s.skipBots && msg.author.bot) return null;
    let kind = null;
    if (!kind && s.pingReplies && isReplyToMe(msg, channelId, me)) kind = "reply";
    if (!kind && s.pingMentions && mentionsMe(msg, me)) kind = "mention";
    if (!kind && s.trackEveryone && (msg.mention_everyone === true || msg.mentionEveryone === true)) kind = "mention";
    return kind;
  }

  function willShowDeleteAlert(msg, channelId, guildId, id) {
    if (!cfg().showToast) return false;
    if (id != null && alertedPings.has(String(id))) return true;
    return !!pingKindFor(msg, channelId);
  }

  function check(msg, channelId, guildId) {
    const kind = pingKindFor(msg, channelId);
    if (!kind) return null;
    const existing = pings.find((p) => String(p.id) === String(msg.id));
    if (existing) return existing;
    return addPing({
      id: msg.id, c: channelId, g: guildId || null, ai: msg.author.id, an: nameOf(msg.author),
      t: clip(msg.content, MAX_SNIPPET), k: kind, at: Date.now(),
    });
  }

  function handle(channelId, guildId, ids, retainForFallback) {
    const g = guildId || guildOf(channelId);
    for (const id of ids) {
      if (!id) continue;
      const msg = getKnownMessage(channelId, id);
      if (msg) {
        const entry = check(msg, channelId, g);
        if (entry && retainForFallback) retainedPings.set(String(id), entry);
      }
    }
  }

  function refreshRetainedMessage(msg, channelId, guildId) {
    setTimeout(() => {
      try {
        FluxDispatcher.dispatch({ type: "MESSAGE_UPDATE", guildId, message: { id: msg.id, channel_id: channelId, guild_id: guildId, flags: (msg.flags | 0) | 0x20000000 } });
      } catch (_) {}
    }, 0);
  }

  function refreshGhostRows() {
    for (const [id, entry] of retainedPings) {
      const msg = getMessage(entry.c, id);
      if (msg) refreshRetainedMessage(msg, entry.c, entry.g || guildOf(entry.c));
    }
  }

  function retainGhostPing(msg, channelId, guildId, entry) {
    retainedPings.set(String(msg.id), entry);
    while (retainedPings.size > MAX_PINGS) retainedPings.delete(retainedPings.keys().next().value);
    refreshRetainedMessage(msg, channelId, guildId);
  }

  function onDelete(e) {
    if (!e.id || e.loggerRemoval) return null;
    const msg = getKnownMessage(e.channelId, e.id);
    if (!msg) return null;
    const guildId = e.guildId || guildOf(e.channelId);
    const entry = check(msg, e.channelId, guildId);
    if (!entry || amlOwnsRetention(msg, e.channelId, guildId)) return null;
    retainGhostPing(msg, e.channelId, guildId, entry);
    return { type: "MESSAGE_LOGGER_BLOCKED", original: e, ghostPingLogger: true };
  }

  function onBulkDelete(e) {
    if (!Array.isArray(e.ids)) return null;
    const guildId = e.guildId || guildOf(e.channelId);
    const pass = [];
    const keptIds = [];
    for (const id of e.ids) {
      const msg = getKnownMessage(e.channelId, id);
      const entry = msg ? check(msg, e.channelId, guildId) : null;
      if (!entry || amlOwnsRetention(msg, e.channelId, guildId)) { pass.push(id); continue; }
      retainGhostPing(msg, e.channelId, guildId, entry);
      keptIds.push(id);
    }
    if (!keptIds.length) return null;
    if (!pass.length) return { type: "MESSAGE_LOGGER_BLOCKED", original: e, ghostPingLogger: true };
    return { ...e, ids: pass, loggerKept: keptIds, ghostPingLogger: true };
  }

  function paint(nodes, color) {
    if (!color || !Array.isArray(nodes)) return nodes;
    const out = [];
    let run = [];
    const flush = () => {
      if (!run.length) return;
      out.push({
        type: "link", target: "usernameOnClick",
        context: { username: "", usernameOnClick: { action: "0", userId: "0", linkColor: color, messageChannelId: "0" } },
        content: run,
      });
      run = [];
    };
    for (const node of nodes) {
      if (node && INLINE.has(node.type)) run.push(node);
      else { flush(); out.push(node); }
    }
    flush();
    return out;
  }

  const isOurs = (n) => !!n && typeof n === "object" && n.__gpl === 1;
  function decorate(row, input) {
    if (!row || !row.message) return;
    const message = row.message;
    if ((input && input.rowType !== undefined ? input.rowType : row.rowType) !== 1) return;
    const ping = retainedPings.has(String(message.id)) && !amlOwnsDeletedMessage(message.id);
    if (!ping) {
      if (message.__gplOut && message.content === message.__gplOut) message.content = message.__gplBase;
      else if (Array.isArray(message.content) && message.content.some(isOurs)) message.content = message.content.filter((n) => !isOurs(n));
      if (message.__gplNameBase) {
        message.colorString = message.__gplNameBase.colorString;
        message.usernameColor = message.__gplNameBase.usernameColor;
        delete message.__gplNameBase;
      }
      return;
    }
    const processColor = RN && RN.processColor;
    const red = processColor ? processColor(RED) : null;
    if (ping && processColor && red && cfg().redName !== false) {
      if (!message.__gplNameBase) message.__gplNameBase = { colorString: message.colorString, usernameColor: message.usernameColor };
      message.colorString = red;
      message.usernameColor = red;
      row.backgroundHighlight = { backgroundColor: processColor(RED + "26"), gutterColor: red };
    } else if (message.__gplNameBase) {
      message.colorString = message.__gplNameBase.colorString;
      message.usernameColor = message.__gplNameBase.usernameColor;
      delete message.__gplNameBase;
    }
    let base = message.__gplOut && message.content === message.__gplOut ? message.__gplBase : message.content;
    if (Array.isArray(base) && base.some(isOurs)) base = base.filter((n) => !isOurs(n));
    if (Array.isArray(base)) {
      const out = ping && red ? paint(base, red) : base;
      message.__gplBase = base;
      message.__gplOut = out;
      message.content = out;
    }
  }

  function patchRender() {
    let RowManager = findByName("RowManager");
    if (!RowManager || !RowManager.prototype) {
      try { RowManager = findByName("RowManager", false)?.default; } catch (_) {}
    }
    if (!RowManager || !RowManager.prototype || typeof RowManager.prototype.generate !== "function") {
      toast("Ghost Ping Logger: could not find the message renderer");
      return null;
    }
    return patcher.after("generate", RowManager.prototype, (args, result) => {
      try { decorate(result, args[0]); } catch (_) {}
    });
  }

  function hookDispatch(args) {
    const e = args[0];
    if (!e) return;
    try {
      if (e.loggerRemoval) return;
      if (e.type === "MESSAGE_CREATE") {
        rememberMessage(e.message);
        if (e.message && e.message.id) {
          receivedThisSession++;
          const channelId = e.message.channel_id || e.message.channelId;
          if (channelId) {
            receivedChannelsThisSession.add(String(channelId));
            if (isDM(getChannel(channelId))) receivedDMsThisSession++;
          }
        }
      }
      else if (e.type === "MESSAGE_UPDATE") rememberMessage(e.message, recentMessages.has(String(e.message && e.message.id)));
      else if (e.type === "LOCAL_MESSAGE_CREATE" && e.message && e.message.id) rememberMessage(e.message);
      else if (e.type === "MESSAGE_DELETE") {
        const result = onDelete(e);
        if (result) args[0] = result;
      }
      else if (e.type === "MESSAGE_DELETE_BULK") {
        if (Array.isArray(e.loggerKept) && e.loggerKept.length) handle(e.channelId, e.guildId, e.loggerKept, true);
        const result = onBulkDelete(e);
        if (result) args[0] = result;
      }
      else if (e.type === "MESSAGE_LOGGER_BLOCKED" && e.original && !e.ghostPingLogger) {
        const o = e.original;
        if (o.type === "MESSAGE_DELETE") handle(o.channelId, o.guildId, [o.id], true);
        else if (o.type === "MESSAGE_DELETE_BULK") handle(o.channelId, o.guildId, [].concat(o.ids || [], o.loggerKept || []), true);
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

  function dismissHistoryNavigation(navigation) { let current=navigation,depth=0; while(current&&depth++<8){try{if(current.canGoBack?.()){if(typeof current.popToTop==="function")current.popToTop();else current.goBack?.();}current=current.getParent?.();}catch(_){break;}} }
  function jumpTo(channelId,guildId,messageId,navigation){
    if(!channelId||!messageId||String(messageId).startsWith("test-"))return;
    const jump=(()=>{try{return findByProps("jumpToMessage");}catch(_){return null;}})();
    const navigate=(()=>{try{return findByProps("transitionToChannel");}catch(_){return null;}})();
    const perform=()=>{try{if(typeof jump?.jumpToMessage!=="function")throw Error();jump.jumpToMessage({channelId:String(channelId),messageId:String(messageId),flash:true,jumpType:"ANIMATED"});}catch(_){toast("Could not jump to this message");}};
    try{if(typeof navigate?.transitionToChannel!=="function")throw Error();dismissHistoryNavigation(navigation);navigate.transitionToChannel(String(channelId),{});setTimeout(perform,650);}catch(_){toast("Could not open this channel");}
  }
  function ask(title, message, buttons) {
    const ios = RN.Platform && RN.Platform.OS === "ios";
    const list = buttons.slice(0, ios ? 6 : 3);
    if (ios) list.push({ text: "Cancel", style: "cancel" });
    try { showDiscordAlert("gpl-confirm", title, message, list); } catch (_) {}
  }

  function showCaptureTest() {
    ask("Message capture test", "Since GPL started:\n" + receivedThisSession + " new message events\n" +
      receivedChannelsThisSession.size + " conversations/channels\n" + receivedDMsThisSession + " DM messages\n\n" +
      "Counts messages delivered by Discord while this plugin is running. Messages the app does not receive cannot be recorded.", [{ text: "OK" }]);
  }

  function showDiscordAlert(id, title, content, buttons) {
    const h = React.createElement;
    const alerts = findByProps("openAlert", "dismissAlert");
    const components = findByProps("AlertModal", "AlertActions", "AlertActionButton");
    if (!alerts || !components) throw new Error("Discord alert components unavailable");
    const actions = h(components.AlertActions, null, ...buttons.slice(0, 4).map((button, index) => h(components.AlertActionButton, {
      key: id + "-action-" + index, text: button.text,
      variant: button.style === "destructive" ? "destructive" : button.style === "cancel" ? "secondary" : "primary",
      onPress: button.onPress,
    })));
    alerts.openAlert(id, h(components.AlertModal, { title, content, actions }));
  }

  function openNativeInputAlert(props) {
    const api = findByProps("openAlert", "dismissAlert");
    if (!api || typeof api.openAlert !== "function") throw new Error("Discord alert API unavailable");
    api.openAlert(props.id, React.createElement(NativeInputAlert, props));
  }

  function NativeInputAlert(props) {
    const [value, setValue] = React.useState(String(props.initialValue || ""));
    const h = React.createElement;
    const parts = findByProps("AlertModal", "AlertActions", "AlertActionButton");
    const inputModule = findByProps("TextInput");
    const Input = inputModule && inputModule.TextInput;
    const dismiss = () => { try { findByProps("openAlert", "dismissAlert").dismissAlert(props.id); } catch (_) {} };
    const save = () => { dismiss(); if (typeof props.onSave === "function") props.onSave(value); };
    const field = Input
      ? h(Input, { value, onChange: setValue, keyboardType: props.keyboardType, placeholder: "", autoCapitalize: "none", autoCorrect: false })
      : h(RN.TextInput, { value, onChangeText: setValue, keyboardType: props.keyboardType, placeholder: "", autoCapitalize: "none", autoCorrect: false });
    const actions = h(parts.AlertActions, null,
      h(parts.AlertActionButton, { text: "Cancel", variant: "secondary", onPress: dismiss }),
      h(parts.AlertActionButton, { text: "Save", variant: "primary", onPress: save }));
    return h(parts.AlertModal, { title: props.title, content: props.content, extraContent: field, actions });
  }

  function palette() {
    let light = false;
    try { ThemeStore = ThemeStore || findByStoreName("ThemeStore"); light = !!ThemeStore && ThemeStore.theme === "light"; } catch (_) {}
    return light
      ? { text: "#060607", sub: "#5C5E66", bg: "#FFFFFF", card: "#F2F3F5", acc: "#5865F2", accPressed: "#4752C4", blurple: "#5865F2", card2: "rgba(0,0,0,0.045)", chip: "rgba(0,0,0,0.07)", press: "rgba(0,0,0,0.06)", divider: "rgba(0,0,0,0.09)", off: "#B5BAC1" }
      : { text: "#FFFFFF", sub: "#B5BAC1", bg: "#1E1F22", card: "#2B2D31", acc: "#5865F2", accPressed: "#4752C4", blurple: "#5865F2", card2: "rgba(255,255,255,0.06)", chip: "rgba(255,255,255,0.10)", press: "rgba(255,255,255,0.07)", divider: "rgba(255,255,255,0.09)", off: "#4E5058" };
}

  function settingsFormComponent(name) {
    let formModule = null;
    try { formModule = findByProps("Form", "FormSection"); } catch (_) {}
    const direct = (formModule && formModule[name]) || (ui.components && ui.components.Forms && ui.components.Forms[name]);
    if (typeof direct === "function" || direct && typeof direct === "object") return direct;
    try {
      const module = findByProps(name);
      const component = module && module[name];
      if (typeof component === "function" || component && typeof component === "object") return component;
    } catch (_) {}
    for (const searchExports of [false, true]) {
      try {
        const found = findByName(name, searchExports);
        const component = found && (found.default || found[name] || found);
        if (typeof component === "function" || component && typeof component === "object") return component;
      } catch (_) {}
    }
    return null;
  }

  function CustomSection(p){const C=palette();return React.createElement(RN.View,{style:{marginBottom:p.compact?14:22}},p.title?React.createElement(RN.Text,{style:{color:C.sub,fontSize:13,fontWeight:"700",letterSpacing:.4,marginHorizontal:5,marginBottom:9,textTransform:"uppercase"}},p.title):null,React.createElement(RN.View,{style:{backgroundColor:C.card,borderRadius:17,overflow:"hidden",borderWidth:1,borderColor:C.card2}},p.children));}
  function CustomRow(p){const C=palette();return React.createElement(RN.Pressable,{onPress:p.onPress,disabled:!p.onPress,style:({pressed})=>({minHeight:58,paddingHorizontal:15,paddingVertical:12,flexDirection:"row",alignItems:"center",backgroundColor:pressed?C.press:"transparent"})},p.icon?React.createElement(RN.Text,{style:{width:30,fontSize:18,color:C.sub,marginRight:7}},p.icon):null,React.createElement(RN.View,{style:{flex:1,minWidth:0,paddingRight:8}},React.createElement(RN.Text,{numberOfLines:1,style:{color:C.text,fontSize:16,fontWeight:"600"}},p.title),p.subtitle?React.createElement(RN.Text,{numberOfLines:2,style:{color:C.sub,fontSize:13,marginTop:3,lineHeight:18}},p.subtitle):null),p.trailing||null,!p.last?React.createElement(RN.View,{style:{position:"absolute",bottom:0,left:p.icon?52:15,right:0,height:1,backgroundColor:C.card2}}):null);}
  function CustomSwitch(p){const C=palette(),on=!!p.value,pos=React.useRef(new RN.Animated.Value(on?1:0)).current;React.useEffect(()=>{RN.Animated.spring(pos,{toValue:on?1:0,speed:22,bounciness:3,useNativeDriver:true}).start();},[on]);return React.createElement(RN.Pressable,{accessibilityRole:"switch",accessibilityState:{checked:on},onPress:()=>p.onChange(!on),hitSlop:8,style:{width:48,height:29,borderRadius:16,padding:3,justifyContent:"center",backgroundColor:on?C.blurple:C.off}},React.createElement(RN.Animated.View,{style:{width:23,height:23,borderRadius:12,backgroundColor:"#FFFFFF",elevation:1,transform:[{translateX:pos.interpolate({inputRange:[0,1],outputRange:[0,19]})}]}}));}
  function CustomAction(p){const C=palette();return React.createElement(RN.Pressable,{onPress:p.onPress,disabled:p.disabled,style:({pressed})=>({minHeight:48,borderRadius:13,alignItems:"center",justifyContent:"center",paddingHorizontal:16,marginTop:9,backgroundColor:p.secondary?C.chip:C.blurple,opacity:p.disabled?0.45:pressed?0.75:1})},React.createElement(RN.Text,{style:{color:"#FFFFFF",fontWeight:"700",fontSize:16}},p.title));}
  function CustomInput(p){const C=palette();return React.createElement(RN.TextInput,{...p,placeholderTextColor:C.sub,style:[{minHeight:48,borderRadius:13,borderWidth:1,borderColor:C.off,backgroundColor:C.bg,color:C.text,paddingHorizontal:14,fontSize:16},p.style]});}
  function Settings() {
    rainStore.useStore();
    const [screen, setScreen] = React.useState("main");
    const screenProgress = React.useRef(new RN.Animated.Value(1)).current;
    React.useEffect(() => { screenProgress.setValue(0); RN.Animated.timing(screenProgress, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }, [screen]);
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
    const C = palette();
    const h = React.createElement;
    const F = {
      TableRowGroup: settingsFormComponent("TableRowGroup"),
      TableRow: settingsFormComponent("TableRow"),
      TableSwitchRow: settingsFormComponent("TableSwitchRow"),
      FormSection: settingsFormComponent("FormSection"),
      FormRow: settingsFormComponent("FormRow"),
      FormSwitchRow: settingsFormComponent("FormSwitchRow"),
      FormSwitch: settingsFormComponent("FormSwitch"),
      FormDivider: settingsFormComponent("FormDivider"),
    };
    const nativeIconCache = new Map();
    const settingIcon = (key, label) => {
      const Icon = (F.TableRow && F.TableRow.Icon) || (F.FormRow && F.FormRow.Icon);
      if (!Icon || !ui.assets || typeof ui.assets.getAssetIDByName !== "function") return undefined;
      const cacheKey = String(key || "") + " " + String(label || "");
      if (nativeIconCache.has(cacheKey)) return nativeIconCache.get(cacheKey);
      const text = cacheKey.toLowerCase();
      const patterns = /color|redname|namecolor/.test(text) ? [/paint_brush/i, /palette/i, /color/i]
        : /separator/.test(text) ? [/more_vertical/i, /dots_vertical/i, /ellipsis_vertical/i, /more/i]
        : /notify.?edit|track.?edit/.test(text) ? [/edit/i, /pencil/i, /audit_update/i]
        : /time|clock/.test(text) ? [/clock/i, /time/i]
        : /deleted|delete|ghost|ping/.test(text) ? [/eye_hidden/i, /delete/i, /trash/i, /message/i]
        : /edit|edited/.test(text) ? [/edit/i, /pencil/i, /audit_update/i]
        : /ignore/.test(text) ? [/close_24px/i, /person/i, /ignore/i]
        : /bot/.test(text) ? [/close_24px/i, /bot/i]
        : /user/.test(text) ? [/person/i, /user/i]
        : /color/.test(text) ? [/paint_brush/i, /color/i, /palette/i]
        : /storage|save|persist|cache/.test(text) ? [/storage/i, /save/i, /database/i, /download/i]
        : /search|filter/.test(text) ? [/search/i, /filter/i]
        : /message|log/.test(text) ? [/message/i, /chat/i, /text/i]
        : /server|channel/.test(text) ? [/server/i, /channel/i]
        : null;
      let icon = null;
      try {
        const names = Object.keys(ui.assets.all || {});
        let name = null;
        if (patterns) for (const pattern of patterns) { name = names.find((candidate) => pattern.test(candidate)); if (name) break; }
        if (name) {
          const source = ui.assets.getAssetIDByName(name);
          if (source != null) icon = h(Icon, { source });
        }
      } catch (_) {}
      nativeIconCache.set(cacheKey, icon || undefined);
      return icon || undefined;
    };

    const rowSet=new WeakSet(),sectionTitles=new WeakMap(),mark=(el)=>{rowSet.add(el);return el;},HEXCOLOR=/^#[0-9A-Fa-f]{6}$/;
    const Text=(props,...kids)=>h(RN.Text,props,...kids),rowIcon=(key)=>/color/.test(key)?"\u25C9":/capture|cache|message|history|nav|log/.test(key)?"\u25F7":/filter|search/.test(key)?"\u2315":/ignore/.test(key)?"\u2298":"\u2726";
    const Section=(title)=>{const m=h(RN.View,{key:"sec-"+title});sectionTitles.set(m,title);return m;};
    const valueChip=(r)=>{if(!r)return null;if(r===">"||r==="\u203A")return Text({style:{color:C.sub,fontSize:21,marginLeft:7}},"\u203A");const v=String(r);if(HEXCOLOR.test(v))return h(RN.View,{style:{flexDirection:"row",alignItems:"center",marginLeft:8}},h(RN.View,{style:{width:18,height:18,borderRadius:9,backgroundColor:v,borderWidth:1,borderColor:C.divider}}),Text({style:{color:C.sub,fontSize:13,marginLeft:8}},v));return Text({style:{color:C.sub,fontSize:14,marginLeft:8},numberOfLines:1},v);};
    const PressRow=(key,label,sub,onPress,right)=>mark(h(CustomRow,{key,title:label,subtitle:sub,onPress,trailing:valueChip(right)}));
    const switchRow=(key,label,sub,value,change)=>mark(h(CustomRow,{key,title:label,subtitle:sub,trailing:h(CustomSwitch,{value,onChange:change})}));
    const Btn=(key,title,onPress,color)=>mark(h(CustomAction,{key,title:key==="back"?"\u2039  Back":title,onPress,secondary:key!=="clear"&&key!=="test",danger:color===RED}));
    const Empty=(key,t)=>Text({key,style:{color:C.sub,fontSize:14,lineHeight:20,paddingHorizontal:14,paddingVertical:14,textAlign:"center"}},t),Title=(key,t)=>Text({key,style:{color:C.text,fontSize:22,fontWeight:"800",paddingTop:8,paddingBottom:8}},t);
    const compose=(list)=>{const out=[];let run=[],title=null,n=0;const flush=()=>{if(!run.length){if(title)out.push(h(CustomSection,{key:"section-"+n++,title}));title=null;return;}const rows=run.map((r,i)=>React.cloneElement(r,{last:i===run.length-1}));out.push(h(CustomSection,{key:"section-"+n++,title},...rows));run=[];title=null;};for(const el of list){if(el&&sectionTitles.has(el)){flush();title=sectionTitles.get(el);}else if(el&&rowSet.has(el))run.push(el);else{flush();if(el)out.push(el);}}flush();return out;};
    const Switch = (key, label, sub, onChange) => {
      const value = !!cfg()[key];
      const change = onChange || ((v) => { cfg()[key] = v; refreshUI(); });
      return switchRow(key, label, sub, value, change);
    };

    const retentionLabel = () => (cfg().retentionDays === 7 ? "7 days" : cfg().retentionDays === 30 ? "30 days" : "Forever");
    const captureModeLabel = () => cfg().captureMode === "expanded" ? "All new messages" : "Loaded messages";
    const captureModeDescription = () => cfg().captureMode === "expanded"
      ? "Save messages delivered while other chats are open."
      : "Save messages already loaded in the open chat.";
    const cycleCaptureMode = () => {
      cfg().captureMode = cfg().captureMode === "expanded" ? "loaded" : "expanded";
      if (cfg().captureMode === "loaded") clearRecentMessages();
      if (cfg().captureMode === "loaded") { cfg().receivedMessages = []; recentArchiveDirty = false; if (recentArchiveTimer) { clearTimeout(recentArchiveTimer); recentArchiveTimer = null; } }
      refreshUI();
    };
    const editRecentMessageLimit = () => {
      const saveLimit = (value) => {
        const count = Number(String(value || "").trim());
        if (!Number.isInteger(count) || count < MIN_RECENT_MESSAGES || count > MAX_RECENT_MESSAGES) {
          ask("Invalid message limit", "Enter a whole number from " + MIN_RECENT_MESSAGES + " to " + MAX_RECENT_MESSAGES + ".", [{ text: "OK" }]);
          return;
        }
        cfg().maxCachedMessages = count;
        trimRecentMessages();
        refreshUI();
      };
      try {
        openNativeInputAlert({ id: "gpl-cache-limit", title: "Maximum cached messages", content: "Messages received by Discord · approx. 8 MiB cache budget", initialValue: recentMessageLimit(), keyboardType: "number-pad", onSave: saveLimit });
      } catch (_) { toast("Could not open cache limit settings"); }
    };
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
        Title("title", "Ghost pings (" + pings.length + ")"),
      ];
      if (pings.length) {
        content.push(Btn("clear", "Clear history", () => {
          ask("Clear ghost ping history?", "This removes every saved ghost ping.", [
            { text: "Clear", style: "destructive", onPress: () => { pings = []; save(); refreshUI(); } },
          ]);
        }, RED));
      } else {
        content.push(Empty("empty", "No ghost pings yet."));
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
        Switch("trackEveryone", "Track @everyone", "Include messages that mention everyone in this server.", (v) => { cfg().trackEveryone = v; refreshUI(); }),
        Switch("pingReplies", "Replies", "Replies to your messages"),
        Switch("skipBots", "Ignore bots", "Do not report deleted bot messages"),
        Section("Alerts"),
        Switch("showToast", "Show ghost ping alert", "Show a modal with Jump to message and Dismiss"),
        Switch("redName", "Red usernames on ghost pings", "Color the sender name with the ghost ping message", (v) => { cfg().redName = v; refreshGhostRows(); refreshUI(); }),
        Section("Message capture"),
        PressRow("capture-mode", "Capture mode", captureModeDescription(), cycleCaptureMode, captureModeLabel()),
        Switch("rememberReceivedMessages", "Remember new messages", "Save new messages received by Discord on this device across restarts.", (v) => {
          cfg().rememberReceivedMessages = v;
          if (!v) { recentArchiveIds.clear(); cfg().receivedMessages = []; recentArchiveDirty = false; if (recentArchiveTimer) { clearTimeout(recentArchiveTimer); recentArchiveTimer = null; } }
          else scheduleRecentArchiveSave();
          refreshUI();
        }),
        PressRow("test-capture", "Test message capture", "Count new messages since this plugin started", showCaptureTest, ">"),
        PressRow("cache-limit", "Maximum cached messages", "Delivered messages only · capped recent cache", editRecentMessageLimit, String(recentMessageLimit())),
        Section("History"),
        PressRow("nav", "Ghost ping history", pings.length + " saved", () => { setLimit(PAGE); setScreen("history"); }, ">"),
        PressRow("retention", "Keep history for", "Older entries are removed automatically", cycleRetention, retentionLabel()),
        Btn("test", "Send a test ghost ping", () => { addTestPing(); refreshUI(); }),
      ];
    }
    const buildLabel = Text({ key: "build", style: { color: C.sub, fontSize: 12, textAlign: "center", marginTop: 1 } }, "Ghost Ping Logger " + BUILD);
    const header = screen === "main" ? [Text({ key: "header-title", style: { color: C.text, fontSize: 25, fontWeight: "800", marginBottom: 5 } }, "Ghost Ping Logger"), Text({ key: "header-subtitle", style: { color: C.sub, fontSize: 14, marginBottom: 20 } }, "Review deleted pings and message capture")] : [];
    return h(RN.Animated.View, { style: { flex: 1, opacity: screenProgress, transform: [{ translateY: screenProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] } }, h(RN.ScrollView, { key: screen, style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 42 } }, ...header, ...compose(content), buildLabel));
  }

  function onLoad() {
    receivedThisSession = 0;
    receivedDMsThisSession = 0;
    receivedChannelsThisSession.clear();
    const s = cfg();
    const defaults = { enabled: true, pingMentions: true, trackEveryone: false, pingReplies: true, skipBots: true, showToast: true, retentionDays: 0, captureMode: "expanded", maxCachedMessages: DEFAULT_RECENT_MESSAGES, rememberReceivedMessages: true, redName: true };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (s.captureMode !== "loaded" && s.captureMode !== "expanded") s.captureMode = "expanded";

    if (!loadStores()) { toast("Ghost Ping Logger: required Discord modules not found"); return; }
    clearRecentMessages();
    restoreRecentArchive();
    retainedPings.clear();
    try { pings = Array.isArray(s.pings) ? JSON.parse(JSON.stringify(s.pings)) : []; } catch (_) { pings = []; }
    if (purge()) save();

    try { unpatches.push(patcher.before("dispatch", FluxDispatcher, hookDispatch)); } catch (_) { return; }
    try { renderUnpatch = patchRender(); } catch (_) {}
    try {
      globalThis[GPL_ALERT_BRIDGE_KEY] = {
        active: true,
        willShowDeleteAlert,
      };
    } catch (_) {}
    try {
      appStateSub = RN.AppState.addEventListener("change", (state) => { if (state === "active" && purge()) save(); else if (state !== "active") flushRecentArchive(); });
    } catch (_) {}
  }

  function onUnload() {
    flushRecentArchive();
    for (const u of unpatches.splice(0)) { try { u(); } catch (_) {} }
    if (renderUnpatch) { try { renderUnpatch(); } catch (_) {} renderUnpatch = null; }
    if (appStateSub && appStateSub.remove) { try { appStateSub.remove(); } catch (_) {} }
    appStateSub = null;
    try {
      const bridge = globalThis[GPL_ALERT_BRIDGE_KEY];
      if (bridge && bridge.willShowDeleteAlert === willShowDeleteAlert) delete globalThis[GPL_ALERT_BRIDGE_KEY];
    } catch (_) {}
    alertedPings.clear();
    lastSettingsNavigation = null;
    clearRecentMessages();
    retainedPings.clear();
    pings = [];
  }

  return { onLoad, onUnload, settings: Settings };
})();

// @ts-ignore Discord evaluates this file as a CommonJS plugin entry.
module.exports = {
  start() { implementation.onLoad(); },
  stop() { implementation.onUnload(); },
  settings: implementation.settings,
};
