import { isGhostPing } from './ghost'
import SettingsComponent from './settings'
import { DefaultSettings, readSettings } from './shared'
import type { Entry } from '../../AML/js/types'
import type { LegacyStorage, Settings } from './shared'

export default plugin<{ jsonStorage: Settings }>({
	jsonStorage: { load: true, default: DefaultSettings },
	async start({ aml, jsonStorage, cleanup, plugin: instance }) {
		if (!aml) throw new Error('Adv. Message Logger is required')
		const saved = (await jsonStorage.get()) as Settings & LegacyStorage
		// Versions before 2 kept a journal and nested settings of their own; the journal now lives in AML.
		if (saved.settings || saved.entries) {
			const { alerts, deletedNameColor, ...rest } = saved.settings ?? {}
			await jsonStorage.set(
				readSettings({
					...rest,
					alert: alerts ?? DefaultSettings.alert,
					nameColor: deletedNameColor ?? DefaultSettings.nameColor,
				}),
				true,
			)
		}

		const settings = () => readSettings(jsonStorage.cache)
		let pending: Entry[] = []
		cleanup(
			aml.onEntry(entry => {
				if (!settings().alert || !isGhostPing(entry, settings())) return
				pending.push(entry)
				if (pending.length === 1) {
					void Promise.resolve()
						.then(() => {
							const [first] = pending
							aml.notify(
								pending.length > 1
									? `${pending.length} ghost ping events logged`
									: `Ghost ping ${first.kind} by ${first.before.author}`,
								first,
							)
							pending = []
						})
						.catch(error => instance.reportError(error))
				}
			}),
			aml.addInlineProvider({
				retains: entry =>
					settings().retainDeleted && isGhostPing(entry, settings()),
				nameColor: entries =>
					settings().redName &&
					entries.some(entry => isGhostPing(entry, settings()))
						? settings().nameColor
						: undefined,
			}),
			// Colors and the retention switch change how AML draws rows.
			jsonStorage.subscribe(() => aml.refreshInline()),
		)
	},
	SettingsComponent,
})
