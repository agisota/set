import type { CSSProperties } from "react";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import {
	oneDark,
	oneLight,
} from "react-syntax-highlighter/dist/esm/styles/prism";
import { useTheme } from "renderer/stores";
import { FontNotFoundBanner } from "./components/FontNotFoundBanner";

const CODE_PREVIEW = `import { createTool } from "@mastra/core/tools";
import { z } from "zod";

export const webSearchTool = createTool({
  id: "web_search",
  description: "Search the web for current information.",
  inputSchema: z.object({
    query: z.string().describe("The search query"),
    maxResults: z
      .number()
      .min(1)
      .max(10)
      .optional()
      .default(5),
  }),
  execute: async ({ context }) => {
    const results = await search(context.query);
    return { results: results.slice(0, context.maxResults) };
  },
});`;

const UI_PREVIEW = `Rox
Настройки  Внешний вид  Аккаунт  Голос
Рабочие области  Почта  Диск  Календарь

Интерфейсный шрифт меняет навигацию, панели и app chrome.`;

const TERMINAL_PREVIEW = `~/agent $ mastra dev
\u2192 Загружено 3 tools \u00B7 1 agent \u00B7 0 workflows
\u2192 Слушает локальный endpoint

~/agent $ mastra test
 \u2713 web-search.test.ts   (4)   47ms
 \u2713 fetch-url.test.ts    (7)   62ms
 \u2713 researcher.test.ts   (3)   91ms

 Файлы 3 passed \u00B7 Тесты 14 passed \u00B7 0.24s`;

export function FontPreview({
	fontFamily,
	fontSize,
	variant,
	isCustomFont,
}: {
	fontFamily: string;
	fontSize: number;
	variant: "ui" | "editor" | "terminal";
	isCustomFont: boolean;
}) {
	const theme = useTheme();
	const isDark = theme?.type !== "light";
	const isTerminal = variant === "terminal";
	const isUi = variant === "ui";
	const fontFamilyStyle = fontFamily || undefined;

	return (
		<div
			className={`rounded-md border overflow-hidden ${
				isTerminal ? "bg-[#1e1e1e] text-[#cccccc] border-[#333]" : "bg-muted/50"
			}`}
		>
			{isTerminal ? (
				<div
					className="p-3"
					style={{
						fontFamily: fontFamilyStyle,
						fontSize: `${fontSize}px`,
						lineHeight: 1.5,
						whiteSpace: "pre-wrap",
					}}
				>
					{TERMINAL_PREVIEW}
				</div>
			) : isUi ? (
				<div
					className="space-y-3 p-3"
					style={{
						fontFamily: fontFamilyStyle,
						fontSize: `${fontSize}px`,
						lineHeight: 1.45,
					}}
				>
					<div className="rounded border bg-background/70 p-3">
						{UI_PREVIEW}
					</div>
					<div className="flex gap-2">
						<span className="rounded-md border px-2 py-1">Кнопка</span>
						<span className="rounded-md border px-2 py-1 text-muted-foreground">
							Вторичный текст
						</span>
					</div>
				</div>
			) : (
				<SyntaxHighlighter
					language="typescript"
					style={(isDark ? oneDark : oneLight) as Record<string, CSSProperties>}
					customStyle={{
						margin: 0,
						padding: "12px",
						fontSize: `${fontSize}px`,
						lineHeight: 1.5,
						fontFamily: fontFamilyStyle,
						background: "transparent",
					}}
					codeTagProps={{
						style: {
							fontFamily: fontFamilyStyle,
						},
					}}
				>
					{CODE_PREVIEW}
				</SyntaxHighlighter>
			)}
			{isCustomFont && <FontNotFoundBanner fontFamily={fontFamily} />}
		</div>
	);
}
