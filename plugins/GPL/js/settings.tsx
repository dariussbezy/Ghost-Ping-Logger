import { TableRowAssetIcon } from '@valenced/components'
import Page from '@valenced/components/Page'
import { Design } from '@valenced/discord/design'
import { useEffect, useMemo, useState } from 'react'
import { ScrollView } from 'react-native'
import manifest from '../manifest.json'
import { isGhostPing } from './ghost'
import { DefaultSettings, readSettings } from './shared'
import type { AmlApi } from '../../AML/js/types'
import type { Settings } from './shared'

type Screen = 'main' | 'history' | 'color'
type Props = {
	api: {
		aml?: AmlApi
		jsonStorage: {
			use(): Partial<Settings> | undefined
			set(value: Partial<Settings>): Promise<void>
		}
	}
}

const icon = (name: string) => <TableRowAssetIcon name={name} />

export default function SettingsComponent({
	api: { aml, jsonStorage },
}: Props) {
	const stored = jsonStorage.use()
	const settings = useMemo(() => readSettings(stored), [stored])
	const [screen, setScreen] = useState<Screen>('main')
	const journal = useJournal(aml)
	const ghosts = useMemo(
		() => journal.filter(entry => isGhostPing(entry, settings)),
		[journal, settings],
	)
	const set = (patch: Partial<Settings>) => void jsonStorage.set(patch)

	if (!aml) {
		return (
			<ScrollView keyboardShouldPersistTaps="handled">
				<Page>
					<Design.TableRowGroup>
						<Design.TableRow
							icon={icon('CircleInformationIcon')}
							label="Adv. Message Logger is not running"
							subLabel="Ghost Ping Logger reads its journal. Enable Adv. Message Logger first."
						/>
					</Design.TableRowGroup>
				</Page>
			</ScrollView>
		)
	}

	const back = (
		<Design.Button
			text="Back to settings"
			variant="secondary"
			onPress={() => setScreen('main')}
		/>
	)
	const toggle = (key: keyof Settings, label: string, iconName: string) => (
		<Design.TableSwitchRow
			label={label}
			icon={icon(iconName)}
			value={settings[key] === true}
			onValueChange={value => set({ [key]: value })}
		/>
	)

	if (screen === 'color') {
		return (
			<ScrollView keyboardShouldPersistTaps="handled">
				<Page>
					<Design.Stack spacing={24}>
						{back}
						<aml.components.ColorRows
							title="Ghost ping username color"
							value={settings.nameColor}
							fallback={DefaultSettings.nameColor}
							onSelect={nameColor => {
								set({ nameColor })
								setScreen('main')
							}}
						/>
					</Design.Stack>
				</Page>
			</ScrollView>
		)
	}

	if (screen === 'history') {
		return (
			<ScrollView keyboardShouldPersistTaps="handled">
				<Page>
					<Design.Stack spacing={24}>
						{back}
						<aml.components.HistoryView
							entries={ghosts}
							saved={settings.savedFilters}
							onSavedChange={savedFilters => set({ savedFilters })}
						/>
					</Design.Stack>
				</Page>
			</ScrollView>
		)
	}

	return (
		<ScrollView keyboardShouldPersistTaps="handled">
			<Page>
				<Design.Stack spacing={24}>
					<Design.TableRowGroup title="Journal">
						<Design.TableRow
							label="Ghost ping history"
							subLabel={`${ghosts.length} logged`}
							icon={icon('ClockIcon')}
							arrow
							onPress={() => setScreen('history')}
						/>
					</Design.TableRowGroup>
					<Design.TableRowGroup title="Detect">
						{toggle('direct', 'Direct mentions', 'AtIcon')}
						{toggle('replies', 'Replies', 'ChatMarkUnreadIcon')}
						{toggle('roles', 'Role mentions', 'GroupIcon')}
						{toggle('everyone', 'Everyone and here', 'BellIcon')}
					</Design.TableRowGroup>
					<Design.TableRowGroup title="Alerts">
						{toggle('alert', 'Show ghost ping alert', 'BellIcon')}
					</Design.TableRowGroup>
					<Design.TableRowGroup title="In chat">
						{toggle(
							'retainDeleted',
							'Keep deleted ghost pings visible',
							'TrashIcon',
						)}
						{toggle('redName', 'Color ghost ping usernames', 'AtIcon')}
						<Design.TableRow
							label="Username color"
							icon={icon('PaintPaletteIcon')}
							trailing={<aml.components.Swatch color={settings.nameColor} />}
							arrow
							onPress={() => setScreen('color')}
						/>
					</Design.TableRowGroup>
					<Design.TableRowGroup title="Quick guide">
						<Design.TableRow
							icon={icon('CircleInformationIcon')}
							label="Uses Adv. Message Logger"
							subLabel="Ghost pings are found in the journal of Adv. Message Logger. Its ignore list, retention, cache and bot filter decide what can appear here, and its colors and clock style apply to retained messages."
						/>
						<Design.TableRow
							icon={icon('CircleInformationIcon')}
							label="What counts"
							subLabel="A ghost ping is a message that mentioned you and was then deleted, or edited so it no longer does."
						/>
					</Design.TableRowGroup>
					<Design.Text
						variant="text-xs/normal"
						color="text-muted"
						style={{ textAlign: 'center' }}
					>
						{`Ghost Ping Logger ${manifest.version}`}
					</Design.Text>
				</Design.Stack>
			</Page>
		</ScrollView>
	)
}

/** The AML journal, re-read whenever it changes. */
function useJournal(aml: AmlApi | undefined) {
	const [entries, setEntries] = useState(() => aml?.getEntries() ?? [])
	useEffect(() => {
		if (!aml) return
		setEntries(aml.getEntries())
		return aml.subscribe(() => setEntries(aml.getEntries()))
	}, [aml])
	return entries
}
