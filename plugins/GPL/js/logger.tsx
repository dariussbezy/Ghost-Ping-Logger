import { useState, useSyncExternalStore } from "react";
import { ScrollView } from "react-native";
import { getAssetIdByName } from "@valenced/assets";
import { AlertActionCreators, ToastActionCreators } from "@valenced/discord/actions";
import { Design } from "@valenced/discord/design";
import { Stores, onFluxEventDispatched } from "@valenced/discord/flux";
import { lookupModule } from "@valenced/modules/finders";
import { withProps } from "@valenced/modules/finders/filters";
import { cooperation, createEngine, defaults, EntryLimit } from "./events";
import type { Entry, Event, Message, Mode, Settings, Snapshot } from "./events";

type Data = { settings: Settings; entries: Entry[]; recent: Snapshot[] };
type Storage = { set(data: Data, replace: boolean): Promise<unknown> };
const actions = ["MESSAGE_CREATE", "MESSAGE_UPDATE", "MESSAGE_DELETE", "MESSAGE_DELETE_BULK"] as const;
const day = 24 * 60 * 60 * 1000;

function rowIcon(name: string) {
  const source = getAssetIdByName(name);
  return source ? <Design.TableRow.Icon source={source} /> : undefined;
}

const getStores = () => Stores as unknown as {
  ChannelStore?: { getChannel(id: string): { guild_id?: string; guildId?: string; name?: string; type?: number } | undefined };
  UserStore?: { getCurrentUser(): { id: string } | undefined };
  GuildMemberStore?: { getMember(guild: string, user: string): { roles?: string[] } | undefined };
  MessageStore?: { getMessage(channel: string, id: string): Message | undefined };
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
  const defaultSettings = { ...defaults, alerts: ghost };
  const initialData: Data = { settings: defaultSettings, entries: [], recent: [] };
  let state = { settings: defaultSettings, entries: [] as Entry[] };
  let storage: Storage | undefined;
  let error: (err: unknown) => void = () => {};
  let timer: ReturnType<typeof setTimeout> | undefined;
  let writes = Promise.resolve();
  let active = false;
  let generation = 0;
  const subscribers = new Set<() => void>();
  const subscribe = (fn: () => void) => {
    subscribers.add(fn);
    return () => { subscribers.delete(fn); };
  };
  const getState = () => state;
  const emit = () => { for (const fn of subscribers) fn(); };
  const recentEntries = (entries: Entry[]) => {
    const cutoff = Date.now() - state.settings.retentionDays * day;
    return entries.filter(x => x?.before?.id && x.at >= cutoff).slice(0, EntryLimit);
  };

  const pendingAlerts = new WeakMap<Event, Entry[]>();
  const engine = createEngine(mode, {
    settings: () => state.settings,
    channel: getChannel,
    reference: getMessage,
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
          ToastActionCreators.open(id + ".event", {
            text: allowed.length > 1 ? allowed.length + " " + label.toLowerCase() + " events logged"
              : label + " " + verb + " by " + allowed[0].before.author,
          });
        }
      }).catch(error);
    },
    changed() { if (state.settings.persist) schedule(); },
  });

  function flush() {
    if (timer !== undefined) { clearTimeout(timer); timer = undefined; }
    const target = storage;
    if (!target) return writes;
    const data: Data = {
      settings: state.settings,
      entries: state.settings.persist ? recentEntries(state.entries) : [],
      recent: state.settings.persist ? engine.snapshot() : [],
    };
    writes = writes.then(async () => { await target.set(data, true); }).catch(error);
    return writes;
  }
  function schedule() {
    if (!storage || timer !== undefined) return;
    timer = setTimeout(() => { void flush(); }, 2000);
  }
  function update(patch: Partial<Settings>) {
    const prior = state.settings.persist;
    state = { ...state, settings: { ...state.settings, ...patch } };
    state = { ...state, entries: recentEntries(state.entries) };
    emit();
    if (prior && !state.settings.persist) void flush();
    else schedule();
  }
  function clear() {
    generation++;
    engine.clear();
    state = { ...state, entries: [] };
    emit();
    void flush();
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
  function showDetails(entry: Entry) {
    const original = entry.before.content || "(No text)";
    const details = entry.kind === "edited" ? "Before\n" + original + "\n\nAfter\n" + (entry.after || "(No text)") : original;
    AlertActionCreators.openAlert(detailKey,
      <Design.AlertModal title={entry.before.author + " · " + entry.kind}
        content={details.length > 1200 ? details.slice(0, 1200) + "…" : details}
        actions={<>
          <Design.AlertActionButton text={entry.kind === "edited" ? "Jump to message" : "Open channel"} onPress={() => {
            AlertActionCreators.dismissAlert(detailKey);
            jump(entry);
          }} />
          <Design.AlertActionButton text="Close" variant="secondary" onPress={() => AlertActionCreators.dismissAlert(detailKey)} />
        </>} />);
  }
  function confirmClear() {
    AlertActionCreators.openAlert(clearKey, <Design.AlertModal title="Clear local history?"
      content="This removes the journal and recent message snapshots from this device."
      actions={<>
        <Design.AlertActionButton text="Clear" variant="destructive" onPress={() => { clear(); AlertActionCreators.dismissAlert(clearKey); }} />
        <Design.AlertActionButton text="Cancel" variant="secondary" onPress={() => AlertActionCreators.dismissAlert(clearKey)} />
      </>} />);
  }

  function SettingsComponent() {
    const { settings, entries } = useSyncExternalStore(subscribe, getState, getState);
    const [history, setHistory] = useState(false);
    const [query, setQuery] = useState("");
    const [limit, setLimit] = useState(25);
    const toggle = (key: keyof Settings, label: string, icon: string, subLabel?: string) =>
      <Design.TableSwitchRow key={key} label={label} subLabel={subLabel} icon={rowIcon(icon)}
        value={settings[key] === true} onValueChange={value => update({ [key]: value })} />;
    const needle = query.trim().toLowerCase();
    const filtered = recentEntries(entries).filter(entry => !needle || [
      entry.kind, entry.before.author, entry.before.content, entry.after,
      getChannel(entry.before.channelId)?.name, entry.before.channelId, entry.before.guildId,
      new Date(entry.at).toLocaleDateString(),
    ].some(value => value?.toLowerCase().includes(needle)));

    return <ScrollView keyboardShouldPersistTaps="handled" contentContainerStyle={{ padding: 16, paddingBottom: 40, gap: 18 }}>
      {history ? <>
        <Design.Button text="Back to settings" variant="secondary" onPress={() => setHistory(false)} />
        <Design.TextInput label="Search history" placeholder="Message, sender, channel, date, or event" value={query}
          onChange={value => { setQuery(value); setLimit(25); }} />
        <Design.TableRowGroup title="History">
          {filtered.length ? filtered.slice(0, limit).map((entry, index) => (
            <Design.TableRow key={entry.before.id + ":" + entry.at + ":" + index}
              label={entry.before.author + " · " + (entry.kind === "edited" ? "Edited" : "Deleted")}
              subLabel={new Date(entry.at).toLocaleString() + "\n" + (entry.before.content || "(No text)")}
              subLabelLineClamp={3} icon={rowIcon(entry.kind === "edited" ? "PencilIcon" : "TrashIcon")}
              arrow onPress={() => showDetails(entry)} />
          )) : <Design.TableRow label={needle ? "No matching entries" : "Nothing logged yet"} />}
          {filtered.length > limit && <Design.TableRow label="Show more" onPress={() => setLimit(limit + 25)} />}
        </Design.TableRowGroup>
      </> : <>
        <Design.TableRowGroup title="Journal">
          <Design.TableRow label={ghost ? "Ghost ping history" : "Message history"} icon={rowIcon("ClockIcon")} arrow
            subLabel="Search edits and deletions received by this device." onPress={() => { setHistory(true); setLimit(25); }} />
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
          {toggle("alerts", ghost ? "Ghost ping notifications" : "Direct message notifications", "BellIcon")}
        </Design.TableRowGroup>
        <Design.TextInput label="Ignored IDs" description="Enter channel, server, or user IDs separated by spaces or commas."
          value={settings.ignoredIds} onChange={ignoredIds => update({ ignoredIds })} />
        <Design.TableRowGroup title="Local storage">
          {toggle("persist", "Save across restarts", "ClipboardListIcon", "Store recent snapshots and history on this device.")}
          <Design.TableRow label="History retention" icon={rowIcon("ClockIcon")}
            subLabel={settings.retentionDays + " days · tap to change"} onPress={() => update({
              retentionDays: settings.retentionDays === 7 ? 30 : settings.retentionDays === 30 ? 1 : 7,
            })} />
          <Design.TableRow label="Clear local history" icon={rowIcon("TrashIcon")} variant="danger" onPress={confirmClear} />
        </Design.TableRowGroup>
        <Design.TableRowGroup title="Quick guide">
          <Design.TableRow label="Capture" subLabel={ghost
            ? "A ghost ping is a message that mentioned you and was later deleted or edited to remove the ping."
            : "Open the journal to see the previous text of edited or deleted messages."} />
          <Design.TableRow label="Privacy" subLabel="The journal uses messages this device received. Nothing is uploaded by this plugin." />
        </Design.TableRowGroup>
      </>}
    </ScrollView>;
  }

  return plugin<{ jsonStorage: Data }>({
    jsonStorage: { load: true, default: initialData },
    async start({ jsonStorage, cleanup, plugin: instance }) {
      const loaded = await jsonStorage.get();
      const prefs = { ...defaultSettings, ...loaded?.settings };
      if (typeof prefs.ignoredIds !== "string") prefs.ignoredIds = "";
      if (![1, 7, 30].includes(prefs.retentionDays)) prefs.retentionDays = 7;
      storage = jsonStorage;
      error = err => instance.reportError(err);
      active = true;
      generation++;
      state = { settings: prefs, entries: [] };
      engine.clear();
      if (prefs.persist) {
        state.entries = recentEntries(Array.isArray(loaded.entries) ? loaded.entries : []);
        engine.restore(Array.isArray(loaded.recent) ? loaded.recent : []);
      }
      emit();
      const bridge = cooperation();
      const gplService = { alerted: engine.alerted };
      const amlService = { lookup: engine.lookup };
      if (ghost) bridge.gpl = gplService;
      else bridge.aml = amlService;
      const unsub = actions.map(type => onFluxEventDispatched(type, payload => {
        try { engine.observe(payload as Event, ghost ? cooperation().aml?.lookup : undefined); }
        catch (err) { error(err); }
        return payload;
      }));
      cleanup(async () => {
        active = false;
        generation++;
        for (const fn of unsub) fn();
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
        }
      });
    },
    SettingsComponent,
  });
}
