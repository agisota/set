import { Button } from "@rox/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
} from "@rox/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@rox/ui/popover";
import { CheckIcon, ChevronsUpDownIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { parsePrimaryFamily } from "../../font-utils";
import type { FontInfo } from "../../hooks/useSystemFonts";

interface FontFamilyComboboxProps {
	value: string | null;
	defaultValue: string;
	onValueChange: (v: string | null) => void;
	disabled?: boolean;
	variant: "ui" | "editor" | "terminal";
	fonts: FontInfo[];
	fontsLoading: boolean;
}

const MAX_VISIBLE = 100;

export function FontFamilyCombobox({
	value,
	defaultValue,
	onValueChange,
	disabled,
	variant,
	fonts,
	fontsLoading,
}: FontFamilyComboboxProps) {
	const [open, setOpen] = useState(false);
	const [search, setSearch] = useState("");

	const defaultLabel = useMemo(
		() => parsePrimaryFamily(defaultValue) ?? defaultValue,
		[defaultValue],
	);
	const displayLabel = value ?? defaultLabel;
	const selectedFamily = value ?? defaultValue;

	const { nerdFonts, monoFonts, otherFonts } = useMemo(() => {
		const nerd: FontInfo[] = [];
		const mono: FontInfo[] = [];
		const other: FontInfo[] = [];
		for (const font of fonts) {
			if (font.category === "nerd") nerd.push(font);
			else if (font.category === "mono") mono.push(font);
			else other.push(font);
		}
		return { nerdFonts: nerd, monoFonts: mono, otherFonts: other };
	}, [fonts]);

	// Terminal fonts must be monospace — arbitrary free-form names would let
	// users pick proportional fonts (see issue #3513), so the custom-entry
	// escape hatches below are gated off for the terminal variant.
	const allowCustomEntry = variant !== "terminal";

	const hasExactMatch = useMemo(() => {
		if (!search.trim()) return true;
		const lower = search.toLowerCase().trim();
		return fonts.some((f) => f.family.toLowerCase() === lower);
	}, [fonts, search]);

	function selectFont(family: string) {
		onValueChange(family === defaultValue ? null : family);
		setOpen(false);
		setSearch("");
	}

	function renderGroup(heading: string, items: FontInfo[]) {
		if (items.length === 0) return null;
		const visible = search.trim() ? items : items.slice(0, MAX_VISIBLE);
		return (
			<CommandGroup heading={heading}>
				{visible.map((font) => (
					<CommandItem
						key={font.family}
						value={font.family}
						onSelect={() => selectFont(font.family)}
					>
						<span
							className="truncate flex-1"
							style={{ fontFamily: `"${font.family}"` }}
						>
							{font.family}
						</span>
						{font.family === selectedFamily && (
							<CheckIcon className="size-4 shrink-0 opacity-70" />
						)}
					</CommandItem>
				))}
			</CommandGroup>
		);
	}

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<Button
					variant="outline"
					className="flex-1 justify-between font-normal truncate"
					disabled={disabled || fontsLoading}
				>
					<span
						className="truncate"
						style={{ fontFamily: `"${displayLabel}"` }}
					>
						{fontsLoading ? "Загрузка шрифтов..." : displayLabel}
					</span>
					<ChevronsUpDownIcon className="size-4 shrink-0 opacity-50" />
				</Button>
			</PopoverTrigger>
			<PopoverContent className="w-[320px] p-0" align="start" side="top">
				<Command shouldFilter={true}>
					<CommandInput
						placeholder="Поиск шрифтов..."
						value={search}
						onValueChange={setSearch}
					/>
					<CommandList>
						<CommandEmpty>
							{allowCustomEntry && search.trim() ? (
								<button
									type="button"
									className="w-full text-center cursor-pointer hover:underline"
									onClick={() => selectFont(search.trim())}
								>
									Использовать &ldquo;{search.trim()}&rdquo;
								</button>
							) : (
								"Шрифты не найдены."
							)}
						</CommandEmpty>
						{allowCustomEntry && !hasExactMatch && search.trim() && (
							<CommandGroup heading="Пользовательский">
								<CommandItem
									value={`__custom__${search.trim()}`}
									onSelect={() => selectFont(search.trim())}
								>
									<span className="truncate flex-1">
										Использовать &ldquo;{search.trim()}&rdquo;
									</span>
								</CommandItem>
							</CommandGroup>
						)}
						{renderGroup("Nerd Fonts", nerdFonts)}
						{renderGroup("Моноширинные", monoFonts)}
						{variant !== "terminal" && renderGroup("Другие", otherFonts)}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}
