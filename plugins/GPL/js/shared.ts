import type { SavedFilter } from '../../AML/js/types'

export const DefaultSettings = {
	direct: true,
	replies: true,
	roles: true,
	everyone: true,
	alert: true,
	retainDeleted: true,
	redName: true,
	nameColor: '#ED4245',
	savedFilters: [] as SavedFilter[],
}

export type Settings = typeof DefaultSettings

/** What older versions saved: settings nested next to their own journal. */
export type LegacyStorage = {
	settings?: Partial<Settings> & { alerts?: boolean; deletedNameColor?: string }
	entries?: unknown
	recent?: unknown
}

export const readSettings = (
	saved: Partial<Settings> | undefined,
): Settings => ({ ...DefaultSettings, ...saved })
