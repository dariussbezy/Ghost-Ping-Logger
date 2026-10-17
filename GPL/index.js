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
  const DEFAULT_RECENT_MESSAGES = 1000;
  const MIN_RECENT_MESSAGES = 100;
  const MAX_RECENT_MESSAGES = 20000;
  const MAX_RECENT_CACHE_BYTES = 8 * 1024 * 1024;
  const RECENT_ARCHIVE_SAVE_DELAY = 30000;
  const MAX_SNIPPET = 300;
  const BUILD = "v1.0.0";
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
  const knownPingCandidates = new Map();
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
  let GuildMemberStore;
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
  function amlOwnsRecentCache() {
    try {
      const bridge = globalThis[AML_BRIDGE_KEY];
      return !!(bridge && bridge.active && typeof bridge.ownsRecentCache === "function" && bridge.ownsRecentCache());
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
    const channel = getChannel(channelId);
    if (!isDM(channel) && !pingKindFor(message, channelId)) return;
    if (amlOwnsRecentCache()) return;
    const previous = recentMessages.get(String(message.id));
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
      mentionRoles: Array.isArray(merged.mention_roles) ? merged.mention_roles.map(String) : Array.isArray(merged.mentionRoles) ? merged.mentionRoles.map(String) : previous && previous.mentionRoles || [],

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
    const candidate = knownPingCandidates.get(String(id));
    if (candidate && String(candidate.channel_id) === String(channelId)) return candidate;
    const cached = getMessage(channelId, id);
    if (cached) return cached;
    try {
      const bridge = globalThis[AML_BRIDGE_KEY];
      if (bridge && bridge.active && amlOwnsRecentCache() && typeof bridge.getKnownMessage === "function") {
        const shared = bridge.getKnownMessage(channelId, id);
        if (shared && (!shared.channel_id || String(shared.channel_id) === String(channelId))) return shared;
      }
    } catch (_) {}
    if (cfg().captureMode === "expanded") {
      const recent = recentMessages.get(String(id));
      if (recent && String(recent.channel_id) === String(channelId)) return recent;
    }
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

  function showPingAlert(entry) {
    const what = entry.status === "edited"
      ? entry.k === "dm" ? "edited a message in your DM to remove a ping" : entry.k === "reply" ? "edited a reply to you to remove its ping" : "edited a message to remove a mention"
      : entry.k === "dm" ? "deleted a message in your DM" : entry.k === "reply" ? "deleted a reply to you" : "deleted a message with a mention";
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
    const ref = msg.messageReference || msg.message_reference || msg.reference;
    if (!ref) return false;
    const refId = ref.message_id || ref.messageId;
    const refChannel = ref.channel_id || ref.channelId || channelId;
    const target = refId ? getKnownMessage(refChannel, refId) : null;
    if (target && target.author && target.author.id === me) return true;
    const embedded = msg.referencedMessage && (msg.referencedMessage.message || msg.referencedMessage);
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

  function mentionsMyRole(msg, channelId) {
    const roles = msg.mention_roles || msg.mentionRoles;
    if (!Array.isArray(roles) || !roles.length) return false;
    try {
      GuildMemberStore = GuildMemberStore || findByStoreName("GuildMemberStore");
      const guildId = msg.guild_id || msg.guildId || guildOf(channelId);
      const member = guildId && GuildMemberStore && GuildMemberStore.getMember(guildId, myId());
      const mine = member && member.roles;
      return !!mine && roles.some((role) => mine.includes(String(role)));
    } catch (_) { return false; }
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
    if (!kind && s.trackEveryone && (msg.mention_everyone === true || msg.mentionEveryone === true || mentionsMyRole(msg, channelId))) kind = "mention";
    return kind;
  }

  function willShowDeleteAlert(msg, channelId, guildId, id) {
    if (!cfg().showToast) return false;
    if (id != null && alertedPings.has(String(id))) return true;
    return !!pingKindFor(msg, channelId);
  }

  function check(msg, channelId, guildId, status) {
    const kind = pingKindFor(msg, channelId);
    if (!kind) return null;
    const existing = pings.find((p) => String(p.id) === String(msg.id));
    if (existing) return existing;
    return addPing({
      id: msg.id, c: channelId, g: guildId || null, ai: msg.author.id, an: nameOf(msg.author),
      t: clip(msg.content, MAX_SNIPPET), k: kind, status: status || "deleted", at: Date.now(),
    });
  }

  function checkEditedPing(previous, update, channelId, guildId) {
    if (!previous || !update || !previous.id || !previous.author) return;
    const oldKind = pingKindFor(previous, channelId);
    if (!oldKind || String(previous.id) === String(update.id) && pings.some((entry) => String(entry.id) === String(update.id))) return;
    const changedContent = typeof update.content === "string" && update.content !== previous.content;
    const hasMentionsField = Object.prototype.hasOwnProperty.call(update, "mentions");
    const hasEveryoneField = Object.prototype.hasOwnProperty.call(update, "mention_everyone") || Object.prototype.hasOwnProperty.call(update, "mentionEveryone");
    const hasReferenceField = Object.prototype.hasOwnProperty.call(update, "message_reference") || Object.prototype.hasOwnProperty.call(update, "messageReference") || Object.prototype.hasOwnProperty.call(update, "reference");
    const merged = { ...previous, ...update };
    if (changedContent && !hasMentionsField) {
      const me = myId();
      const content = String(update.content || "");
      merged.mentions = me && (content.includes("<@" + me + ">") || content.includes("<@!" + me + ">")) ? [me] : [];
      merged.mentioned = false;
    }
    if (changedContent && !hasEveryoneField) merged.mention_everyone = /@everyone|@here/i.test(String(update.content || ""));
    if (changedContent && !hasReferenceField && !previous.messageReference && !previous.message_reference && !previous.reference) merged.messageReference = null;
    if (pingKindFor(merged, channelId)) return;
    const existing = pings.find((entry) => String(entry.id) === String(previous.id));
    if (existing) return;
    return addPing({
      id: previous.id, c: channelId, g: guildId || null, ai: previous.author.id, an: nameOf(previous.author),
      t: clip(previous.content, MAX_SNIPPET), k: oldKind, status: "edited", at: Date.now(),
    });
  }

  function rememberPingCandidate(message, channelId, guildId) {
    if (!message || !message.id || !channelId) return;
    const snapshot = { ...message, channel_id: String(channelId), guild_id: guildId || message.guild_id || message.guildId || null };
    if (pingKindFor(snapshot, channelId)) {
      knownPingCandidates.delete(String(message.id));
      knownPingCandidates.set(String(message.id), snapshot);
      while (knownPingCandidates.size > MAX_PINGS * 12) knownPingCandidates.delete(knownPingCandidates.keys().next().value);
    } else {
      knownPingCandidates.delete(String(message.id));
    }
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
        const created = e.message;
        if (created) rememberPingCandidate(created, created.channel_id || created.channelId, created.guild_id || created.guildId || e.guildId);
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
      else if (e.type === "MESSAGE_UPDATE") {
        const update = e.message;
        const channelId = e.channelId || update && (update.channel_id || update.channelId);
        const guildId = e.guildId || update && (update.guild_id || update.guildId) || guildOf(channelId);
        const previous = update && channelId && getKnownMessage(channelId, update.id);
        if (previous) checkEditedPing(previous, update, channelId, guildId);
        if (update) rememberPingCandidate(previous ? { ...previous, ...update } : update, channelId, guildId);
        rememberMessage(update, recentMessages.has(String(update && update.id)));
      }
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
      t: "This is a test ghost ping.", k: "mention", status: "test", at: Date.now(),
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

  /* ---- shared settings design kit (identical in AML / GPL / QT) ---- */
  const KIT_TILES = {
    lang: ["LanguageIcon", "\u6587", "#5865F2"], paint: ["PaintPaletteIcon", "\u25C9", "#EB459E"], time: ["ClockIcon", "\u25F7", "#E58A00"],
    store: ["ClipboardListIcon", "\u25A3", "#3BA55D"], trash: ["TrashIcon", "\u232B", "#ED4245"], edit: ["PencilIcon", "\u270E", "#F07B3E"],
    shield: ["ShieldIcon", "\u2298", "#80848E"], bell: ["BellIcon", "!", "#E58A00"], at: ["BellIcon", "@", "#ED4245"],
    reply: ["ChatMarkUnreadIcon", "\u21A9", "#5865F2"], search: ["CompassIcon", "\u2315", "#1ABC9C"], chat: ["ChatMarkUnreadIcon", "\u25A4", "#5865F2"],
    plus: ["PlusSmallIcon", "+", "#5865F2"], link: ["LinkIcon", "\u2197", "#3498DB"], test: ["WrenchIcon", "\u25B7", "#9B59B6"],
    star: ["StarIcon", "\u2605", "#D99700"], server: ["PinIcon", "\u25C7", "#3498DB"], power: ["SettingsIcon", "\u25CF", "#43B581"],
    text: ["PencilIcon", "Aa", "#F07B3E"], guide: ["ClipboardCheckIcon", "?", "#5865F2"], gear: ["SettingsIcon", "\u2022", "#80848E"]
  };
  const KIT_RULES = [
    [/^(default|red|orange|gold|green|teal|blue|indigo|purple|pink|gray)$/i, null],
    [/^ghost ping logger$/i, "power"], [/color|appearance/, "paint"], [/notify|alert|toast/, "bell"], [/test/, "test"],
    [/button|position|composer/, "plus"], [/clear|remove/, "trash"],
    [/clock|time|history|retention|keep .* for/, "time"], [/quick|favorite|saved/, "star"],
    [/cache|storage|persist|remember|restart|across/, "store"],
    [/deleted|delete/, "trash"], [/edit/, "edit"], [/ignore/, "shield"], [/mention|everyone|ping/, "at"],
    [/reply|replies/, "reply"], [/filter|search/, "search"], [/jump/, "link"],
    [/translate|translation|google|deepl|language/, "lang"], [/word|term/, "text"], [/server|guild/, "server"],
    [/capture|message|channel|dm/, "chat"], [/enabled|logger/, "power"]
  ];
  const kitAssetCache = new Map();
  function kitAsset(name) {
    const hit = kitAssetCache.get(name);
    if (hit && (hit.id || Date.now() - hit.at < 5000)) return hit.id;
    let id = null;
    try { const r = globalThis.rain; id = (r && r.api && r.api.assets && r.api.assets.findAssetId && r.api.assets.findAssetId(name)) || null; } catch (_) { id = null; }
    kitAssetCache.set(name, { id, at: Date.now() });
    return id;
  }
  function hexA(hex, a) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(hex || ""));
    if (!m) return hex;
    const n = Math.round(a * 255).toString(16);
    return "#" + m[1] + (n.length < 2 ? "0" + n : n);
  }
  function settingIconForTitle(title) {
    const text = String(title || "").toLowerCase();
    const match = KIT_RULES.find(([pattern]) => pattern.test(text));
    return match ? match[1] : null;
  }
  function kitIconKey(p) {
    if (!p || p.noIcon) return null;
    if (p.icon && KIT_TILES[p.icon]) return p.icon;
    return settingIconForTitle(p.title);
  }
  function KitChevron(p) {
    const h = React.createElement, s = p.size || 8, deg = p.dir === "up" ? "225deg" : p.dir === "right" ? "-45deg" : "45deg";
    return h(RN.View, { style: { width: s, height: s, borderRightWidth: 2, borderBottomWidth: 2, borderColor: p.color, borderRadius: 1, transform: [{ rotate: deg }], marginTop: p.dir === "up" ? 3 : p.dir === "down" ? -3 : 0, marginHorizontal: 3 } });
  }
  function KitTile(p) {
    const h = React.createElement, t = KIT_TILES[p.k] || KIT_TILES.gear, size = p.size || 32, asset = kitAsset(t[0]);
    const inner = Math.round(size * 0.56);
    return h(RN.View, { style: { width: size, height: size, borderRadius: Math.round(size * 0.3), backgroundColor: t[2], alignItems: "center", justifyContent: "center", marginRight: p.noMargin ? 0 : 13 } },
      asset ? h(RN.Image, { source: asset, resizeMode: "contain", style: { width: inner, height: inner, tintColor: "#FFFFFF" } })
        : h(RN.Text, { style: { color: "#FFFFFF", fontSize: Math.round(size * 0.5), fontWeight: "700" } }, t[1]));
  }
  function CustomSection(p) {
    const C = palette(), h = React.createElement;
    const kids = React.Children.toArray(p.children);
    const any = kids.some((k) => k && k.type === CustomRow && kitIconKey(k.props));
    const isAction = (k) => !!k && k.type === CustomAction;
    if (kids.length && kids.every(isAction)) {
      return h(RN.View, { style: { marginBottom: p.title ? 24 : 12 } },
        p.title ? h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 6, marginBottom: 10 } },
          h(RN.View, { style: { width: 3, height: 14, borderRadius: 2, backgroundColor: C.blurple, marginRight: 8 } }),
          h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700", flexShrink: 1 } }, p.title)) : null,
        ...kids.map((k, i) => React.cloneElement(k, { top: i === 0 ? 0 : 10 })));
    }
    const out = kids.map((k, i) => isAction(k)
      ? h(RN.View, { key: "act-" + i, style: { paddingHorizontal: 12, paddingTop: i === 0 ? 12 : 0, paddingBottom: 12 } }, React.cloneElement(k, { top: 0 }))
      : (k && k.type === CustomRow && any && !k.props.noIcon && !kitIconKey(k.props)) ? React.cloneElement(k, { __fallbackIcon: true }) : k);
    return h(RN.View, { style: { marginBottom: p.compact ? 14 : 24 } },
      p.title ? h(RN.View, { style: { flexDirection: "row", alignItems: "center", marginHorizontal: 6, marginBottom: 10 } },
        h(RN.View, { style: { width: 3, height: 14, borderRadius: 2, backgroundColor: C.blurple, marginRight: 8 } }),
        h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700", letterSpacing: 0.1, flexShrink: 1 } }, p.title)) : null,
      h(RN.View, { style: { backgroundColor: C.card, borderRadius: 20, overflow: "hidden", borderWidth: 1, borderColor: C.card2 } }, ...out),
      p.footer ? h(RN.Text, { style: { color: C.sub, fontSize: 12, lineHeight: 17, marginHorizontal: 8, marginTop: 8 } }, p.footer) : null);
  }
  function CustomRow(p) {
    const C = palette(), h = React.createElement;
    const key = p.__fallbackIcon ? (kitIconKey(p) || "gear") : kitIconKey(p);
    const tile = key ? KitTile({ k: key, size: 34 }) : null;
    return h(RN.Pressable, {
      accessibilityRole: p.onPress ? "button" : undefined, onPress: p.onPress, disabled: !p.onPress,
      style: ({ pressed }) => ({ minHeight: 66, paddingHorizontal: 16, paddingVertical: 13, flexDirection: "row", alignItems: "center", backgroundColor: pressed ? C.press : "transparent" })
    },
      tile,
      h(RN.View, { style: { flex: 1, minWidth: 0, paddingRight: 10 } },
        h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: 16, fontWeight: "600", lineHeight: 21 } }, p.title),
        p.subtitle ? h(RN.Text, { numberOfLines: 3, style: { color: C.sub, fontSize: 13, marginTop: 3, lineHeight: 18 } }, p.subtitle) : null),
      p.trailing || null,
      !p.last ? h(RN.View, { style: { position: "absolute", bottom: 0, left: key ? 63 : 16, right: 0, height: 1, backgroundColor: C.card2 } }) : null);
  }
  function CustomSwitch(p) {
    const C = palette(), h = React.createElement, on = !!p.value;
    const pos = React.useRef(new RN.Animated.Value(on ? 1 : 0)).current;
    React.useEffect(() => {
      RN.Animated.spring(pos, { toValue: on ? 1 : 0, speed: 24, bounciness: 5, useNativeDriver: true }).start();
    }, [on]);
    return h(RN.Pressable, { accessibilityRole: "switch", accessibilityState: { checked: on }, onPress: () => p.onChange(!on), hitSlop: 10,
      style: { width: 52, height: 32, borderRadius: 16, padding: 3, justifyContent: "center", backgroundColor: on ? (p.color || C.blurple) : C.off } },
      h(RN.Animated.View, { style: { width: 26, height: 26, borderRadius: 13, backgroundColor: "#FFFFFF", shadowColor: "#000000", shadowOpacity: 0.25, shadowRadius: 3, shadowOffset: { width: 0, height: 1 }, elevation: 2, transform: [{ translateX: pos.interpolate({ inputRange: [0, 1], outputRange: [0, 20] }) }] } }));
  }
  function CustomAction(p) {
    const C = palette(), h = React.createElement, RED_ = "#ED4245";
    const sc = React.useRef(new RN.Animated.Value(1)).current;
    const to = (v) => RN.Animated.spring(sc, { toValue: v, speed: 40, bounciness: 0, useNativeDriver: true }).start();
    const bg = p.danger ? (p.secondary ? hexA(RED_, 0.14) : RED_) : (p.secondary ? C.chip : C.blurple);
    const fg = p.danger && p.secondary ? RED_ : (p.secondary ? C.text : "#FFFFFF");
    return h(RN.Pressable, { onPress: p.onPress, disabled: p.disabled, onPressIn: () => to(0.97), onPressOut: () => to(1), accessibilityRole: "button" },
      h(RN.Animated.View, { style: { minHeight: p.compact ? 42 : 50, borderRadius: 15, alignItems: "center", justifyContent: "center", paddingHorizontal: p.compact ? 12 : 18, marginTop: p.top != null ? p.top : 10, backgroundColor: bg, opacity: p.disabled ? 0.45 : 1, transform: [{ scale: sc }] } },
        h(RN.Text, { numberOfLines: 1, style: { color: fg, fontWeight: "700", fontSize: p.compact ? 15 : 16 } }, p.title)));
  }
  function CustomInput(p) {
    const C = palette(), h = React.createElement;
    const [focused, setFocused] = React.useState(false);
    return h(RN.TextInput, {
      ...p, placeholderTextColor: C.sub, underlineColorAndroid: "transparent", textAlignVertical: p.multiline ? "top" : "center",
      onFocus: (e) => { setFocused(true); if (p.onFocus) p.onFocus(e); },
      onBlur: (e) => { setFocused(false); if (p.onBlur) p.onBlur(e); },
      style: [{ minHeight: 50, borderRadius: 14, borderWidth: 1.5, borderColor: focused ? C.blurple : C.card2, backgroundColor: C.bg, color: C.text, paddingHorizontal: 15, fontSize: 16 }, p.style]
    });
  }
  let kitHeroPlayed = false;
  function KitHero(p) {
    const C = palette(), h = React.createElement, accent = p.accent || C.blurple;
    const stats = (p.stats || []).filter(Boolean);
    const enter = React.useRef(new RN.Animated.Value(kitHeroPlayed ? 1 : 0)).current;
    React.useEffect(() => { if (kitHeroPlayed) return; kitHeroPlayed = true; RN.Animated.spring(enter, { toValue: 1, speed: 14, bounciness: 6, useNativeDriver: true }).start(); }, []);
    return h(RN.Animated.View, { style: { borderRadius: 26, backgroundColor: C.card, borderWidth: 1, borderColor: hexA(accent, 0.4), padding: 18, marginBottom: 24, overflow: "hidden", opacity: enter, transform: [{ scale: enter.interpolate({ inputRange: [0, 1], outputRange: [0.96, 1] }) }] } },
      h(RN.View, { pointerEvents: "none", style: { position: "absolute", top: -60, right: -50, width: 190, height: 190, borderRadius: 95, backgroundColor: hexA(accent, 0.16) } }),
      h(RN.View, { pointerEvents: "none", style: { position: "absolute", bottom: -70, left: -40, width: 140, height: 140, borderRadius: 70, backgroundColor: hexA(accent, 0.08) } }),
      h(RN.View, { style: { flexDirection: "row", alignItems: "center" } },
        KitTile({ k: p.icon, size: 54, noMargin: true }),
        h(RN.View, { style: { flex: 1, marginLeft: 14 } },
          h(RN.Text, { numberOfLines: 2, style: { color: C.text, fontSize: 21, fontWeight: "800", letterSpacing: -0.2 } }, p.title),
          p.subtitle ? h(RN.Text, { numberOfLines: 2, style: { color: C.sub, fontSize: 14, marginTop: 3, lineHeight: 19 } }, p.subtitle) : null)),
      stats.length ? h(RN.View, { style: { flexDirection: "row", marginTop: 16 } }, ...stats.map((s, i) =>
        h(RN.View, { key: "stat-" + i, style: { flex: 1, borderRadius: 15, backgroundColor: C.chip, paddingVertical: 11, paddingHorizontal: 12, marginRight: i === stats.length - 1 ? 0 : 8 } },
          h(RN.Text, { numberOfLines: 1, adjustsFontSizeToFit: true, style: { color: C.text, fontSize: 19, fontWeight: "800" } }, String(s[1])),
          h(RN.Text, { numberOfLines: 1, style: { color: C.sub, fontSize: 12, marginTop: 2, fontWeight: "600" } }, s[0])))) : null);
  }
  function KitGuide(p) {
    const C = palette(), h = React.createElement;
    const [open, setOpen] = React.useState(true);
    const steps = p.steps || [];
    return h(RN.View, { style: { marginTop: 4, marginBottom: 16, borderRadius: 20, backgroundColor: C.card, borderWidth: 1, borderColor: C.card2, overflow: "hidden" } },
      h(RN.Pressable, { onPress: () => setOpen(!open), accessibilityRole: "button", accessibilityState: { expanded: open }, style: ({ pressed }) => ({ flexDirection: "row", alignItems: "center", padding: 16, backgroundColor: pressed ? C.press : "transparent" }) },
        KitTile({ k: "guide", size: 34 }),
        h(RN.View, { style: { flex: 1 } },
          h(RN.Text, { style: { color: C.text, fontSize: 17, fontWeight: "800" } }, p.title || "Quick guide"),
          h(RN.Text, { style: { color: C.sub, fontSize: 13, marginTop: 2 } }, steps.length + " short steps")),
        h(RN.View, { style: { width: 24, alignItems: "center", justifyContent: "center" } }, KitChevron({ dir: open ? "up" : "down", color: C.sub, size: 9 }))),
      open ? h(RN.View, { style: { paddingHorizontal: 16, paddingBottom: 6 } }, ...steps.map((s, i) =>
        h(RN.View, { key: "guide-" + i, style: { flexDirection: "row", paddingTop: 12, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.card2 } },
          h(RN.View, { style: { width: 26, height: 26, borderRadius: 13, backgroundColor: hexA(C.blurple, 0.2), alignItems: "center", justifyContent: "center", marginRight: 13, marginTop: 1 } },
            h(RN.Text, { style: { color: C.blurple, fontSize: 13, fontWeight: "800" } }, String(i + 1))),
          h(RN.View, { style: { flex: 1 } },
            h(RN.Text, { style: { color: C.text, fontSize: 15, fontWeight: "700", marginBottom: 3 } }, s[0]),
            h(RN.Text, { style: { color: C.sub, fontSize: 14, lineHeight: 20 } }, s[1]))))) : null);
  }
  function kitIso(d) { const z = (n) => (n < 10 ? "0" : "") + n; return d.getFullYear() + "-" + z(d.getMonth() + 1) + "-" + z(d.getDate()); }
  function kitRange(key) {
    const now = new Date(), to = kitIso(now);
    if (key === "today") return { from: to, to };
    if (key === "7d") return { from: kitIso(new Date(now.getTime() - 6 * 86400000)), to };
    if (key === "30d") return { from: kitIso(new Date(now.getTime() - 29 * 86400000)), to };
    return { from: "", to: "" };
  }
  function kitRangeKey(from, to) {
    if (!from && !to) return "all";
    for (const k of ["today", "7d", "30d"]) { const r = kitRange(k); if (r.from === from && r.to === to) return k; }
    return "custom";
  }
  function kitValidDate(v) {
    const s = String(v || "").trim();
    return !s || (/^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00")));
  }
  function KitSearchIcon(p) {
    const h = React.createElement;
    return h(RN.View, { style: { width: 18, height: 18 } },
      h(RN.View, { style: { position: "absolute", left: 1, top: 1, width: 12, height: 12, borderRadius: 6, borderWidth: 2, borderColor: p.color } }),
      h(RN.View, { style: { position: "absolute", left: 11, top: 13, width: 7, height: 2, borderRadius: 1, backgroundColor: p.color, transform: [{ rotate: "45deg" }] } }));
  }
  function KitChip(p) {
    const C = palette(), h = React.createElement;
    return h(RN.Pressable, { onPress: p.onPress, accessibilityRole: "button", accessibilityState: { selected: !!p.active }, hitSlop: 4,
      style: ({ pressed }) => ({ height: 34, borderRadius: 17, paddingHorizontal: 14, marginRight: p.flush ? 0 : 8, marginBottom: p.flush ? 0 : 8, flexDirection: "row", alignItems: "center", justifyContent: "center", backgroundColor: p.active ? C.blurple : C.chip, opacity: pressed ? 0.8 : 1 }) },
      h(RN.Text, { numberOfLines: 1, style: { color: p.active ? "#FFFFFF" : C.text, fontSize: 14, fontWeight: "600" } }, p.label),
      p.badge ? h(RN.View, { style: { marginLeft: 7, minWidth: 18, height: 18, borderRadius: 9, paddingHorizontal: 5, backgroundColor: p.active ? "rgba(255,255,255,0.28)" : hexA(C.blurple, 0.22), alignItems: "center", justifyContent: "center" } },
        h(RN.Text, { style: { color: p.active ? "#FFFFFF" : C.blurple, fontSize: 12, fontWeight: "800" } }, String(p.badge))) : null);
  }
  function KitFilter(p) {
    const C = palette(), h = React.createElement;
    const query = String(p.query || ""), from = String(p.from || ""), to = String(p.to || "");
    const rangeKey = kitRangeKey(from, to);
    const hasQuery = !!query.trim(), hasDates = !!(from || to), active = hasQuery || hasDates;
    const [open, setOpen] = React.useState(!p.collapsible || active);
    const [custom, setCustom] = React.useState(rangeKey === "custom");
    const saved = Array.isArray(p.saved) ? p.saved : [];
    const set = (patch) => p.onChange({ query, from, to, ...patch });
    const label = (t) => h(RN.Text, { style: { color: C.sub, fontSize: 12, fontWeight: "700", letterSpacing: 0.3, marginTop: 14, marginBottom: 8 } }, t);
    const dateBox = (name, key, value) => h(RN.View, { key, style: { flex: 1, marginRight: key === "from" ? 8 : 0 } },
      h(RN.Text, { style: { color: C.sub, fontSize: 12, fontWeight: "600", marginBottom: 6 } }, name),
      h(CustomInput, { value, placeholder: "YYYY-MM-DD", onChangeText: (v) => set({ [key]: v }), autoCorrect: false, autoCapitalize: "none", keyboardType: "numbers-and-punctuation", style: kitValidDate(value) ? { minHeight: 44 } : { minHeight: 44, borderColor: "#ED4245" } }));
    const showBody = open || !p.collapsible;
    const chips = [["all", "All time"], ["today", "Today"], ["7d", "7 days"], ["30d", "30 days"]];
    return h(RN.View, { style: { marginBottom: 18 } },
      h(RN.View, { style: { backgroundColor: C.card, borderRadius: 20, borderWidth: 1, borderColor: active ? hexA(C.blurple, 0.6) : C.card2, overflow: "hidden" } },
        h(RN.View, { style: { flexDirection: "row", alignItems: "center", paddingLeft: 16, paddingRight: 8 } },
          KitSearchIcon({ color: C.sub }),
          h(RN.TextInput, { value: query, placeholder: p.placeholder || "Search author, channel, server or text", placeholderTextColor: C.sub, onChangeText: (v) => set({ query: v }), autoCorrect: false, autoCapitalize: "none", returnKeyType: "search", underlineColorAndroid: "transparent", style: { flex: 1, color: C.text, fontSize: 16, paddingVertical: 14, paddingHorizontal: 11 } }),
          query ? h(RN.Pressable, { onPress: () => set({ query: "" }), hitSlop: 8, accessibilityLabel: "Clear search", style: { width: 28, height: 28, borderRadius: 14, backgroundColor: C.chip, alignItems: "center", justifyContent: "center", marginRight: 6 } },
            h(RN.Text, { style: { color: C.text, fontSize: 16, fontWeight: "700", marginTop: -1 } }, "\u00D7")) : null,
          p.collapsible ? KitChip({ label: "Filters", flush: true, active: open, badge: hasDates ? 1 : 0, onPress: () => setOpen(!open) }) : null),
        showBody ? h(RN.View, { style: { paddingHorizontal: 16, paddingBottom: 14, borderTopWidth: 1, borderTopColor: C.card2 } },
          label("PERIOD"),
          h(RN.View, { style: { flexDirection: "row", flexWrap: "wrap" } },
            ...chips.map(([k, t]) => h(RN.View, { key: k }, KitChip({ label: t, active: !custom && rangeKey === k, onPress: () => { setCustom(false); set(kitRange(k)); } }))),
            h(RN.View, { key: "custom" }, KitChip({ label: "Custom", active: custom || rangeKey === "custom", onPress: () => setCustom(true) }))),
          (custom || rangeKey === "custom") ? h(RN.View, { style: { flexDirection: "row", marginBottom: 4 } }, dateBox("From", "from", from), dateBox("To", "to", to)) : null,
          h(RN.View, { style: { flexDirection: "row", marginTop: 10 } },
            h(RN.View, { style: { flex: 1, marginRight: 6 } }, h(CustomAction, { title: "Clear", secondary: true, compact: true, top: 0, disabled: !active, onPress: () => { setCustom(false); p.onChange({ query: "", from: "", to: "" }); } })),
            h(RN.View, { style: { flex: 1, marginLeft: 6 } }, h(CustomAction, { title: "Save filter", compact: true, top: 0, disabled: !active || !p.onSave, onPress: () => p.onSave && p.onSave() }))),
          label("SAVED FILTERS"),
          saved.length ? h(RN.View, null, ...saved.map((item, i) => {
            const bits = [item.query, (item.from || item.to) ? ((item.from || "…") + " → " + (item.to || "…")) : ""].filter(Boolean).join("  ·  ");
            return h(RN.View, { key: "saved-" + i, style: { flexDirection: "row", alignItems: "center", backgroundColor: C.chip, borderRadius: 14, marginBottom: 8, overflow: "hidden" } },
              h(RN.Pressable, { onPress: () => p.onApplySaved && p.onApplySaved(item), style: ({ pressed }) => ({ flex: 1, paddingVertical: 11, paddingHorizontal: 14, backgroundColor: pressed ? C.press : "transparent" }) },
                h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 15, fontWeight: "700" } }, item.name || "Saved filter"),
                bits ? h(RN.Text, { numberOfLines: 1, style: { color: C.sub, fontSize: 13, marginTop: 2 } }, bits) : null),
              h(RN.Pressable, { onPress: () => p.onDeleteSaved && p.onDeleteSaved(i, item), hitSlop: 6, accessibilityLabel: "Delete saved filter", style: { width: 44, alignSelf: "stretch", alignItems: "center", justifyContent: "center" } },
                h(RN.Text, { style: { color: C.sub, fontSize: 20, fontWeight: "600" } }, "\u00D7")));
          })) : h(RN.Text, { style: { color: C.sub, fontSize: 13, lineHeight: 18 } }, "Nothing saved yet. Set up a search and tap Save filter to reuse it later.")) : null),
      p.total != null ? h(RN.Text, { style: { color: active ? C.blurple : C.sub, fontSize: 13, fontWeight: "600", marginTop: 10, marginLeft: 8 } },
        active ? (p.matches + " of " + p.total + " match") : (p.total + " in total")) : null);
  }
  function kitMenuPill(label) {
    const C = palette(), h = React.createElement;
    return h(RN.View, { style: { flexDirection: "row", alignItems: "center", backgroundColor: hexA(C.blurple, 0.16), borderRadius: 12, paddingHorizontal: 11, paddingVertical: 7, marginLeft: 6 } },
      h(RN.Text, { numberOfLines: 1, style: { color: C.text, fontSize: 13, fontWeight: "700", maxWidth: 130 } }, String(label || "Select")),
      h(RN.View, { style: { marginLeft: 6 } }, KitChevron({ dir: "down", color: C.blurple, size: 7 })));
  }
  /* ---- end shared kit ---- */

  function Settings() {
    rainStore.useStore();
    const [screen, setScreen] = React.useState("main");
    const screenProgress = React.useRef(new RN.Animated.Value(1)).current;
    React.useEffect(() => { screenProgress.setValue(0); RN.Animated.timing(screenProgress, { toValue: 1, duration: 180, useNativeDriver: true }).start(); }, [screen]);
    const [limit, setLimit] = React.useState(PAGE);
    const [, bump] = React.useState(0);
    const [historyQuery, setHistoryQuery] = React.useState("");
    const [historyFrom, setHistoryFrom] = React.useState("");
    const [historyTo, setHistoryTo] = React.useState("");
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
    const rowSet=new WeakSet(),sectionTitles=new WeakMap(),mark=(el)=>{rowSet.add(el);return el;},HEXCOLOR=/^#[0-9A-Fa-f]{6}$/;
    const Text=(props,...kids)=>h(RN.Text,props,...kids);
    const Section=(title)=>{const m=h(RN.View,{key:"sec-"+title});sectionTitles.set(m,title);return m;};
    const valueChip=(r)=>{if(!r)return null;if(r===">"||r==="\u203A")return Text({style:{color:C.sub,fontSize:24,marginLeft:7,fontWeight:"300"}},"\u203A");const v=String(r);if(HEXCOLOR.test(v))return h(RN.View,{style:{flexDirection:"row",alignItems:"center",marginLeft:8}},h(RN.View,{style:{width:20,height:20,borderRadius:10,backgroundColor:v,borderWidth:1,borderColor:C.divider}}));return Text({style:{color:C.sub,fontSize:14,marginLeft:8},numberOfLines:1},v);};
    const PressRow=(key,label,sub,onPress,right)=>mark(h(CustomRow,{key,title:label,subtitle:sub,onPress,noIcon:/^(logged-|ghost-history-|ignored-|saved-ping-filter-|filter-use-|filter-delete-)/.test(String(key)),trailing:(key==="capture-mode"||key==="retention")?kitMenuPill(right):valueChip(right)}));
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
    const captureModeLabel = () => cfg().captureMode === "expanded" ? "All" : "Loaded";
    const captureModeDescription = () => cfg().captureMode === "expanded"
      ? "Captures messages delivered outside the open chat."
      : "Captures messages loaded in the open chat.";
    const chooseCaptureMode = (mode) => {
      cfg().captureMode = mode;
      if (mode === "loaded") clearRecentMessages();
      if (mode === "loaded") { cfg().receivedMessages = []; recentArchiveDirty = false; if (recentArchiveTimer) { clearTimeout(recentArchiveTimer); recentArchiveTimer = null; } }
      refreshUI();
    };
    const openCaptureModeMenu = () => {
      const select = (mode) => {
        chooseCaptureMode(mode);
        try { const hide = findByProps("openLazy", "hideActionSheet"); hide && hide.hideActionSheet && hide.hideActionSheet(); } catch (_) {}
      };
      try {
        const sheets = findByProps("showSimpleActionSheet");
        if (sheets && typeof sheets.showSimpleActionSheet === "function") {
          sheets.showSimpleActionSheet({ key: "capture-mode-selector", header: { title: "Capture mode" }, options: [
            { label: "All new messages", isMarked: cfg().captureMode === "expanded", onPress: () => select("expanded") },
            { label: "Loaded messages", isMarked: cfg().captureMode !== "expanded", onPress: () => select("loaded") }
          ] });
          return;
        }
      } catch (_) {}
      ask("Capture mode", "Choose which new messages to save.", [
        { text: "All new messages", onPress: () => select("expanded") },
        { text: "Loaded messages", onPress: () => select("loaded") }
      ]);
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
    const chooseRetention = (days) => {
      cfg().retentionDays = days;
      if (purge()) save();
      refreshUI();
    };
    const openRetentionMenu = () => {
      const select = (days) => {
        chooseRetention(days);
        try { const hide = findByProps("openLazy", "hideActionSheet"); hide && hide.hideActionSheet && hide.hideActionSheet(); } catch (_) {}
      };
      try {
        const sheets = findByProps("showSimpleActionSheet");
        if (sheets && typeof sheets.showSimpleActionSheet === "function") {
          sheets.showSimpleActionSheet({ key: "gpl-retention-selector", header: { title: "Keep history for" }, options: [
            { label: "Forever", isMarked: !cfg().retentionDays, onPress: () => select(0) },
            { label: "7 days", isMarked: cfg().retentionDays === 7, onPress: () => select(7) },
            { label: "30 days", isMarked: cfg().retentionDays === 30, onPress: () => select(30) }
          ] });
          return;
        }
      } catch (_) {}
      ask("Keep history for", "Choose how long ghost ping history is kept.", [
        { text: "Forever", onPress: () => select(0) },
        { text: "7 days", onPress: () => select(7) },
        { text: "30 days", onPress: () => select(30) }
      ]);
    };


    let content;
    if (screen === "history") {
      const needle = historyQuery.trim().toLowerCase();
      const fromTime = historyFrom.trim() ? Date.parse(historyFrom.trim() + "T00:00:00") : NaN;
      const toTime = historyTo.trim() ? Date.parse(historyTo.trim() + "T23:59:59.999") : NaN;
      const filteredPings = pings.filter((entry) => {
        const occurredAt = Number(entry.at) || 0;
        const searchable = [entry.an, entry.t, channelLabel(entry.c, entry.g), KINDS[entry.k], entry.status === "edited" ? "edited" : "deleted"].join(" ").toLowerCase();
        return (!needle || searchable.includes(needle)) && (!Number.isFinite(fromTime) || occurredAt >= fromTime) && (!Number.isFinite(toTime) || occurredAt <= toTime);
      });
      content = [
        Btn("back", "< Back", () => { setScreen("main"); setLimit(PAGE); }),
        Title("title", "Ghost pings (" + filteredPings.length + ")"),
        h(KitFilter, { key: "kit-filter", collapsible: true, query: historyQuery, from: historyFrom, to: historyTo, matches: filteredPings.length, total: pings.length,
          saved: Array.isArray(cfg().savedPingFilters) ? cfg().savedPingFilters : [],
          onChange: (next) => { setHistoryQuery(next.query); setHistoryFrom(next.from); setHistoryTo(next.to); setLimit(PAGE); },
          onSave: () => {
            try {
              openNativeInputAlert({ id: "gpl-save-history-filter", title: "Save history filter", content: "Give this search a name.", onSave: (name) => {
                const cleanName = String(name || "").trim().slice(0, 40);
                if (!cleanName) return;
                const saved = Array.isArray(cfg().savedPingFilters) ? cfg().savedPingFilters : [];
                cfg().savedPingFilters = [{ name: cleanName, query: historyQuery, from: historyFrom, to: historyTo }, ...saved.filter((item) => item.name !== cleanName)].slice(0, 20);
                refreshUI();
              } });
            } catch (_) { toast("Could not open saved filter"); }
          },
          onApplySaved: (item) => { setHistoryQuery(item.query || ""); setHistoryFrom(item.from || ""); setHistoryTo(item.to || ""); setLimit(PAGE); },
          onDeleteSaved: (index, item) => ask("Delete saved filter?", item.name || "Saved filter", [{ text: "Delete", style: "destructive", onPress: () => { cfg().savedPingFilters = (Array.isArray(cfg().savedPingFilters) ? cfg().savedPingFilters : []).filter((_, i) => i !== index); refreshUI(); } }]) }),
      ];
      if (filteredPings.length) {
        content.push(Btn("clear", "Clear history", () => {
          ask("Clear ghost ping history?", "This removes every saved ghost ping.", [
            { text: "Clear", style: "destructive", onPress: () => { pings = []; save(); refreshUI(); } },
          ]);
        }, RED));
      } else {
        content.push(Empty("empty", pings.length ? "No ghost pings match these filters." : "No ghost pings yet."));
      }
      filteredPings.slice(0, limit).forEach(function (entry) {
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
        const status = entry.status === "edited" ? "Edited" : entry.status === "test" ? "Test" : "Deleted";
        content.push(PressRow(rowKey, clip(messageText, 200) || "(no text)",
          status + " · " + kind + " · " + authorName + " · " + channelLabel(channelId, guildId) + " · " + fmtTime(occurredAt), function () {
            ask(status + " " + kind + " from " + authorName, clip(messageText, 600), [
              { text: "Jump to message", onPress: () => jumpTo(channelId, guildId, pingId, settingsNavigation) },
              { text: "Remove", style: "destructive", onPress: () => { removePing(pingId); refreshUI(); } },
            ]);
          }));
      });
      if (filteredPings.length > limit) content.push(Btn("more", "Show more", () => setLimit(limit + PAGE)));
    } else {
      content = [
        Section("Detection"),
        Switch("pingMentions", "Mentions", "Messages that mentioned you"),
        Switch("trackEveryone", "Track @everyone", "Also include @here and roles you have", (v) => { cfg().trackEveryone = v; refreshUI(); }),
        Switch("pingReplies", "Replies", "Replies to your messages"),
        Switch("skipBots", "Ignore bots", "Do not report deleted bot messages"),
        Section("Alerts"),
        Switch("showToast", "Show ghost ping alert", "Show a modal with Jump to message and Dismiss"),
        Switch("redName", "Red usernames on ghost pings", "Color the sender name with the ghost ping message", (v) => { cfg().redName = v; refreshGhostRows(); refreshUI(); }),
        Section("Message capture"),
        PressRow("capture-mode", "Capture mode", captureModeDescription(), openCaptureModeMenu, captureModeLabel()),
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
        PressRow("retention", "Keep history for", "Older entries are removed automatically", openRetentionMenu, retentionLabel()),
        Btn("test", "Send a test ghost ping", () => { addTestPing(); refreshUI(); }),
      ];
    }
    const helpFooter = screen === "main" ? h(KitGuide, { key: "settings-guide", title: "Quick guide", steps: [["What counts as a ghost ping","A message that mentioned you or replied to you and was then deleted, or edited so the mention is gone. Track @everyone also covers @everyone, @here and any role you have."],["Alerts","When one is detected you get an alert with Jump to message and Dismiss. Turn the alert, or red usernames on ghost pings, on or off under Alerts."],["Capture mode","All watches every event the app receives; Loaded limits capture to conversations that are already loaded. In DMs the history records received messages, in servers only mentions and replies. Messages that never reached this device can't be logged."],["Browse the history","Open Ghost ping history to see entries marked Edited or Deleted. Use the search bar and the Filters button to narrow by text, author, channel, server or date, and save the filters you reuse. Tap an entry to jump to it or remove it."],["Retention and cache","Remember new messages keeps a limited recent cache, so a deleted message can still be recognized after a restart. Choose how long history is kept; older entries are removed automatically."]] }) : null;
    const buildLabel = Text({ key: "build", style: { color: C.sub, fontSize: 12, textAlign: "center", marginTop: 1, opacity: 0.7 } }, "Ghost Ping Logger " + BUILD);
    const header = screen === "main" ? [h(KitHero, { key: "hero", icon: "at", title: "Ghost Ping Logger", subtitle: "Review deleted pings and message capture", stats: [["Ghost pings", pings.length], ["Capture", captureModeLabel()], ["Cache", String(recentMessageLimit())]] })] : [];
    return h(RN.Animated.View, { style: { flex: 1, opacity: screenProgress, transform: [{ translateY: screenProgress.interpolate({ inputRange: [0, 1], outputRange: [8, 0] }) }] } }, h(RN.ScrollView, { key: screen, style: { flex: 1 }, keyboardShouldPersistTaps: "handled", contentContainerStyle: { padding: 16, paddingBottom: 42 } }, ...header, ...compose(content), helpFooter, buildLabel));
  }

  function onLoad() {
    receivedThisSession = 0;
    receivedDMsThisSession = 0;
    receivedChannelsThisSession.clear();
    const s = cfg();
    const defaults = { enabled: true, pingMentions: true, trackEveryone: true, pingReplies: true, skipBots: true, showToast: true, retentionDays: 0, captureMode: "expanded", maxCachedMessages: DEFAULT_RECENT_MESSAGES, rememberReceivedMessages: true, redName: true };
    for (const k of Object.keys(defaults)) if (s[k] === undefined) s[k] = defaults[k];
    if (s.defaultsV2 !== 1) {
      s.pingMentions = true; s.trackEveryone = true; s.pingReplies = true; s.skipBots = true; s.showToast = true; s.redName = true;
      s.rememberReceivedMessages = true; s.captureMode = "expanded";
      if (s.maxCachedMessages === undefined || Number(s.maxCachedMessages) === 5000) s.maxCachedMessages = DEFAULT_RECENT_MESSAGES;
      s.defaultsV2 = 1;
    }
    s.enabled = true;
    if (s.captureModeDefaultMigration !== 1) { s.captureMode = "expanded"; s.captureModeDefaultMigration = 1; }
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
