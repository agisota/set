import {
	DEFAULT_SETTINGS_UI_FONT_FAMILY,
	DEFAULT_SETTINGS_UI_FONT_SIZE,
} from "@rox/local-db/schema";
import { Button } from "@rox/ui/button";
import { Input } from "@rox/ui/input";
import { useCallback, useEffect, useState } from "react";
import { electronTrpc } from "renderer/lib/electron-trpc";
import {
	DEFAULT_TERMINAL_FONT_FAMILY,
	DEFAULT_TERMINAL_FONT_SIZE,
} from "renderer/screens/main/components/WorkspaceView/ContentView/TabsContent/Terminal/config";
import {
	DEFAULT_CODE_EDITOR_FONT_FAMILY,
	DEFAULT_CODE_EDITOR_FONT_SIZE,
} from "renderer/screens/main/components/WorkspaceView/components/CodeEditor/constants";
import { FontFamilyCombobox } from "./components/FontFamilyCombobox";
import { FontPreview } from "./components/FontPreview";
import { useSystemFonts } from "./hooks/useSystemFonts";

const VARIANT_CONFIG = {
	ui: {
		title: "Шрифт интерфейса",
		description:
			"Шрифт, который используется в навигации, настройках и app chrome. Не влияет на терминал и редактор.",
		defaultFamily: DEFAULT_SETTINGS_UI_FONT_FAMILY,
		defaultSize: DEFAULT_SETTINGS_UI_FONT_SIZE,
		familyKey: "uiFontFamily",
		sizeKey: "uiFontSize",
	},
	editor: {
		title: "Шрифт редактора",
		description:
			"Шрифт, который используется в diff-представлениях и редакторах файлов",
		defaultFamily: DEFAULT_CODE_EDITOR_FONT_FAMILY,
		defaultSize: DEFAULT_CODE_EDITOR_FONT_SIZE,
		familyKey: "editorFontFamily",
		sizeKey: "editorFontSize",
	},
	terminal: {
		title: "Шрифт терминала",
		description: "Шрифт, который используется в панелях терминала.",
		defaultFamily: DEFAULT_TERMINAL_FONT_FAMILY,
		defaultSize: DEFAULT_TERMINAL_FONT_SIZE,
		familyKey: "terminalFontFamily",
		sizeKey: "terminalFontSize",
	},
} as const;

interface FontSettingSectionProps {
	variant: "ui" | "editor" | "terminal";
}

export function FontSettingSection({ variant }: FontSettingSectionProps) {
	const config = VARIANT_CONFIG[variant];

	const utils = electronTrpc.useUtils();

	const { data: fontSettings, isLoading } =
		electronTrpc.settings.getFontSettings.useQuery();

	const setFontSettings = electronTrpc.settings.setFontSettings.useMutation({
		onMutate: async (input) => {
			await utils.settings.getFontSettings.cancel();
			const previous = utils.settings.getFontSettings.getData();
			utils.settings.getFontSettings.setData(undefined, (old) => ({
				uiFontFamily: old?.uiFontFamily ?? null,
				uiFontSize: old?.uiFontSize ?? null,
				terminalFontFamily: old?.terminalFontFamily ?? null,
				terminalFontSize: old?.terminalFontSize ?? null,
				editorFontFamily: old?.editorFontFamily ?? null,
				editorFontSize: old?.editorFontSize ?? null,
				...input,
			}));
			return { previous };
		},
		onError: (_err, _vars, context) => {
			if (context?.previous !== undefined) {
				utils.settings.getFontSettings.setData(undefined, context.previous);
			}
		},
		onSettled: () => {
			utils.settings.getFontSettings.invalidate();
		},
	});

	const { fonts: systemFonts, isLoading: fontsLoading } = useSystemFonts();

	const [fontSizeDraft, setFontSizeDraft] = useState<string | null>(null);

	// biome-ignore lint/correctness/useExhaustiveDependencies: sync draft state when fontSettings changes
	useEffect(() => {
		setFontSizeDraft(null);
	}, [fontSettings]);

	const currentFamily = fontSettings?.[config.familyKey] ?? null;
	const currentSize = fontSettings?.[config.sizeKey] ?? null;

	const handleFontFamilyChange = useCallback(
		(value: string | null) => {
			setFontSettings.mutate({
				[config.familyKey]: value,
			});
		},
		[setFontSettings, config.familyKey],
	);

	const handleFontSizeBlur = useCallback(
		(e: React.FocusEvent<HTMLInputElement>) => {
			const value = Number.parseInt(e.target.value, 10);
			if (!Number.isNaN(value) && value >= 10 && value <= 24) {
				setFontSettings.mutate({ [config.sizeKey]: value });
			}
		},
		[setFontSettings, config.sizeKey],
	);

	const previewFamily = currentFamily ?? config.defaultFamily;
	const previewSize =
		(fontSizeDraft != null ? Number.parseInt(fontSizeDraft, 10) : undefined) ||
		currentSize ||
		config.defaultSize;

	return (
		<div>
			<h3 className="text-sm font-medium mb-1">{config.title}</h3>
			<p className="text-xs text-muted-foreground mb-3">
				{config.description}
				{variant === "terminal" && (
					<>
						{" "}
						<a
							href="https://www.nerdfonts.com"
							target="_blank"
							rel="noopener noreferrer"
							className="text-primary hover:underline"
						>
							Nerd Fonts
						</a>{" "}
						рекомендуются для иконок в темах shell.
					</>
				)}
			</p>
			<div className="flex items-center gap-2">
				<FontFamilyCombobox
					value={currentFamily}
					defaultValue={config.defaultFamily}
					onValueChange={handleFontFamilyChange}
					disabled={isLoading}
					variant={variant}
					fonts={systemFonts}
					fontsLoading={fontsLoading}
				/>
				<Input
					type="number"
					min={10}
					max={24}
					value={fontSizeDraft ?? String(currentSize ?? config.defaultSize)}
					onChange={(e) => setFontSizeDraft(e.target.value)}
					onBlur={(e) => {
						handleFontSizeBlur(e);
						setFontSizeDraft(null);
					}}
					disabled={isLoading}
					className="w-20"
					aria-label={`Размер: ${config.title}`}
				/>
				{(currentFamily || currentSize) && (
					<Button
						variant="outline"
						size="sm"
						className="shrink-0"
						onClick={() => {
							setFontSettings.mutate({
								[config.familyKey]: null,
								[config.sizeKey]: null,
							});
							setFontSizeDraft(null);
						}}
					>
						Сбросить
					</Button>
				)}
			</div>
			<div className="mt-3">
				<FontPreview
					fontFamily={previewFamily}
					fontSize={previewSize}
					variant={variant}
					isCustomFont={currentFamily !== null}
				/>
			</div>
		</div>
	);
}
