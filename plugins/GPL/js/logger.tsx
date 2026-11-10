import { useState, useSyncExternalStore } from "react";
import { ScrollView } from "react-native";
import { getAssetIdByName } from "@valenced/assets";
import { AlertActionCreators, ToastActionCreators } from "@valenced/discord/actions";
import { Design } from "@valenced/discord/design";
import { Stores, onAnyFluxEventDispatched } from "@valenced/discord/flux";
import { lookupModule } from "@valenced/modules/finders";
import { withProps } from "@valenced/modules/finders/filters";
import { cooperation, createEngine, defaults, EntryLimit, MaxSnapshotLimit } from "./events";
import type { Entry, Event, Message, Mode, Settings, Snapshot } from "./events";
import { installInline, isInlineEvent } from "./inline";
import { installMenus } from "./menus";
import { defaultHistoryFilter, HistoryFilters, matchesHistory } from "./history-filters";
import type { HistoryFilter, SavedHistoryFilter } from "./history-filters";

type Preferences = Settings & { savedFilters?: SavedHistoryFilter[] };
type Data = { settings: Preferences; entries: Entry[]; recent: Snapshot[] };
type Storage = { set(data: Data, replace: boolean): Promise<unknown> };
const actions = new Set<string>(["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"]);
const day = 24 * 60 * 60 * 1000;
const inlinePreferences = new Set(["retainDeleted", "showInlineEdits", "colorDeletedUsername", "redName", "deletedMessageColor", "editedMessageColor", "deletedNameColor", "showDeletedTime", "showEditTime", "use12HourClock", "retentionDays"]);

function rowIcon(name: string) {
  const source = getAssetIdByName(name);
  return source ? <Design.TableRow.Icon source={source} /> : undefined;
}

const getStores = () => Stores as unknown as {
  ChannelStore?: { getChannel(id: string): { guild_id?: string; guildId?: string; name?: string; type?: number } | undefined };
  UserStore?: { getCurrentUser(): { id: string } | undefined; getUser?(id: string): { username?: string } | undefined };
  GuildMemberStore?: { getMember(guild: string, user: string): { roles?: string[] } | undefined };
  MessageStore?: {
    getMessage(channel: string, id: string): Message | undefined;
    getMessages?(channel: string): { length?: number; toArray?(): Message[] } | undefined;
  };
  SelectedChannelStore?: { getChannelId(): string | undefined };
  GuildStore?: { getGuild(id: string): { name?: string } | undefined };

};
const getChannel = (channelId: string) => getStores().ChannelStore?.getChannel(channelId);
const getMessage = (channelId: string, id: string) => getStores().MessageStore?.getMessage(channelId, id);
const guildOf = (channelId: string) => {
  const channel = getChannel(channelId);
  return channel?.guild_id || channel?.guildId;
};

export function defineLogger(mode: Mode) {
  const ghost = mode === "gpl";
  const id = ghost ? "dariuss.ghost-ping-logger" : "dariuss.advanced-message-logger";
  const name = ghost ? "Ghost Ping Logger" : "Adv. Message Logger";
  const detailKey = id + ".details";
  const clearKey = id + ".clear";
  const notificationKey = id + ".notification";
  const defaultSettings: Preferences = { ...defaults, alerts: ghost, savedFilters: [] };
  const initialData: Data = { settings: defaultSettings, entries: [], recent: [] };
  let state = { settings: defaultSettings, entries: [] as Entry[] };
  let storage: Storage | undefined;
  let error: (err: unknown) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let active = false;
  let received = 0;
  let refreshInline = () => {};
  let generation = 0;
  const subscribers = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  };
  const getState = () => state;
  const emit = () => { for (const fn of subscribers) fn(); };
  const recentEntries = (entries: Entry[]) => {
    const cutoff = state.settings.retentionDays ? Date.now() - state.settings.retentionDays * day : 0;
    return entries.filter(x => x?.before?.id && x.at >= cutoff).slice(0, EntryLimit);
  };

  let inlineSource: Entry[] | undefined;
  let inlineMinute = -1;
  let inlineEntries: Entry[] = [];
  function entriesForInline() {
    const minute = Math.floor(Date.now() / 60_000);
    if (inlineSource !== state.entries || inlineMinute !== minute) {
      inlineSource = state.entries;
      inlineMinute = minute;
      inlineEntries = recentEntries(state.entries).filter(entry => !entry.test);
    }
    return inlineEntries;
  }

  const pendingAlerts = new WeakMap<Event, Entry[]>();
  const engine = createEngine(mode, {
    settings: () => state.settings,
    channel: getChannel,
    reference: getMessage,
    loaded(channelId) {
      if (getStores().SelectedChannelStore?.getChannelId() === channelId) return true;
      const bucket = getStores().MessageStore?.getMessages?.(channelId);
      return typeof bucket?.length === "number" && bucket.length > 0;
    },
    me(channelId) {
      const user = getStores().UserStore?.getCurrentUser();
      if (!user) return;
      const guild = ghost ? guildOf(channelId) : undefined;
      return { id: user.id, roles: guild ? getStores().GuildMemberStore?.getMember(guild, user.id)?.roles ?? [] : [] };
    },
    record(entry) {
      state = { ...state, entries: recentEntries([entry, ...state.entries]) };
      emit();
    },
    alert(entry, event) {
      const pending = pendingAlerts.get(event);
      if (pending) { pending.push(entry); return; }
      pendingAlerts.set(event, [entry]);
      const token = generation;
      void Promise.resolve().then(() => {
        const all = pendingAlerts.get(event) ?? [];
        pendingAlerts.delete(event);
        if (!active || token !== generation || !state.settings.alerts) return;
        const allowed = ghost ? all : all.filter(item => !cooperation().gpl?.alerted(event, item.before.id));
        if (allowed.length) {
          const verb = allowed[0].kind === "edited" ? "edited" : "deleted";
          const label = ghost ? "Ghost ping" : "Direct message";
          const title = allowed.length > 1 ? allowed.length + " " + label.toLowerCase() + " events logged"
            : label + " " + verb + " by " + allowed[0].before.author;
          showNotification(title, allowed[0]);
        }
      }).catch(error);
    },
    changed() { if (state.settings.persist || state.settings.rememberReceived) schedule(); },
  });

  function flush() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const target = storage;
    if (!target) return writes;
    const data: Data = {
      settings: state.settings,
      entries: state.settings.persist ? recentEntries(state.entries) : [],
      recent: state.settings.rememberReceived ? engine.snapshot() : [],
    };
    writes = writes.then(async () => { await target.set(data, true); }).catch(error);
    return writes;
  }
  function schedule() {
    if (!storage || timer !== undefined) return;
    timer = setTimeout(() => { void flush(); }, 2000);
  }
  function update(patch: Partial<Preferences>) {
    const prior = state.settings;
    state = { ...state, settings: { ...state.settings, ...patch } };
    state = { ...state, entries: recentEntries(state.entries) };
    emit();
    if (patch.cacheLimit !== undefined) engine.trim();
    if (Object.keys(patch).some(key => inlinePreferences.has(key))) refreshInline();
    if ((prior.persist && !state.settings.persist) || (prior.rememberReceived && !state.settings.rememberReceived)) void flush();
    else schedule();
  }
  function removeEntries(entries: readonly Entry[], sync = true) {
    if (!entries.length) return;
    const selected = new Set(entries);
    state = { ...state, entries: state.entries.filter(entry => !selected.has(entry)) };
    if (!ghost && sync) {
      const gpl = cooperation().gpl;
      for (const entry of entries) {
        if (entry.kind === "edited") gpl?.removeEdits?.(entry.before.channelId, entry.before.id);
      }
    }
    emit();
    refreshInline();
    void flush();
  }
  function clearHistory() {
    generation++;
    removeEntries(state.entries);
  }
  function clearCache() {
    engine.clear();
    void flush();
  }
  function ignoredIds() {
    return [...new Set(state.settings.ignoredIds.split(/[\s,]+/).filter(Boolean))];
  }
  function toggleIgnored(value: string) {
    const ids = ignoredIds();
    update({ ignoredIds: (ids.includes(value) ? ids.filter(id => id !== value) : [...ids, value]).join(", ") });
  }

  function jump(entry: Entry) {
    const [router] = lookupModule(withProps("transitionToGuild", "transitionTo"));
    if (!getChannel(entry.before.channelId) || typeof router?.transitionToGuild !== "function") {
      ToastActionCreators.open(id + ".unavailable", { text: "This channel is unavailable." });
      return;
    }
    router.transitionToGuild(entry.before.guildId || "@me", entry.before.channelId,
      entry.kind === "edited" ? entry.before.id : undefined, { openChannel: true });
  }
  function showDetails(entry: Entry, related: readonly Entry[] = [entry]) {
    const original = entry.before.content || "(No text)";
    const details = related.length > 1 ? related.slice(0, 5).map(item => (item.kind === "edited" ? "Edited: " : "Deleted: ") + (item.before.content || "(No text)")).join("\n\n") : entry.kind === "edited" ? "Before\n" + original + "\n\nAfter\n" + (entry.after || "(No text)") : original;
    AlertActionCreators.openAlert(detailKey,
      <Design.AlertModal title={entry.before.author + " · " + (entry.test ? "test" : entry.kind)}
        content={details.length > 1200 ? details.slice(0, 1200) + "…" : details}
        actions={<>
          {!entry.test && <Design.AlertActionButton text={entry.kind === "edited" ? "Jump to message" : "Open channel"} onPress={() => {
            AlertActionCreators.dismissAlert(detailKey);
            jump(entry);
          }} />}
          <Design.AlertActionButton text={related.length > 1 ? "Remove history" : "Remove from history"} variant="destructive" onPress={() => {
            removeEntries(related);
            AlertActionCreators.dismissAlert(detailKey);
          }} />
          <Design.AlertActionButton text="Close" variant="secondary" onPress={() => AlertActionCreators.dismissAlert(detailKey)} />
        </>} />);
  }
  function showNotification(title: string, entry?: Entry, content?: string) {
    AlertActionCreators.openAlert(notificationKey, <Design.AlertModal title={title}
      content={content ?? (entry?.before.content.slice(0, 400) || undefined)}
      actions={<>
        {entry && !entry.test && <Design.AlertActionButton text={entry.kind === "edited" ? "Jump to message" : "Open channel"} onPress={() => {
          AlertActionCreators.dismissAlert(notificationKey);
          jump(entry);
        }} />}
        <Design.AlertActionButton text="Dismiss" variant="secondary" onPress={() => AlertActionCreators.dismissAlert(notificationKey)} />
      </>} />);
  }
  function testPing() {
    const entry: Entry = {
      test: true, kind: "deleted", at: Date.now(),
      before: { id: "test-" + Date.now(), channelId: "", guildId: "", authorId: "",
        author: "Ghost Ping Logger", bot: false, content: "This is a local test ghost ping.", mentions: [],
        mentioned: false, roles: [], everyone: false, replyTo: "", seenAt: Date.now() },
    };
    state = { ...state, entries: recentEntries([entry, ...state.entries]) };
    emit();
    if (state.settings.persist) schedule();
    showNotification("Test ghost ping", entry);
  }
  function confirmClear(cache: boolean) {
    AlertActionCreators.openAlert(clearKey, <Design.AlertModal title={cache ? "Clear recent message cache?" : "Clear local history?"}
      content={cache ? "This removes recent message snapshots from this device." : "This removes the journal from this device."}
      actions={<>
        <Design.AlertActionButton text="Clear" variant="destructive" onPress={() => { (cache ? clearCache : clearHistory)(); AlertActionCreators.dismissAlert(clearKey); }} />
        <Design.AlertActionButton text="Cancel" variant="secondary" onPress={() => AlertActionCreators.dismissAlert(clearKey)} />
      </>} />);
  }

  function SettingsComponent() {
    const { settings, entries } = useSyncExternalStore(subscribe, getState, getState);
    const [screen, setScreen] = useState<"main" | "history" | "ignored">("main");
    const [filter, setFilter] = useState<HistoryFilter>(defaultHistoryFilter);
    const [limit, setLimit] = useState(25);
    const toggle = (key: keyof Settings, label: string, icon: string, subLabel?: string) =>
      <Design.TableSwitchRow key={key} label={label} subLabel={subLabel} icon={rowIcon(icon)}
        value={settings[key] === true} onValueChange={value => update({ [key]: value })} />;
    const filtered = screen === "history" ? recentEntries(entries).filter(entry => matchesHistory(entry, filter,
      getChannel(entry.before.channelId)?.name, getStores().GuildStore?.getGuild(entry.before.guildId)?.name)) : [];
    const openHistory = (kind: HistoryFilter["kind"]) => {
      setFilter({ ...defaultHistoryFilter, kind });
      setLimit(25);
      setScreen("history");
    };

    return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 18 }}>
      {screen === "history" ? <>
        <Design.Button text="Back to settings" variant="secondary" onPress={() => setScreen("main")} />
        <HistoryFilters value={filter} onChange={value => { setFilter(value); setLimit(25); }}
          saved={settings.savedFilters ?? []} onSavedChange={savedFilters => update({ savedFilters })} />
        <Design.TableRowGroup title="History">
          {filtered.length ? filtered.slice(0, limit).map((entry, index) => (
            <Design.TableRow key={entry.before.id + ":" + entry.at + ":" + index}
              label={entry.before.author + " · " + (entry.test ? "Test" : entry.kind === "edited" ? "Edited" : "Deleted")}
              subLabel={new Date(entry.at).toLocaleString() + "\n" + (entry.before.content || "(No text)")}
              subLabelLineClamp={3} icon={rowIcon(entry.kind === "edited" ? "PencilIcon" : "TrashIcon")}
              arrow onPress={() => showDetails(entry)} />
          )) : <Design.TableRow label={entries.length ? "No matching entries" : "Nothing logged yet"} />}
          {filtered.length > limit && <Design.TableRow label="Show more" onPress={() => setLimit(limit + 25)} />}
        </Design.TableRowGroup>
      </> : screen === "ignored" ? <>
        <Design.Button text="Back to settings" variant="secondary" onPress={() => setScreen("main")} />
        <Design.TableRowGroup title="Ignored items">
          {ignoredIds().length ? ignoredIds().map(value => {
            const guild = getStores().GuildStore?.getGuild(value);
            const channel = getChannel(value);
            const user = getStores().UserStore?.getUser?.(value);
            return <Design.TableRow key={value} label={guild?.name || channel?.name || user?.username || value}
              subLabel={value + " · tap to stop ignoring"} onPress={() => toggleIgnored(value)} />;
          }) : <Design.TableRow label="No ignored items" />}
        </Design.TableRowGroup>
      </> : <>
        <Design.TableRowGroup title="Journal">
          {ghost
            ? <Design.TableRow label="Ghost ping history" icon={rowIcon("ClockIcon")} arrow onPress={() => openHistory("all")} />
            : <>
                <Design.TableRow label="Deleted messages" icon={rowIcon("TrashIcon")} arrow onPress={() => openHistory("deleted")} />
                <Design.TableRow label="Edited messages" icon={rowIcon("PencilIcon")} arrow onPress={() => openHistory("edited")} />
              </>}
        </Design.TableRowGroup>
        <Design.TableRowGroup title="Capture">
          {toggle("logDeletes", "Log deletions", "TrashIcon")}
          {toggle("logEdits", "Log edits", "PencilIcon")}
          {ghost && toggle("direct", "Direct mentions", "AtIcon")}
          {ghost && toggle("replies", "Replies", "ChatMarkUnreadIcon")}
          {ghost && toggle("roles", "Role mentions", "GroupIcon")}
          {ghost && toggle("everyone", "Everyone and here", "BellIcon")}
          {toggle("skipBots", "Skip bots", "RobotIcon")}
          {!ghost && toggle("skipSelf", "Skip my messages", "UserCircleIcon")}
          <Design.TableRow label="Test message capture" icon={rowIcon("WrenchIcon")} onPress={() =>
            showNotification("Message capture", undefined, received + " new messages received this session · " + engine.snapshot().length + " recent snapshots.")} />
        </Design.TableRowGroup>
        <Design.TableRadioGroup title="Capture mode" value={settings.captureMode}
          onChange={value => update({ captureMode: value === "loaded" ? "loaded" : "all" })}>
          <Design.TableRadioRow label="All" value="all" subLabel="Watch all message events Discord receives." />
          <Design.TableRadioRow label="Loaded" value="loaded" subLabel="Watch the open chat and chats with loaded messages." />
        </Design.TableRadioGroup>
        <SettingInput label="Maximum cached messages" description="25–1000 recent snapshots." value={String(settings.cacheLimit)}
          accept={value => { const count = Number(value); if (Number.isInteger(count) && count >= 25 && count <= MaxSnapshotLimit) { update({ cacheLimit: count }); return true; } return false; }} />
        <Design.TableRowGroup title="Alerts">
          {ghost ? <>
            {toggle("alerts", "Show ghost ping alert", "BellIcon")}
            <Design.TableRow label="Send a test ghost ping" icon={rowIcon("WrenchIcon")} onPress={testPing} />
          </> : <>
            {toggle("notifyDeleted", "Notify about deleted DMs", "TrashIcon")}
            {toggle("notifyEdited", "Notify about edited DMs", "PencilIcon")}
          </>}
        </Design.TableRowGroup>
        <Design.TableRowGroup title="In chat">
          {toggle("retainDeleted", "Keep deleted messages visible", "TrashIcon")}
          {!ghost && toggle("showInlineEdits", "Show previous versions in chat", "PencilIcon")}
          {ghost ? toggle("redName", "Color ghost ping usernames", "AtIcon")
            : toggle("colorDeletedUsername", "Color deleted usernames", "UserCircleIcon")}
          {toggle("showDeletedTime", "Show deletion time", "ClockIcon")}
          {toggle("showEditTime", "Show edit time", "ClockIcon")}
          {toggle("use12HourClock", "Use a 12-hour clock", "ClockIcon")}
        </Design.TableRowGroup>
        {(["deletedMessageColor", "editedMessageColor", "deletedNameColor"] as const).map((key, index) =>
          <SettingInput key={key} label={["Deleted message color", "Edited message color", "Deleted username color"][index]}
            description="Hex color, for example #ED4245." value={settings[key]} accept={value => {
              if (!/^#[0-9a-f]{6}$/i.test(value)) return false;
              update({ [key]: value }); return true;
            }} />)}
        <Design.TableRowGroup title="Filters">
          <Design.TableRow label="Ignored items" icon={rowIcon("EyeSlashIcon")} arrow onPress={() => setScreen("ignored")} />
        </Design.TableRowGroup>
        <Design.TextInput label="Ignored IDs" description="Enter channel, server, or user IDs separated by spaces or commas."
          value={settings.ignoredIds} onChange={ignoredIds => update({ ignoredIds })} />
        <Design.TableRowGroup title="Local storage">
          {toggle("persist", "Save history across restarts", "ClipboardListIcon", "Store journal entries on this device.")}
          {toggle("rememberReceived", "Remember new messages", "ClockIcon", "Store recent snapshots separately from the journal.")}
          <Design.TableRow label="Clear local history" icon={rowIcon("TrashIcon")} variant="danger" onPress={() => confirmClear(false)} />
          <Design.TableRow label="Clear recent message cache" icon={rowIcon("TrashIcon")} variant="danger" onPress={() => confirmClear(true)} />
        </Design.TableRowGroup>
        <Design.TableRadioGroup title="History retention" value={String(settings.retentionDays)}
          onChange={value => update({ retentionDays: Number(value) })}>
          {[1, 7, 30, 0].map(days => <Design.TableRadioRow key={days} value={String(days)}
            label={days === 0 ? "Forever" : days + (days === 1 ? " day" : " days")} />)}
        </Design.TableRadioGroup>
        <Design.TableRowGroup title="Quick guide">
          <Design.TableRow label="Capture" subLabel={ghost
            ? "A ghost ping is a message that mentioned you and was later deleted or edited to remove the ping."
            : "Open the journal to see the previous text of edited or deleted messages."} />
          <Design.TableRow label="Privacy" subLabel="The journal uses messages this device received. Nothing is uploaded by this plugin." />
        </Design.TableRowGroup>
      </>}
    </ScrollView>;
  }

  function SettingInput({ label, description, value, accept }: {
    label: string; description: string; value: string; accept(value: string): boolean;
  }) {
    const [draft, setDraft] = useState(value);
    return <Design.TextInput label={label} description={description} value={draft} onChange={setDraft} onBlur={() => {
      const candidate = draft.trim();
      if (accept(candidate)) setDraft(candidate);
      else setDraft(value);
    }} />;
  }

  return plugin<{ jsonStorage: Data }>({
    jsonStorage: { load: true, default: initialData },
    async start({ jsonStorage, cleanup, plugin: instance }) {
      const loaded = await jsonStorage.get();
      const prefs = { ...defaultSettings, ...loaded?.settings };
      if (typeof prefs.ignoredIds !== "string") prefs.ignoredIds = "";
      if (![0, 1, 7, 30].includes(prefs.retentionDays)) prefs.retentionDays = 7;
      if (prefs.captureMode !== "loaded") prefs.captureMode = "all";
      if (!Number.isInteger(prefs.cacheLimit) || prefs.cacheLimit < 25 || prefs.cacheLimit > MaxSnapshotLimit) prefs.cacheLimit = 250;
      if (!Array.isArray(prefs.savedFilters)) prefs.savedFilters = [];
      if (loaded?.settings?.rememberReceived === undefined && prefs.persist) prefs.rememberReceived = true;
      if (!ghost && loaded?.settings?.alerts && loaded?.settings?.notifyEdited === undefined) {
        prefs.notifyEdited = true;
        prefs.notifyDeleted = true;
      }
      if (!ghost) prefs.alerts = true;
      storage = jsonStorage;
      error = err => instance.reportError(err);
      active = true;
      generation++;
      received = 0;
      state = { settings: prefs, entries: [] };
      engine.clear();
      if (prefs.persist) {
        state.entries = recentEntries(Array.isArray(loaded.entries) ? loaded.entries : []);
      }
      if (prefs.rememberReceived) engine.restore(Array.isArray(loaded.recent) ? loaded.recent : []);
      emit();
      const bridge = cooperation();
      const gplService = {
        alerted: engine.alerted,
        removeEdits: (channelId: string, messageId: string) => removeEntries(
          state.entries.filter(entry => entry.kind === "edited" && entry.before.channelId === channelId && entry.before.id === messageId), false),
      };
      const amlService = { lookup: engine.lookup };
      if (ghost) bridge.gpl = gplService;
      else bridge.aml = amlService;
      const unsubscribe = onAnyFluxEventDispatched(payload => {
        if (actions.has(payload.type) && !isInlineEvent(payload as Event)) {
          if (payload.type === "MESSAGE_CREATE") received++;
          try { engine.observe(payload as Event, ghost ? cooperation().aml?.lookup : undefined); }
          catch (err) { error(err); }
        }
        return payload;
      });
      const inline = installInline(mode, () => state.settings, entriesForInline, error);
      refreshInline = inline.refresh;
      const unmenu = ghost ? () => {} : installMenus({
        isIgnored: value => ignoredIds().includes(value),
        toggleIgnored,
        entriesFor: (channelId, messageId) => recentEntries(state.entries).filter(entry =>
          entry.before.channelId === channelId && entry.before.id === messageId),
        inspect: entries => { if (entries[0]) showDetails(entries[0], entries); },
        remove: removeEntries,
        report: error,
      });
      cleanup(async () => {
        active = false;
        generation++;
        unsubscribe();
        unmenu();
        inline.stop();
        refreshInline = () => {};
        if (bridge.gpl === gplService) delete bridge.gpl;
        if (bridge.aml === amlService) delete bridge.aml;
        try {
          await flush();
        } finally {
          storage = undefined;
          engine.clear();
          state = { ...state, entries: [] };
          emit();
          AlertActionCreators.dismissAlert(detailKey);
          AlertActionCreators.dismissAlert(clearKey);
          AlertActionCreators.dismissAlert(notificationKey);
        }
      });
    },
    SettingsComponent,
  });
}
