import { getAssetIdByName } from "@valenced/assets";
import { ActionSheetActionCreators } from "@valenced/discord/actions";
import { Design } from "@valenced/discord/design";
import { getModules } from "@valenced/modules/finders";
import { withName } from "@valenced/modules/finders/filters";
import { before, instead } from "@valenced/patcher";
import { cloneElement, createElement, isValidElement, useSyncExternalStore, type ReactNode } from "react";
import type { Entry } from "./events";

interface Callbacks {
  subscribe?(listener: () => void): () => void;
  version?(): unknown;
  mode?: "aml" | "gpl";
  nameFor?(id: string): string | undefined;
  isIgnored(id: string): boolean;
  toggleIgnored(id: string, scope?: Scope): void;
  entriesFor(channelId: string, messageId: string): readonly Entry[];
  inspect(entries: readonly Entry[]): void;
  remove(entries: readonly Entry[]): void;
  report(error: unknown): void;
}

export type Scope = "user" | "server" | "channel" | "DM";
type Target = { id?: string; type?: number; guild_id?: string; guildId?: string };
type Context = {
  channel?: Target | string;
  guild?: Target | string;
  channelId?: string;
  channel_id?: string;
  guildId?: string;
  guild_id?: string;
  user?: Target;
  profileUser?: Target;
  userId?: string;
  targetUser?: Target;
  userProfile?: { user?: Target };
  message?: { id?: string; channel_id?: string; channelId?: string; author?: Target };
};
type Row = { label: string; icon: string; action(): void; destructive?: boolean };
type Props = { children?: ReactNode; items?: unknown[] };
type Component = (props: unknown) => ReactNode;
type Module = { default?: Component; [key: string]: unknown };
type RenderParent = Record<string, (...args: unknown[]) => ReactNode>;

function idOf(target: Target | string | undefined) {
  return typeof target === "string" ? target : target?.id;
}

function nameOf(component: unknown) {
  const named = component as { displayName?: string; name?: string } | null;
  return named?.displayName ?? named?.name;
}

function rewrite(root: ReactNode, visit: (node: React.ReactElement<Props>) => ReactNode | undefined): ReactNode {
  let replaced = false;
  function walk(node: ReactNode): ReactNode {
    if (replaced) return node;
    if (Array.isArray(node)) {
      const children = node.map(walk);
      return replaced ? children : node;
    }
    if (!isValidElement<Props>(node)) return node;
    const result = visit(node);
    if (result !== undefined) {
      replaced = true;
      return result;
    }
    const children = walk(node.props.children);
    return replaced ? cloneElement(node, { children }) : node;
  }
  return walk(root);
}

const menuGlobal = globalThis as typeof globalThis & {
  __dariussLoggerMenusV1?: { participants: Map<string, Callbacks>; stop: () => void };
};
export function installMenus(callbacks: Callbacks): () => void {
  let shared = menuGlobal.__dariussLoggerMenusV1;
  if (!shared) {
    const participants = new Map<string, Callbacks>();
    const owner = () => participants.get("aml") ?? participants.get("gpl")!;
    const stop = attachMenus({
      nameFor: id => owner()?.nameFor?.(id),
      isIgnored: id => owner()?.isIgnored(id) ?? false,
      toggleIgnored: (id, scope) => owner()?.toggleIgnored(id, scope),
      entriesFor: (channel, message) => owner()?.entriesFor(channel, message) ?? [],
      inspect: entries => owner()?.inspect(entries),
      remove: entries => owner()?.remove(entries),
      report: error => owner()?.report(error),
      subscribe: listener => owner()?.subscribe?.(listener) ?? (() => {}),
      version: () => owner()?.version?.() ?? null,
    });
    shared = { participants, stop };
    menuGlobal.__dariussLoggerMenusV1 = shared;
  }
  const key = callbacks.mode ?? "aml";
  shared.participants.set(key, callbacks);
  return () => {
    if (shared.participants.get(key) !== callbacks) return;
    shared.participants.delete(key);
    if (!shared.participants.size) {
      shared.stop();
      if (menuGlobal.__dariussLoggerMenusV1 === shared) delete menuGlobal.__dariussLoggerMenusV1;
    }
  };
}
function attachMenus(callbacks: Callbacks): () => void {
  let active = true;
  const cleanups: (() => void)[] = [];
  const patchedModules = new WeakSet<object>();
  const subscribe = (listener: () => void) => callbacks.subscribe?.(listener) ?? (() => {});
  const version = () => callbacks.version?.() ?? null;

  function ignoreRow(id: string, scope: Scope): Row {
    const name = callbacks.nameFor?.(id) || "this " + scope;
    return {
      label: callbacks.isIgnored(id) ? `Stop ignoring ${name} in logger` : `Ignore ${name} in logger`,
      icon: "EyeSlashIcon",
      action: () => callbacks.toggleIgnored(id, scope),
    };
  }

  function resolveRows(key: string, ctx: Context): Row[] {
    const message = ctx.message;
    if (/^(?:MessageLongPress|LongPressMessage)ActionSheet$/i.test(key) && message?.id) {
      const channelId = message.channel_id ?? message.channelId ?? ctx.channelId ?? ctx.channel_id ?? idOf(ctx.channel);
      const entries = channelId ? callbacks.entriesFor(channelId, message.id) : [];
      const rows: Row[] = [];
      if (entries.length) {
        const deleted = entries.some(entry => entry.kind === "deleted");
        const edited = entries.some(entry => entry.kind === "edited");
        rows.push(
          { label: edited ? "View edit history" : "View logged message", icon: "ClockIcon", action: () => callbacks.inspect(entries) },
          { label: deleted ? "Remove logged message" : "Remove edit history", icon: "TrashIcon", destructive: true, action: () => callbacks.remove(entries) },
        );
      }
      if (message.author?.id) rows.push(ignoreRow(message.author.id, "user"));
      return rows;
    }

    if (/reaction|emoji|sticker|mute|notif|setting|permission|invite|share|report|forward/i.test(key)) return [];
    if (!/LongPress|ContextMenu|ActionSheet/i.test(key)) return [];
    if (/user|profile/i.test(key)) {
      const userId = ctx.user?.id ?? ctx.profileUser?.id ?? ctx.targetUser?.id ?? ctx.userProfile?.user?.id ?? ctx.userId;
      return userId ? [ignoreRow(userId, "user")] : [];
    }
    if (/channel|^dm|directmessage/i.test(key)) {
      const channelId = idOf(ctx.channel) ?? ctx.channelId ?? ctx.channel_id;
      const type = typeof ctx.channel === "object" ? ctx.channel.type : undefined;
      const scope = type === 1 || type === 3 || /directmessage|privatechannel|^DM/i.test(key) ? "DM" : "channel";
      return channelId ? [ignoreRow(channelId, scope)] : [];
    }
    if (/guild|server/i.test(key)) {
      const guildId = idOf(ctx.guild) ?? ctx.guildId ?? ctx.guild_id;
      return guildId ? [ignoreRow(guildId, "server")] : [];
    }
    return [];
  }

  function appendRows(root: ReactNode, key: string, rows: Row[]) {
    return rewrite(root, node => {
      if (node.type !== Design.ActionSheet && nameOf(node.type) !== "ActionSheet") return;
      const children = [node.props.children].flat();
      if (children.some(child => isValidElement(child) && child.key === "logger-menu")) return node;
      const group = (
        <Design.ActionSheetRow.Group key="logger-menu">
          {rows.map(row => {
            const source = getAssetIdByName(row.icon);
            return (
              <Design.ActionSheetRow
                key={row.label}
                label={row.label}
                variant={row.destructive ? "danger" : "default"}
                icon={source == null ? undefined : <Design.ActionSheetRow.Icon source={source} />}
                onPress={() => {
                  if (!active) return;
                  try {
                    ActionSheetActionCreators.hideActionSheet(key);
                    row.action();
                  } catch (error) {
                    callbacks.report(error);
                  }
                }}
              />
            );
          })}
        </Design.ActionSheetRow.Group>
      );
      return cloneElement(node, { children: [...children, group] });
    });
  }

  function wrapSheet(sheet: Component, key: string, context: Context): Component {
    const connected = new WeakMap<Component, Component>();
    return function LoggerSheet(props) {
      useSyncExternalStore(subscribe, version, version);
      const tree = sheet(props);
      if (!active) return tree;
      try {
        const rows = resolveRows(key, { ...context, ...(props as Context) });
        const result = rows.length ? appendRows(tree, key, rows) : tree;
        if (result !== tree) return result;
        return rewrite(tree, node => {
          if (typeof node.type !== "function" || !/(?:Channel|Guild|Server|PrivateChannel|DM).*Connected$/.test(nameOf(node.type) ?? "")) return;
          const Inner = node.type as Component;
          let Wrapped = connected.get(Inner);
          if (!Wrapped) {
            Wrapped = function LoggerConnectedSheet(innerProps) {
              useSyncExternalStore(subscribe, version, version);
              const child = Inner(innerProps);
              if (!active) return child;
              try {
                const current = resolveRows(key, { ...context, ...(innerProps as Context) });
                return current.length ? appendRows(child, key, current) : child;
              } catch (error) {
                callbacks.report(error);
                return child;
              }
            };
            connected.set(Inner, Wrapped);
          }
          return createElement(Wrapped, { ...node.props, key: node.key });
        });
      } catch (error) {
        callbacks.report(error);
        return tree;
      }
    };
  }

  function patchProfile(namespace: unknown) {
    const mod = namespace as Record<string, unknown> | undefined;
    const component = mod?.default;
    if (!mod || !component) return;
    const nested = component as Record<string, unknown>;
    const [owner, key] = typeof component === "function" ? [mod, "default"]
      : typeof nested.render === "function" ? [nested, "render"]
      : [nested, "type"];
    if (!active || typeof owner[key] !== "function" || patchedModules.has(owner)) return;
    try {
      const unpatch = instead(owner as RenderParent, key, function (args, original) {
        useSyncExternalStore(subscribe, version, version);
        const tree = Reflect.apply(original, this, args);
        const props = args[0] as Context | undefined;
        const id = props?.user?.id ?? props?.profileUser?.id ?? props?.targetUser?.id ?? props?.userProfile?.user?.id ?? props?.userId;
        if (!active || !id) return tree;
        try {
          return rewrite(tree, node => {
            // Profile menus can wrap the native ContextMenu in memo or connected components.
            if (!Array.isArray(node.props.items)) return;
            const { label, action } = ignoreRow(id, "user");
            if (node.props.items.some(item => (item as { label?: string })?.label === label)) return node;
            return cloneElement(node, { items: [...node.props.items, { label, action }] });
          });
        } catch (error) {
          callbacks.report(error);
          return tree;
        }
      });
      patchedModules.add(owner);
      cleanups.push(unpatch);
    } catch (error) {
      callbacks.report(error);
    }
  }

  function watchSheet(name: string, key: string) {
    return getModules(withName(name), namespace => {
      const mod = namespace as Module | undefined;
      const component = mod?.default;
      if (!active || !mod || !component) return;
      const nested = component as unknown as Record<string, unknown>;
      const [owner, field] = typeof component === "function" ? [mod, "default"]
        : typeof nested.render === "function" ? [nested, "render"] : [nested, "type"];
      if (typeof owner[field] !== "function" || patchedModules.has(owner)) return;
      try {
        const wrappers = new WeakMap<Component, Component>();
        cleanups.push(instead(owner as RenderParent, field, function ([props], original) {
          let wrapped = wrappers.get(original);
          if (!wrapped) {
            wrapped = wrapSheet(original, key, {});
            wrappers.set(original, wrapped);
          }
          return wrapped(props);
        }));
        patchedModules.add(owner);
      } catch (error) {
        callbacks.report(error);
      }
    }, { returnNamespace: true });
  }

  try {
    cleanups.push(before(ActionSheetActionCreators, "openLazy", args => {
      const [promise, key, context] = args;
      if (!active || !promise || typeof promise.then !== "function" || typeof key !== "string") return args;
      const ctx = (context ?? {}) as Context;
      try {
        if (!resolveRows(key, ctx).length && !/^(?:Guild|Server|Channel|PrivateChannel|DM).*ActionSheet$/i.test(key)) return args;
      } catch (error) {
        callbacks.report(error);
        return args;
      }
      args[0] = (promise as Promise<Module>).then(mod => (
        active && typeof mod?.default === "function" ? { ...mod, default: wrapSheet(mod.default, key, ctx) } : mod
      )) as typeof promise;
      return args;
    }));
  } catch (error) {
    callbacks.report(error);
  }
  try {
    cleanups.push(getModules(withName("UserProfileOverflowMenu"), patchProfile, { returnNamespace: true }));
    cleanups.push(watchSheet("LongPressMessageActionSheet", "MessageLongPressActionSheet"));
    cleanups.push(watchSheet("ChannelLongPressActionSheet", "ChannelLongPressActionSheet"));
    cleanups.push(watchSheet("GuildActionSheet", "GuildActionSheet"));
    cleanups.push(watchSheet("GuildLongPressActionSheet", "GuildLongPressActionSheet"));
    cleanups.push(watchSheet("DMListLongPressActionSheet", "DMListLongPressActionSheet"));
  } catch (error) {
    callbacks.report(error);
  }
  return () => {
    active = false;
    for (const cleanup of cleanups.splice(0).reverse()) {
      try { cleanup(); } catch (error) { callbacks.report(error); }
    }
  };
}
