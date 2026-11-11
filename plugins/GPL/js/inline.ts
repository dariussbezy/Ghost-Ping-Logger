import { processColor } from "react-native";
import { Dispatcher } from "@valenced/discord/common/flux";
import { Stores, onFluxEventDispatched } from "@valenced/discord/flux";
import { getModules } from "@valenced/modules/finders";
import { withName } from "@valenced/modules/finders/filters";
import { instead } from "@valenced/patcher";
import type { Entry, Event, Mode } from "./events";

export type InlineSettings = {
  retainDeleted?: boolean;
  showInlineEdits?: boolean;
  colorDeletedUsername?: boolean;
  deletedMessageColor?: string;
  editedMessageColor?: string;
  deletedNameColor?: string;
  showDeletedTime?: boolean;
  showEditTime?: boolean;
  use12HourClock?: boolean;
  redName?: boolean;
};

type Location = { channelId: string; id: string; guildId?: string };
type Participant = {
  settings: () => InlineSettings;
  entries: () => readonly Entry[];
  report: (error: unknown) => void;
  source?: readonly Entry[];
  byMessage?: Map<string, Entry[]>;
};

type InlineEvent = Event & { __dariussLoggerInlineV1?: true };
export function isInlineEvent(event: Event): boolean {
  return (event as InlineEvent).__dariussLoggerInlineV1 === true;
}

type Content = { type?: string; content?: unknown };
type Row = {
  type?: number;
  rowType?: number;
  changeType?: number;
  message?: {
    id?: string;
    content?: Content[];
    textColor?: number;
    timestampColor?: number;
    colorString?: number;
    usernameColor?: number;
    editedColor?: number;
    edited?: string;
  };
  backgroundHighlight?: { backgroundColor: number; gutterColor: number };
};
type GenerateArgs = { rowType?: number; message?: { id?: string; channel_id?: string; merge?: (value: unknown) => unknown } };
type RowGenerator = { generate(args: GenerateArgs): Row | undefined };

type InlineRuntime = {
  active: Map<Mode, Participant>;
  retained: Map<string, Location>;
  rendered: Map<string, Location>;
  changed: Set<string>;
  remove: (() => void)[];
  rendererFound: boolean;
  scheduled: boolean;
  refreshAll: boolean;
};
const globals = globalThis as typeof globalThis & { __dariussInlineRuntimeV1?: InlineRuntime };
const keyOf = (id: string, channelId: string) => channelId + ":" + id;
const isValidColor = (color: string | undefined): color is string => !!color && /^#[0-9a-f]{6}$/i.test(color);
const red = "#ed4245";
const grey = "#939aa8";

function report(runtime: InlineRuntime, error: unknown) {
  for (const participant of runtime.active.values()) {
    try { participant.report(error); } catch { /* Keep Discord rendering. */ }
  }
}

function logs(participant: Participant | undefined, key: string): readonly Entry[] {
  if (!participant) return [];
  const entries = participant.entries();
  if (entries !== participant.source) {
    const byMessage = new Map<string, Entry[]>();
    for (const entry of entries) {
      const id = keyOf(entry.before.id, entry.before.channelId);
      const group = byMessage.get(id);
      if (group) group.push(entry);
      else byMessage.set(id, [entry]);
    }
    participant.source = entries;
    participant.byMessage = byMessage;
  }
  return participant.byMessage?.get(key) ?? [];
}

function deletion(runtime: InlineRuntime, key: string) {
  const ghost = runtime.active.get("gpl");
  const ghostLogs = logs(ghost, key);
  if (ghost && ghostLogs.length && ghost.settings().retainDeleted !== false) {
    const entry = ghostLogs.find(item => item.kind === "deleted")
      ?? logs(runtime.active.get("aml"), key).find(item => item.kind === "deleted");
    if (entry) return { entry, mode: "gpl" as const, settings: ghost.settings() };
  }
  for (const mode of ["gpl", "aml"] as const) {
    const participant = runtime.active.get(mode);
    if (!participant) continue;
    const settings = participant.settings();
    if (settings.retainDeleted === false) continue;
    const entry = logs(participant, key).find(item => item.kind === "deleted");
    if (entry) return { entry, mode, settings };
  }
}

function time(at: number, settings: InlineSettings) {
  return new Date(at).toLocaleTimeString(undefined, {
    hour: "2-digit", minute: "2-digit", hour12: settings.use12HourClock === true,
  });
}
const node = (content: string): Content => ({ type: "text", content });
function colorValue(value: string | undefined, fallback: string) {
  return isValidColor(value) ? value : fallback;
}
function nativeColor(value: string): number | undefined {
  const result = processColor(value);
  return typeof result === "number" ? result : undefined;
}

function styleRow(runtime: InlineRuntime, original: Row | undefined, args: GenerateArgs, generate: (args: GenerateArgs) => Row | undefined): Row | undefined {
  const rowType = original?.type ?? original?.rowType ?? args?.rowType;
  const message = original?.message;
  const channelId = args?.message?.channel_id;
  const id = message?.id ?? args?.message?.id;
  if (!original || rowType !== 1 || !message || !id || !channelId) return original;
  const key = keyOf(id, channelId);
  const redraw = runtime.changed.delete(key);
  const deleted = runtime.retained.has(key) ? deletion(runtime, key) : undefined;
  const aml = runtime.active.get("aml");
  const gpl = runtime.active.get("gpl");
  const ghostPing = logs(gpl, key).length > 0;
  const editOwner = ghostPing ? gpl : aml;
  const editSettings = editOwner?.settings();
  const edits = editSettings && editSettings.showInlineEdits !== false
    ? logs(aml ?? editOwner, key).filter(entry => entry.kind === "edited")
      .slice().sort((a, b) => a.at - b.at)
    : [];
  const gplEdit = gpl?.settings().redName !== false && logs(gpl, key).some(entry => entry.kind === "edited");
  if (!deleted && !edits.length && !gplEdit) {
    runtime.rendered.delete(key);
    return redraw ? { ...original, changeType: 2 } : original;
  }
  runtime.rendered.set(key, { id, channelId, guildId: deleted?.entry.before.guildId });
  while (runtime.rendered.size > 400) runtime.rendered.delete(runtime.rendered.keys().next().value!);

  const row = { ...original, message: { ...message } };
  if (redraw) row.changeType = 2;
  function previousContent(entry: Entry): Content[] {
    const content = String(entry.before.original?.content ?? entry.before.content);
    // Keep Discord's UserRecord, tags and other native model instances intact.
    if (args.message?.merge) {
      try {
        const record = args.message.merge({ content });
        const renderedContent = generate({ ...args, message: record as GenerateArgs["message"] })?.message?.content;
        if (Array.isArray(renderedContent)) return renderedContent;
      } catch { /* Older records fall back to their saved text. */ }
    }
    return [node(content || "(No text)")];
  }
  if (edits.length && editSettings && Array.isArray(message.content)) {
    row.message.content = [
      ...edits.flatMap(entry => [
        ...previousContent(entry),
        // Discord's subtext node applies compact text and terminates its line.
        // Insert the node directly: parsing "-#" would create a separate block.
        { type: "subtext", content: [
          node(" (edited" + (editSettings.showEditTime ? " " + time(entry.at, editSettings) : "") + ")"),
        ] },
      ]),
      ...message.content,
    ];
    const tint = colorValue(editSettings.editedMessageColor, grey);
    row.message.editedColor = nativeColor(tint);
    if (editSettings.showEditTime) row.message.edited = "edited " + time(edits[edits.length - 1].at, editSettings);
    const backgroundColor = nativeColor(tint + "14");
    const gutterColor = nativeColor(tint + "80");
    if (!row.backgroundHighlight && backgroundColor !== undefined && gutterColor !== undefined) {
      row.backgroundHighlight = { backgroundColor, gutterColor };
    }
  }

  if (deleted) {
    const { entry, mode, settings } = deleted;
    const tint = colorValue(settings.deletedMessageColor, red);
    const processed = nativeColor(tint);
    if (processed !== undefined) {
      row.message.textColor = processed;
      row.message.timestampColor = processed;
      const backgroundColor = nativeColor(tint + "26");
      if (backgroundColor !== undefined) row.backgroundHighlight = { backgroundColor, gutterColor: processed };
    }
    if (settings.showDeletedTime && Array.isArray(row.message.content)) {
      row.message.edited = "deleted " + time(entry.at, settings);
      row.message.editedColor = processed;
    }
    if ((mode === "aml" ? settings.colorDeletedUsername : settings.redName) !== false) {
      const nameColor = nativeColor(colorValue(settings.deletedNameColor, red));
      if (nameColor !== undefined) {
        row.message.usernameColor = nameColor;
        row.message.colorString = nameColor;
      }
    }
  } else if (gplEdit) {
    const nameColor = nativeColor(colorValue(gpl?.settings().deletedNameColor, red));
    if (nameColor !== undefined) {
      row.message.usernameColor = nameColor;
      row.message.colorString = nameColor;
    }
  }
  return row;
}

function refreshPayload({ channelId, id, guildId }: Location) {
  return {
    type: "MESSAGE_UPDATE",
    guildId,
    message: { id, channel_id: channelId },
    __dariussLoggerInlineV1: true as const,
  };
}
function dispatch(runtime: InlineRuntime, payload: InlineEvent) {
  try {
    void Promise.resolve(Dispatcher.dispatch(payload)).catch(error => report(runtime, error));
  } catch (error) {
    report(runtime, error);
  }
}

function reconcile(runtime: InlineRuntime, refreshAll: boolean) {
  const dropped = new Set<string>();
  for (const [key, location] of runtime.retained) {
    if (deletion(runtime, key)) continue;
    runtime.retained.delete(key);
    runtime.rendered.delete(key);
    runtime.changed.delete(key);
    dropped.add(key);
    dispatch(runtime, { type: "MESSAGE_DELETE", ...location, __dariussLoggerInlineV1: true });
  }
  if (!refreshAll) return;
  for (const [key, location] of runtime.rendered) {
    if (dropped.has(key)) continue;
    runtime.changed.add(key);
    dispatch(runtime, refreshPayload(location));
  }
}
function scheduleReconcile(runtime: InlineRuntime, refreshAll: boolean) {
  runtime.refreshAll ||= refreshAll;
  if (runtime.scheduled) return;
  runtime.scheduled = true;
  void Promise.resolve().then(() => {
    runtime.scheduled = false;
    const refresh = runtime.refreshAll;
    runtime.refreshAll = false;
    reconcile(runtime, refresh);
  }).catch(error => report(runtime, error));
}

function keep(runtime: InlineRuntime, location: Location) {
  if (!runtime.rendererFound) return false;
  const key = keyOf(location.id, location.channelId);
  if (!deletion(runtime, key)) return false;
  const store = Stores.MessageStore as unknown as {
    getMessage(channelId: string, id: string): { state?: string; flags?: number } | undefined;
  };
  const record = store?.getMessage(location.channelId, location.id);
  // Unsent and ephemeral rows are dismissed, rather than being retained.
  if (!record || record.state !== "SENT" || ((record.flags ?? 0) & (1 << 6))) return false;
  runtime.retained.set(key, location);
  runtime.changed.add(key);
  scheduleReconcile(runtime, false);
  return true;
}

function attach(runtime: InlineRuntime) {
  type Loaded = Event & {
    messages: { id: string }[];
    hasMoreBefore?: boolean;
    hasMoreAfter?: boolean;
  };
  for (const type of ["LOAD_MESSAGES_SUCCESS", "LOAD_MESSAGES_SUCCESS_CACHED"]) {
    runtime.remove.push(onFluxEventDispatched<Loaded>(type, payload => {
      if (!runtime.rendererFound || !payload.channelId || !Array.isArray(payload.messages)) return payload;
      const ids = payload.messages.map(message => message.id).filter(id => /^\d+$/.test(id));
      const sorted = ids.map(BigInt).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
      const present = new Set(ids);
      const extra = [];
      for (const participant of runtime.active.values()) {
        for (const entry of participant.entries()) {
          const before = entry.before;
          if (entry.test || entry.kind !== "deleted" || before.channelId !== payload.channelId ||
              present.has(before.id) || !/^\d+$/.test(before.id)) continue;
          const key = keyOf(before.id, before.channelId);
          if (!deletion(runtime, key)) continue;
          const id = BigInt(before.id);
          const inside = sorted.length ? id >= sorted[0] && id <= sorted[sorted.length - 1] : false;
          const older = sorted.length && id < sorted[0] && payload.hasMoreBefore === false;
          const newer = sorted.length && id > sorted[sorted.length - 1] && payload.hasMoreAfter === false;
          const empty = !sorted.length && payload.hasMoreBefore === false && payload.hasMoreAfter === false;
          if (!(inside || older || newer || empty)) continue;
          present.add(before.id);
          extra.push({
            ...before.original,
            id: before.id, channel_id: before.channelId, guild_id: before.guildId || undefined,
            author: before.original?.author ?? { id: before.authorId, username: before.author, bot: before.bot },
            content: typeof before.original?.content === "string" ? before.original.content : before.content,
            timestamp: before.original?.timestamp ?? new Date(Number((id >> 22n) + 1420070400000n)).toISOString(),
            state: "SENT", flags: 0, type: 0,
            attachments: before.original?.attachments ?? [], embeds: before.original?.embeds ?? [], reactions: [],
            mentions: before.mentions.map(id => ({ id })), mention_roles: before.roles,
            mention_everyone: before.everyone,
          });
          runtime.retained.set(key, { id: before.id, channelId: before.channelId, guildId: before.guildId });
          runtime.changed.add(key);
        }
      }
      if (!extra.length) return payload;
      const messages = [...payload.messages, ...extra].sort((a, b) =>
        /^\d+$/.test(a.id) && /^\d+$/.test(b.id) ? BigInt(a.id) > BigInt(b.id) ? -1 : BigInt(a.id) < BigInt(b.id) ? 1 : 0 : 0);
      return { ...payload, messages };
    }));
  }
  const patched = new WeakSet<object>();
  runtime.remove.push(getModules(withName<{ prototype: RowGenerator }>("RowManager"), target => {
    const prototype = target.prototype;
    if (!prototype || typeof prototype.generate !== "function" || patched.has(prototype)) return;
    try {
      const unpatch = instead(prototype, "generate", function (args, original) {
        const row = original.apply(this, args);
        try { return styleRow(runtime, row, args[0], value => original.call(this, value)); }
        catch (error) { report(runtime, error); return row; }
      });
      patched.add(prototype);
      runtime.remove.push(unpatch);
      runtime.rendererFound = true;
    } catch (error) { report(runtime, error); }
  }));
  runtime.remove.push(onFluxEventDispatched<{ id: string; channelId: string; guildId?: string }>("MESSAGE_DELETE", payload => {
    if (isInlineEvent(payload) || !payload.id || !payload.channelId) return payload;
    const location = { id: payload.id, channelId: payload.channelId, guildId: payload.guildId };
    if (!keep(runtime, location)) return payload;
    return refreshPayload(location) as unknown as typeof payload;
  }));
  runtime.remove.push(onFluxEventDispatched<{ ids: string[]; channelId: string; guildId?: string }>("MESSAGE_DELETE_BULK", payload => {
    if (isInlineEvent(payload) || !Array.isArray(payload.ids) || !payload.channelId) return payload;
    const kept = new Set<string>();
    for (const id of payload.ids) {
      const location = { id, channelId: payload.channelId, guildId: payload.guildId };
      if (!kept.has(id) && keep(runtime, location)) {
        kept.add(id);
        void Promise.resolve().then(() => {
          if (runtime.retained.has(keyOf(location.id, location.channelId))) dispatch(runtime, refreshPayload(location));
        });
      }
    }
    if (!kept.size) return payload;
    const ids = payload.ids.filter(id => !kept.has(id));
    return ids.length ? { ...payload, ids } : undefined;
  }));
}

export function installInline(
  mode: Mode,
  settings: () => InlineSettings,
  entries: () => readonly Entry[],
  onError: (error: unknown) => void,
): { stop: () => void; refresh: () => void } {
  const runtime = globals.__dariussInlineRuntimeV1 ??= {
    active: new Map(), retained: new Map(), rendered: new Map(), changed: new Set(),
    remove: [], rendererFound: false, scheduled: false, refreshAll: false,
  };
  const participant: Participant = { settings, entries, report: onError };
  runtime.active.set(mode, participant);
  if (runtime.active.size === 1 && !runtime.remove.length) {
    try { attach(runtime); } catch (error) { report(runtime, error); }
  }
  return {
    refresh() {
      if (runtime.active.get(mode) === participant) scheduleReconcile(runtime, true);
    },
    stop() {
      if (runtime.active.get(mode) !== participant) return;
      runtime.active.delete(mode);
      // Clear this participant's retained rows while the last renderer hook can still refresh them.
      try { reconcile(runtime, true); } catch (error) { onError(error); }
      if (runtime.active.size) return;
      for (const remove of runtime.remove.splice(0).reverse()) {
        try { remove(); } catch (error) { onError(error); }
      }
      runtime.changed.clear();
      runtime.rendered.clear();
      runtime.rendererFound = false;
      if (globals.__dariussInlineRuntimeV1 === runtime) delete globals.__dariussInlineRuntimeV1;
    },
  };
}
