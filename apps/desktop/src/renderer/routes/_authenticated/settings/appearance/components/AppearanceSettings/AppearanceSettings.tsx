import type { ReactNode } from "react";
import {
	isItemVisible,
	SETTING_ITEM_ID,
	type SettingItemId,
} from "../../../utils/settings-search";
import { AnimationSection } from "./components/AnimationSection";
import { FontSettingSection } from "./components/FontSettingSection";
import { GlassSection } from "./components/GlassSection";
import { LoadingScreenSection } from "./components/LoadingScreenSection";
import { MarkdownStyleSection } from "./components/MarkdownStyleSection";
import { ThemeSection } from "./components/ThemeSection";
import { WallpaperSection } from "./components/WallpaperSection";

/**
 * Renders a list of visible sections with automatic border separators.
 * Each section is its own component that owns its data-fetching,
 * so query resolutions in one section don't re-render others.
 */
function SectionList({ children }: { children: ReactNode[] }) {
	const visibleChildren = children.filter(Boolean);
	return (
		<div className="space-y-6">
			{visibleChildren.map((child, i) => (
				<div key={(child as React.ReactElement).key ?? i}>{child}</div>
			))}
		</div>
	);
}

interface AppearanceSettingsProps {
	visibleItems?: SettingItemId[] | null;
}

export function AppearanceSettings({ visibleItems }: AppearanceSettingsProps) {
	const showTheme = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_THEME,
		visibleItems,
	);
	const showMarkdown = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_MARKDOWN,
		visibleItems,
	);
	const showEditorFont = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_EDITOR_FONT,
		visibleItems,
	);
	const showUiFont = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_UI_FONT,
		visibleItems,
	);
	const showTerminalFont = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_TERMINAL_FONT,
		visibleItems,
	);
	const showAnimations = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_ANIMATIONS,
		visibleItems,
	);
	const showCustomThemes = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_CUSTOM_THEMES,
		visibleItems,
	);
	const showGlass = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_GLASS,
		visibleItems,
	);
	const showWallpaper = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_WALLPAPER,
		visibleItems,
	);
	const showLoadingScreen = isItemVisible(
		SETTING_ITEM_ID.APPEARANCE_LOADING_SCREEN,
		visibleItems,
	);
	const showThemeSection = showTheme || showCustomThemes;

	return (
		<div className="p-6 max-w-4xl w-full">
			<div className="mb-8">
				<h2 className="text-xl font-semibold">Внешний вид</h2>
				<p className="text-sm text-muted-foreground mt-1">
					Настройте, как Rox выглядит на вашем устройстве
				</p>
			</div>

			<SectionList>
				{showThemeSection && <ThemeSection key="theme" />}
				{showGlass && <GlassSection key="glass" />}
				{showWallpaper && <WallpaperSection key="wallpaper" />}
				{showLoadingScreen && <LoadingScreenSection key="loading-screen" />}
				{showMarkdown && <MarkdownStyleSection key="markdown" />}
				{showAnimations && <AnimationSection key="animations" />}
				{showUiFont && <FontSettingSection key="ui-font" variant="ui" />}
				{showEditorFont && (
					<FontSettingSection key="editor-font" variant="editor" />
				)}
				{showTerminalFont && (
					<FontSettingSection key="terminal-font" variant="terminal" />
				)}
			</SectionList>
		</div>
	);
}
