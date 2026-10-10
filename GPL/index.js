(() => {
  "use strict";
  const { metro, patcher, plugin, ui } = vendetta;
  const vstorage = vendetta.storage;
  const { findByName, findByProps, findByStoreName } = metro;
  const { FluxDispatcher, React, ReactNative: RN } = metro.common;

  const MAX_PINGS = 200;
  const DEFAULT_RECENT_MESSAGES = 200;
  const MIN_RECENT_MESSAGES = 100;
  const MAX_RECENT_MESSAGES = 20000;
  const MAX_SNIPPET = 300;
  const BUILD = "v2.0.0";
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

  const cfg = () => plugin.storage;
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
  function rememberMessage(message) {
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
      mentioned: typeof merged.mentioned === "boolean" ? merged.mentioned : previous && previous.mentioned,
      messageReference: reference ? {
        message_id: reference.message_id || reference.messageId,
        channel_id: reference.channel_id || reference.channelId || String(channelId),
      } : previous && previous.messageReference,
      referencedMessage: embedded && embedded.author ? { message: { author: { id: embedded.author.id } } } : previous && previous.referencedMessage,
    };
    recentMessages.delete(snapshot.id);
    recentMessages.set(snapshot.id, snapshot);
    while (recentMessages.size > recentMessageLimit()) recentMessages.delete(recentMessages.keys().next().value);
  }
  function recentMessageLimit() {
    const value = Number(cfg().maxCachedMessages);
    if (!Number.isFinite(value)) return DEFAULT_RECENT_MESSAGES;
    return Math.max(MIN_RECENT_MESSAGES, Math.min(MAX_RECENT_MESSAGES, Math.round(value)));
  }
  // Collects every full message from an event payload (single message, lists, nested lists
  // such as search results, or pin entries) into the all-channels cache.
  function harvest(value, depth) {
    if (!value || typeof value !== "object" || depth > 3) return;
    if (Array.isArray(value)) { for (const v of value) harvest(v, depth + 1); return; }
    if (typeof value.id === "string" && value.author && typeof value.author === "object") { rememberMessage(value); return; }
    harvest(value.message, depth + 1);
    harvest(value.messages, depth + 1);
    harvest(value.pins, depth + 1);
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
      style: { minHeight: 46, paddingHorizontal: 18, borderRadius: 14, marginLeft: primary ? 10 : 0, alignItems: "center", justifyContent: "center", backgroundColor: primary ? "#5865F2" : "rgba(128,128,128,0.22)" },
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
      React.createElement(RN.Text, { style: { color: colors.sub, fontSize: 14, marginBottom: 16 } }, "All Channels mode only. Higher values use more memory. Keeps messages Discord sends or loads while Kettu runs; no history is fetched."),
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
    const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message that mentioned you";
    const colors = palette();
    const h = React.createElement;
    const dark = colors.text === "#FFFFFF";
    const btn = (label, onPress, primary) => h(RN.Pressable, {
      key: label, onPress, accessibilityRole: "button",
      style: ({ pressed }) => ({ flex: 1, minHeight: 48, borderRadius: 14, alignItems: "center", justifyContent: "center", marginLeft: primary ? 10 : 0, backgroundColor: primary ? (pressed ? "#4752C4" : "#5865F2") : (pressed ? "rgba(128,128,128,0.32)" : "rgba(128,128,128,0.22)") }),
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
    const what = entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message that mentioned you";
    const isTest = String(entry.id).startsWith("test-");
    const buttons = [];
    if (!isTest) buttons.push({ text: "Dismiss", style: "cancel" });
    buttons.push({ text: isTest ? "Close" : "Jump to message", onPress: () => {
      if (!isTest) setTimeout(() => jumpTo(entry.c, entry.g, entry.id, lastSettingsNavigation), 180);
    } });
    const message = String(entry.an || "Unknown") + " " + what + ":\n\n" + (entry.t || "(no message text)");
    try {
      RN.Alert.alert("Ghost ping", message, buttons, { cancelable: true });
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
      if (e.type === "MESSAGE_CREATE") rememberMessage(e.message);
      else if (e.type === "MESSAGE_UPDATE") rememberMessage(e.message);
      else if (e.type === "LOAD_MESSAGES_SUCCESS" || e.type === "LOAD_MESSAGES_SUCCESS_CACHED" || e.type === "LOAD_RECENT_MENTIONS_SUCCESS" ||
        e.type === "LOAD_PINNED_MESSAGES_SUCCESS" || e.type === "SEARCH_FINISH") harvest(e, 0);
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
              const performMessageJump = () => {
                try {
                  actions.jumpToMessage({ channelId, messageId: real, flash: true, jumpType: "INSTANT" });
                  return true;
                } catch (_) {
                  try { actions.jumpToMessage(channelId, real, true); return true; }
                  catch (_) { toast("Kettu could not jump to that message"); return false; }
                }
              };
              const jumpWhenMessageIsReady = (attemptsLeft) => {
                if (getMessage(channelId, real)) {
                  // The first jump requests older history; repeat after the
                  // target enters MessageStore so the list can scroll to it.
                  return setTimeout(performMessageJump, 180);
                }
                if (attemptsLeft > 0) return setTimeout(() => jumpWhenMessageIsReady(attemptsLeft - 1), 150);
                toast("The message did not load yet. Open the channel and try Jump to message again.");
              };
              const jumpWhenChannelIsReady = (attemptsLeft) => {
                if (String(currentChannelId() || "") !== String(channelId)) {
                  if (attemptsLeft > 0) return setTimeout(() => jumpWhenChannelIsReady(attemptsLeft - 1), 160);
                  toast("The channel did not open in time. Try Jump to message again.");
                  return;
                }
                if (performMessageJump()) jumpWhenMessageIsReady(80);
              };
              jumpWhenChannelIsReady(75);
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
    return light
      ? { text: "#060607", sub: "#5C5E66", acc: "#4752C4", blurple: "#5865F2", card2: "rgba(0,0,0,0.045)", chip: "rgba(0,0,0,0.07)", press: "rgba(0,0,0,0.06)", divider: "rgba(0,0,0,0.09)", off: "#B5BAC1" }
      : { text: "#FFFFFF", sub: "#B5BAC1", acc: "#8EA1FF", blurple: "#5865F2", card2: "rgba(255,255,255,0.06)", chip: "rgba(255,255,255,0.10)", press: "rgba(255,255,255,0.07)", divider: "rgba(255,255,255,0.09)", off: "#4E5058" };
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
    const C = palette();
    const h = React.createElement;
    const F = {
      FormSection: settingsFormComponent("FormSection"),
      FormRow: settingsFormComponent("FormRow"),
      FormSwitchRow: settingsFormComponent("FormSwitchRow"),
      FormDivider: settingsFormComponent("FormDivider"),
    };

    const rowSet = new WeakSet();
    const mark = (el) => { rowSet.add(el); return el; };
    const sectionTitles = new WeakMap();
    const HEXCOLOR = /^#[0-9A-Fa-f]{6}$/;
    const Text = (props, ...kids) => h(RN.Text, props, ...kids);
    const rowStyle = ({ pressed }) => ({ paddingHorizontal: 16, paddingVertical: 13, minHeight: 56, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? C.press : "transparent" });
    const rowText = (label, sub) => h(RN.View, { style: { flex: 1 } },
      Text({ style: { color: C.text, fontSize: 16, fontWeight: "500" }, numberOfLines: 4 }, label),
      sub ? Text({ style: { color: C.sub, fontSize: 13, lineHeight: 18, marginTop: 2 }, numberOfLines: 4 }, sub) : null);

    const Section = (title) => {
      const marker = h(RN.View, { key: "sec-" + title });
      sectionTitles.set(marker, title);
      return marker;
    };

    const valueChip = (right, rightColor) => {
      if (!right) return null;
      if (right === ">" || right === "\u203A") return Text({ style: { color: C.sub, fontSize: 24, marginLeft: 8 } }, "\u203A");
      if (right === "Selected") return Text({ style: { color: C.acc, fontSize: 20, fontWeight: "700", marginLeft: 8 } }, "\u2713");
      if (HEXCOLOR.test(right)) {
        return h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginLeft: 8 } },
          h(RN.View, { style: { width: 22, height: 22, borderRadius: 11, backgroundColor: right, borderWidth: 2, borderColor: C.divider } }),
          Text({ style: { color: C.sub, fontSize: 13, marginLeft: 8 } }, right));
      }
      return h(RN.View, { style: { marginLeft: 8, paddingHorizontal: 12, paddingVertical: 6, borderRadius: 14, backgroundColor: C.chip, maxWidth: "50%" } },
        Text({ style: { color: rightColor || C.text, fontSize: 14, fontWeight: "600" }, numberOfLines: 2 }, right));
    };

    const PressRow = (key, label, sub, onPress, right, rightColor) => mark(
      F && F.FormRow
        ? h(F.FormRow, { key, label, subLabel: sub, onPress, trailing: valueChip(right, rightColor) })
        : h(RN.Pressable, { key, onPress, accessibilityRole: "button", style: rowStyle },
          rowText(label, sub), valueChip(right, rightColor)));

    const switchRow = (key, label, sub, value, change) => mark(
      F && F.FormSwitchRow
        ? h(F.FormSwitchRow, { key, label, subLabel: sub, value, onValueChange: change })
        : h(RN.Pressable, { key, onPress: () => change(!value), accessibilityRole: "button", style: rowStyle },
          h(RN.View, { style: { flex: 1, paddingRight: 12 } },
            Text({ style: { color: C.text, fontSize: 16, fontWeight: "500" } }, label),
            sub ? Text({ style: { color: C.sub, fontSize: 13, lineHeight: 18, marginTop: 2 } }, sub) : null),
          h(RN.Switch, { value, onValueChange: change, trackColor: { false: C.off, true: C.blurple }, thumbColor: "#FFFFFF", ios_backgroundColor: C.off })));

    const Btn = (key, title, onPress, color) => {
      const label = key === "back" ? "‹  Back" : title;
      if (F.FormRow) return mark(h(F.FormRow, { key, label, onPress }));
      return mark(h(RN.Pressable, { key, onPress, accessibilityRole: "button", style: rowStyle }, rowText(label, null)));
    };

    const Empty = (key, text) => Text({ key, style: { color: C.sub, fontSize: 14, lineHeight: 20, paddingHorizontal: 16, paddingVertical: 12 } }, text);

    const Title = (key, text) => Text({ key, style: { color: C.text, fontSize: 20, fontWeight: "700", paddingHorizontal: 16, paddingTop: 12, paddingBottom: 6 } }, text);

    // Rows that sit next to each other are grouped into one rounded card with dividers.
    const compose = (list) => {
      const out = [];
      let run = [];
      let title = null;
      let groupIndex = 0;
      const nativeSections = F && F.FormSection;
      const sectionHeader = (name) => h(RN.View, { key: "sec-title-" + groupIndex++, style: { paddingHorizontal: 30, paddingTop: 24, paddingBottom: 6 } },
        Text({ style: { color: C.acc, fontSize: 12, fontWeight: "700", letterSpacing: 0.8 } }, name.toUpperCase()));
      const flush = () => {
        if (!run.length) {
          if (title) out.push(sectionHeader(title));
          title = null;
          return;
        }
        if (nativeSections) {
          const nativeRows = [];
          run.forEach((row, index) => {
            if (index && F.FormDivider) nativeRows.push(h(F.FormDivider, { key: "form-divider-" + groupIndex++ }));
            nativeRows.push(row);
          });
          out.push(h(F.FormSection, { key: "form-section-" + groupIndex++, title: title || undefined }, ...nativeRows));
          run = [];
          title = null;
          return;
        }
        if (title) out.push(sectionHeader(title));
        out.push(...run);
        run = [];
        title = null;
      };
      for (const el of list) {
        if (el && sectionTitles.has(el)) { flush(); title = sectionTitles.get(el); }
        else if (el && rowSet.has(el)) run.push(el);
        else { flush(); if (el) out.push(el); }
      }
      flush();
      return out;
    };

    const Switch = (key, label, sub, onChange) => {
      const value = !!cfg()[key];
      const change = onChange || ((v) => { cfg()[key] = v; refreshUI(); });
      return switchRow(key, label, sub, value, change);
    };

    const retentionLabel = () => (cfg().retentionDays === 7 ? "7 days" : cfg().retentionDays === 30 ? "30 days" : "Forever");
    const captureModeLabel = () => cfg().captureMode === "expanded" ? "All Channels" : "Loaded Only";
    const captureModeDescription = () => cfg().captureMode === "expanded"
      ? "Higher memory use; captures messages Discord delivers from channels you have not opened. Does not fetch channel history."
      : "Lowest resource use; check only messages already loaded by Discord";
    const cycleCaptureMode = () => {
      cfg().captureMode = cfg().captureMode === "expanded" ? "loaded" : "expanded";
      if (cfg().captureMode === "loaded") recentMessages.clear();
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
        while (recentMessages.size > count) recentMessages.delete(recentMessages.keys().next().value);
        refreshUI();
      };
      if (RN.Alert && typeof RN.Alert.prompt === "function") {
        RN.Alert.prompt("Maximum cached messages", "All Channels mode only. Higher values use more memory.", saveLimit, "plain-text", String(recentMessageLimit()), "number-pad");
        return;
      }
      try {
        ui.alerts.showCustomAlert(MessageCacheLimitModal, {
          initialValue: recentMessageLimit(),
          onSave: saveLimit,
        });
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
        Switch("pingReplies", "Replies", "Replies to your messages"),
        Switch("skipBots", "Ignore bots", "Do not report deleted bot messages"),
        Section("Alerts"),
        Switch("showToast", "Show ghost ping alert", "Show a modal with Jump to message and Dismiss"),
        Switch("redName", "Red usernames on ghost pings", "Color the sender name with the ghost ping message", (v) => { cfg().redName = v; refreshGhostRows(); refreshUI(); }),
        Section("Message capture"),
        PressRow("capture-mode", "Capture mode", captureModeDescription(), cycleCaptureMode, captureModeLabel()),
        PressRow("cache-limit", "Maximum cached messages", "All Channels mode only · held in memory", editRecentMessageLimit, String(recentMessageLimit())),
        Section("History"),
        PressRow("nav", "Ghost ping history", pings.length + " saved", () => { setLimit(PAGE); setScreen("history"); }, ">"),
        PressRow("retention", "Keep history for", "Older entries are removed automatically", cycleRetention, retentionLabel()),
        Btn("test", "Send a test ghost ping", () => { addTestPing(); refreshUI(); }),
      ];
    }
    return h(RN.ScrollView, { key: screen, contentContainerStyle: { paddingBottom: 24 } }, ...compose(content));
  }

  function onLoad() {
    const s = cfg();
    const defaults = { enabled: true, pingMentions: true, pingReplies: true, skipBots: true, showToast: true, retentionDays: 0, captureMode: "expanded", maxCachedMessages: DEFAULT_RECENT_MESSAGES, redName: true };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (s.captureMode !== "loaded" && s.captureMode !== "expanded") s.captureMode = "expanded";

    if (!loadStores()) { toast("Ghost Ping Logger: required Discord modules not found"); return; }
    recentMessages.clear();
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
      appStateSub = RN.AppState.addEventListener("change", (state) => { if (state === "active" && purge()) save(); });
    } catch (_) {}
  }

  function onUnload() {
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
    recentMessages.clear();
    retainedPings.clear();
    pings = [];
  }

  return { onLoad, onUnload, settings: Settings };
})()
