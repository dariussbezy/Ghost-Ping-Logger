import { useState } from "react";
import { Design } from "@valenced/discord/design";
import type { Entry } from "./events";

export type HistoryFilter = {
  query: string;
  kind: "all" | Entry["kind"];
  author: string;
  channel: string;
  server: string;
  from: string;
  to: string;
};
export type SavedHistoryFilter = { name: string; filter: HistoryFilter };

export const defaultHistoryFilter: HistoryFilter = {
  query: "", kind: "all", author: "", channel: "", server: "", from: "", to: "",
};

function dayStart(value: string): Date | undefined {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(0, 0, 0, 0);
  if (date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day) return date;
}

function matches(query: string, ...values: (string | undefined)[]) {
  const needle = query.trim().toLowerCase();
  return !needle || values.some(value => value?.toLowerCase().includes(needle));
}

export function matchesHistory(entry: Entry, filter: HistoryFilter, channelName?: string, serverName?: string): boolean {
  const { before, after, kind, at } = entry;
  if (filter.kind !== "all" && filter.kind !== kind) return false;
  if (!matches(filter.author.trim().replace(/^@/, ""), before.author, before.authorId)
      || !matches(filter.channel.trim().replace(/^#/, ""), channelName, before.channelId)
      || !matches(filter.server, serverName, before.guildId)) return false;

  const from = dayStart(filter.from.trim());
  const to = dayStart(filter.to.trim());
  if (from && at < from.getTime()) return false;
  if (to) {
    to.setDate(to.getDate() + 1);
    if (at >= to.getTime()) return false;
  }

  return matches(filter.query, kind, before.author, before.authorId, before.content, after,
    before.id, channelName, before.channelId, serverName, before.guildId, new Date(at).toLocaleDateString());
}

type Props = {
  value: HistoryFilter;
  onChange(value: HistoryFilter): void;
  saved: SavedHistoryFilter[];
  onSavedChange(value: SavedHistoryFilter[]): void;
};

export function HistoryFilters({ value, onChange, saved, onSavedChange }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [name, setName] = useState("");
  const active = value.kind !== "all" || [value.query, value.author, value.channel, value.server, value.from, value.to]
    .some(part => part.trim().length > 0);
  const from = dayStart(value.from.trim());
  const to = dayStart(value.to.trim());
  const invalidFrom = !!value.from.trim() && !from;
  const invalidTo = !!value.to.trim() && !to;
  const reversed = from !== undefined && to !== undefined && from.getTime() > to.getTime();
  const cleanName = name.trim();
  const change = (patch: Partial<HistoryFilter>) => onChange({ ...value, ...patch });

  function saveFilter() {
    const filter = {
      ...value,
      query: value.query.trim(),
      author: value.author.trim(),
      channel: value.channel.trim(),
      server: value.server.trim(),
      from: value.from.trim(),
      to: value.to.trim(),
    };
    onSavedChange([{ name: cleanName, filter },
      ...saved.filter(item => item.name.toLowerCase() !== cleanName.toLowerCase())].slice(0, 20));
    setName("");
  }

  return <>
    <Design.TextInput label="Search history" placeholder="Message, sender, channel, date, or event"
      value={value.query} maxLength={200} onChange={query => change({ query })} />
    <Design.TableRowGroup>
      <Design.TableRow label={expanded ? "Hide filters" : "Filters and saved searches"}
        subLabel={active ? "Filters active" : undefined} arrow={!expanded} onPress={() => setExpanded(!expanded)} />
      {active && <Design.TableRow label="Clear filters" onPress={() => onChange(defaultHistoryFilter)} />}
    </Design.TableRowGroup>
    {expanded && <>
      <Design.TableRadioGroup<HistoryFilter["kind"]> title="Event type" value={value.kind}
        onChange={kind => change({ kind })}>
        <Design.TableRadioRow label="All events" value="all" />
        <Design.TableRadioRow label="Edited" value="edited" />
        <Design.TableRadioRow label="Deleted" value="deleted" />
      </Design.TableRadioGroup>
      <Design.TextInput label="Author" placeholder="Name or user ID" value={value.author}
        maxLength={100} onChange={author => change({ author })} />
      <Design.TextInput label="Channel" placeholder="Name or channel ID" value={value.channel}
        maxLength={100} onChange={channel => change({ channel })} />
      <Design.TextInput label="Server" placeholder="Name or server ID" value={value.server}
        maxLength={100} onChange={server => change({ server })} />
      <Design.TextInput label="From date" placeholder="YYYY-MM-DD" value={value.from}
        status={invalidFrom ? "error" : undefined} errorMessage={invalidFrom ? "Enter a date as YYYY-MM-DD." : undefined}
        maxLength={10} onChange={from => change({ from })} />
      <Design.TextInput label="To date" placeholder="YYYY-MM-DD" value={value.to}
        status={invalidTo || reversed ? "error" : undefined}
        errorMessage={invalidTo ? "Enter a date as YYYY-MM-DD." : reversed ? "Use a date on or after the start date." : undefined}
        maxLength={10} onChange={to => change({ to })} />
      <Design.TextInput label="Filter name" placeholder="Name this search" value={name} maxLength={48} onChange={setName} />
      <Design.Button text="Save filter" disabled={!cleanName || !active || invalidFrom || invalidTo || reversed}
        onPress={saveFilter} />
      <Design.TableRowGroup title="Saved filters">
        {saved.length ? saved.map((item, index) =>
          <Design.TableRow key={item.name} label={item.name} subLabel="Tap to apply"
            onPress={() => onChange({ ...item.filter })}
            trailing={<Design.Button text="Remove" size="sm" variant="secondary"
              accessibilityLabel={"Remove filter " + item.name}
              onPress={() => onSavedChange(saved.filter((_, savedIndex) => savedIndex !== index))} />} />
        ) : <Design.TableRow label="No saved filters yet" />}
      </Design.TableRowGroup>
    </>}
  </>;
}
