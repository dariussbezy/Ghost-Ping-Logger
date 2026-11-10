export type Mode = "aml" | "gpl";
export type Message = {
  id?: string;
  channel_id?: string;
  channelId?: string;
  guild_id?: string;
  guildId?: string;
  author?: { id?: string; username?: string; bot?: boolean };
  content?: string;
  mentions?: (string | { id?: string })[];
  mentioned?: boolean;
  mention_roles?: string[];
  mentionRoles?: string[];
  mention_everyone?: boolean;
  mentionEveryone?: boolean;
  message_reference?: { message_id?: string; channel_id?: string } | null;
  messageReference?: { messageId?: string; channelId?: string } | null;
  reference?: { messageId?: string; channelId?: string; message_id?: string; channel_id?: string } | null;
  referencedMessage?: { author?: { id?: string }; message?: { author?: { id?: string } } } | null;
  referenced_message?: { author?: { id?: string } } | null;
};
export type Event = {
  type: string;
  message?: Message;
  id?: string;
  ids?: string[];
  channelId?: string;
  guildId?: string;
};
export type Snapshot = {
  id: string;
  channelId: string;
  guildId: string;
  authorId: string;
  author: string;
  bot: boolean;
  content: string;
  mentions: string[];
  roles: string[];
  mentioned: boolean;
  everyone: boolean;
  replyTo: string;
  seenAt: number;
};
export type Entry = { kind: "edited" | "deleted"; at: number; before: Snapshot; after?: string };
export const defaults = {
  logEdits: true, logDeletes: true, direct: true, roles: true, everyone: true,
  replies: true, skipBots: true, skipSelf: true, alerts: true, persist: false,
  ignoredIds: "", retentionDays: 7,
};
export type Settings = typeof defaults;
export const SnapshotLimit = 250;
export const EntryLimit = 200;
const TextLimit = 1600;
const SnapshotAge = 24 * 60 * 60 * 1000;

export type Lookup = (event: Event, channelId: string, id: string) => Snapshot | undefined;
type Env = {
  settings(): Settings;
  me(channelId: string): { id: string; roles: string[] } | undefined;
  channel(channelId: string): { guild_id?: string; guildId?: string; type?: number } | undefined;
  reference(channelId: string, id: string): Message | undefined;
  record(entry: Entry): void;
  alert(entry: Entry, event: Event): void;
  changed?(): void;
};
type Cooperation = { aml?: { lookup: Lookup }; gpl?: { alerted(event: Event, id: string): boolean } };
const bridge = globalThis as typeof globalThis & { __dariussLoggerBridgeV1?: Cooperation };
export function cooperation() { return bridge.__dariussLoggerBridgeV1 ??= {}; }
function matchIds(content: string, regex: RegExp) {
  return Array.from(content.matchAll(regex), match => match[1]).slice(0, 100);
}
export function createEngine(mode: Mode, env: Env) {
  const recent = new Map<string, Snapshot>();
  const previous = new WeakMap<Event, Map<string, Snapshot>>();
  const alertedEvents = new WeakMap<Event, Set<string>>();
  const key = (channelId: string, id: string) => channelId + ":" + id;

  function merge(message: Message, channelId: string, guildId = "", old?: Snapshot): Snapshot | undefined {
    if (!message.id || !channelId || !(message.author?.id || old?.authorId)) return;
    const content = typeof message.content === "string" ? message.content : undefined;
    const changed = content !== undefined && content !== old?.content;
    const author = message.author;
    const ref = message.message_reference;
    const refId = ref?.message_id || message.messageReference?.messageId || message.reference?.messageId || message.reference?.message_id;
    const refChannel = ref?.channel_id || message.messageReference?.channelId || message.reference?.channelId || message.reference?.channel_id || channelId;
    const referenceAuthor = message.referenced_message?.author?.id || message.referencedMessage?.author?.id ||
      message.referencedMessage?.message?.author?.id ||
      (refId && env.reference(refChannel, refId)?.author?.id);
    const roles = message.mention_roles ?? message.mentionRoles;
    return {
      id: message.id, channelId,
      guildId: message.guild_id || message.guildId || guildId || old?.guildId || env.channel(channelId)?.guild_id || env.channel(channelId)?.guildId || "",
      authorId: author?.id || old!.authorId,
      author: (author?.username || old?.author || "Unknown user").slice(0, 80),
      bot: author?.bot ?? old?.bot ?? false,
      content: (content ?? old?.content ?? "").slice(0, TextLimit),
      mentions: Array.isArray(message.mentions)
        ? message.mentions.flatMap(m => typeof m === "string" ? [m] : m?.id ? [m.id] : []).slice(0, 100)
        : changed ? matchIds(content!, /<@!?(\d+)>/g) : old?.mentions ?? [],
      mentioned: message.mentioned ?? (!(changed || Array.isArray(message.mentions)) && old?.mentioned === true),
      roles: Array.isArray(roles) ? roles.slice(0, 100)
        : changed ? matchIds(content!, /<@&(\d+)>/g) : old?.roles ?? [],
      everyone: message.mention_everyone ?? message.mentionEveryone ?? (changed ? old?.everyone === true && /@(everyone|here)\b/.test(content!) : old?.everyone ?? false),
      replyTo: ref === null || message.messageReference === null || message.reference === null ? "" : referenceAuthor || old?.replyTo || "",
      seenAt: Date.now(),
    };
  }

  function skipped(message: Snapshot) {
    const settings = env.settings();
    const me = env.me(message.channelId);
    const ignored = settings.ignoredIds.split(/[\s,]+/);
    return (settings.skipBots && message.bot) || ((mode === "gpl" || settings.skipSelf) && message.authorId === me?.id)
      || ignored.includes(message.authorId) || ignored.includes(message.channelId)
      || (!!message.guildId && ignored.includes(message.guildId));
  }

  function pings(message: Snapshot) {
    const me = env.me(message.channelId);
    if (!me) return false;
    const settings = env.settings();
    return (settings.direct && (message.mentioned || message.mentions.includes(me.id)))
      || (settings.replies && message.replyTo === me.id)
      || (settings.everyone && message.everyone)
      || (settings.roles && message.roles.some(id => me.roles.includes(id)));
  }

  function remember(message: Snapshot) {
    const id = key(message.channelId, message.id);
    recent.delete(id);
    if (!skipped(message) && (mode === "aml" || pings(message))) recent.set(id, message);
    while (recent.size > SnapshotLimit) recent.delete(recent.keys().next().value!);
  }

  const lookup: Lookup = (event, channelId, id) => {
    const name = key(channelId, id);
    const value = previous.get(event)?.get(name) ?? recent.get(name);
    return value && Date.now() - value.seenAt <= SnapshotAge ? value : undefined;
  };

  function known(event: Event, channelId: string, id: string, other?: Lookup) {
    return lookup(event, channelId, id)
      ?? other?.(event, channelId, id)
      ?? merge(env.reference(channelId, id) ?? {}, channelId, event.guildId);
  }

  function keepBefore(event: Event, message: Snapshot) {
    let map = previous.get(event);
    if (!map) previous.set(event, map = new Map());
    map.set(key(message.channelId, message.id), message);
  }

  function log(kind: Entry["kind"], before: Snapshot, event: Event, after?: Snapshot) {
    const settings = env.settings();
    if (skipped(before) || !(kind === "edited" ? settings.logEdits : settings.logDeletes)) return;
    if (mode === "gpl" && (!pings(before) || (after && pings(after)))) return;
    const entry: Entry = { kind, at: Date.now(), before, after: after?.content };
    env.record(entry);
    const channelType = mode === "aml" && settings.alerts ? env.channel(before.channelId)?.type : undefined;
    if (settings.alerts && (mode === "gpl" || channelType === 1 || channelType === 3)) {
      let ids = alertedEvents.get(event);
      if (!ids) alertedEvents.set(event, ids = new Set());
      ids.add(before.id);
      env.alert(entry, event);
    }
  }

  function observe(event: Event, other?: Lookup) {
    const message = event.message;
    const channelId = event.channelId || message?.channel_id || message?.channelId;
    if (!channelId) return;
    if (event.type === "MESSAGE_CREATE" && message) {
      const captured = merge(message, channelId, event.guildId);
      if (captured) remember(captured);
    } else if (event.type === "MESSAGE_UPDATE" && message?.id) {
      const before = known(event, channelId, message.id, other);
      if (before) keepBefore(event, before);
      const after = merge(message, channelId, event.guildId, before);
      if (before && after && (mode === "gpl" || before.content !== after.content)) log("edited", before, event, after);
      if (after) remember(after);
    } else if (event.type === "MESSAGE_DELETE" || event.type === "MESSAGE_DELETE_BULK") {
      const ids = event.type === "MESSAGE_DELETE" ? [event.id] : event.ids ?? [];
      for (const id of new Set(ids)) {
        if (!id) continue;
        const before = known(event, channelId, id, other);
        if (before) {
          keepBefore(event, before);
          log("deleted", before, event);
        }
        recent.delete(key(channelId, id));
      }
    } else return;
    env.changed?.();
  }

  return {
    observe, lookup,
    alerted: (event: Event, id: string) => alertedEvents.get(event)?.has(id) ?? false,
    snapshot: () => [...recent.values()].filter(m => Date.now() - m.seenAt <= SnapshotAge),
    restore: (messages: Snapshot[]) => {
      for (const message of messages.slice(-SnapshotLimit)) {
        if (message?.id && message.channelId && Date.now() - message.seenAt <= SnapshotAge) remember(message);
      }
    },
    clear: () => recent.clear(),
  };
}
