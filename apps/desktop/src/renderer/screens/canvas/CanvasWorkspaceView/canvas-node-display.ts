import type { CanvasDocument, CanvasNode } from "@rox/shared/canvas";
import type { CSSProperties } from "react";

export interface DisplayNodeCard {
	id: string;
	label: string;
	title: string;
	meta: string;
	className?: string;
	style?: CSSProperties;
}

export const productionCanvasNodeTypes = [
	"text",
	"note",
	"chat-session",
	"message",
	"artifact",
	"file",
	"url",
	"image",
	"pdf",
	"code",
	"task",
	"prompt",
	"tool-call",
	"canvas",
	"freeform",
] as const satisfies readonly CanvasNode["type"][];

export const canvasEntityTypeLabels = [
	"Текст",
	"Заметка",
	"Чат-сессия",
	"Сообщение",
	"Артефакт",
	"Файл",
	"URL",
	"Изображение",
	"PDF",
	"Код",
	"Задача",
	"Промпт",
	"Вызов инструмента",
	"Канвас",
	"Рисунок",
] as const;

const fallbackNodeCards: DisplayNodeCard[] = [
	{
		id: "session",
		label: "Живая сессия агента",
		title: "Планирование с агентом",
		meta: "Узел сессии · потоковый контекст",
		className: "left-[9%] top-[15%] w-72 border-sky-400/35 bg-sky-950/45",
	},
	{
		id: "note",
		label: "Заметка",
		title: "Инварианты реализации канваса",
		meta: "Ссылка на заметку · markdown как источник",
		className: "left-[39%] top-[9%] w-80 border-amber-300/35 bg-amber-950/35",
	},
	{
		id: "artifact",
		label: "Артефакт",
		title: "Отчет импорта JSON Canvas",
		meta: "Ссылка на артефакт · результат генерации",
		className:
			"right-[11%] top-[25%] w-72 border-emerald-300/35 bg-emerald-950/35",
	},
	{
		id: "message",
		label: "Кластер сообщений",
		title: "Выбранный контекст графа",
		meta: "6 сообщений · 3 обратные ссылки",
		className:
			"left-[27%] bottom-[16%] w-72 border-fuchsia-300/35 bg-fuchsia-950/35",
	},
	{
		id: "task",
		label: "Пакет задач",
		title: "Проверки Storage/RPC",
		meta: "Узлы задач · матрица приемки",
		className:
			"right-[20%] bottom-[12%] w-80 border-violet-300/35 bg-violet-950/35",
	},
];

function getNodeAccentClass(type: CanvasNode["type"]): string {
	switch (type) {
		case "chat-session":
		case "message":
			return "border-sky-400/35 bg-sky-950/45";
		case "note":
		case "prompt":
			return "border-amber-300/35 bg-amber-950/35";
		case "artifact":
		case "file":
		case "image":
		case "pdf":
		case "code":
			return "border-emerald-300/35 bg-emerald-950/35";
		case "task":
		case "tool-call":
			return "border-violet-300/35 bg-violet-950/35";
		case "url":
		case "canvas":
			return "border-cyan-300/35 bg-cyan-950/35";
		case "freeform":
			return "border-rose-300/35 bg-rose-950/35";
		case "text":
			return "border-white/15 bg-slate-950/70";
	}
}

export function documentNodesToCards(
	document?: CanvasDocument,
): DisplayNodeCard[] {
	if (!document) return fallbackNodeCards;
	if (document.nodes.length === 0) {
		return [
			{
				id: "empty-document",
				label: "Сохраненный CanvasDocument",
				title: document.title,
				meta: "Пустой граф · создайте узел, чтобы отправить CanvasMutation batch",
				className:
					"left-[22%] top-[24%] w-96 border-cyan-300/35 bg-cyan-950/35",
			},
		];
	}
	return document.nodes.map((node) => ({
		id: node.id,
		label: node.type,
		title: node.title ?? node.text ?? node.ref?.preview ?? node.id,
		meta: node.ref
			? `${node.ref.type} · ${node.ref.id}`
			: `${node.type} · сущность CanvasDocument`,
		className: getNodeAccentClass(node.type),
		style: {
			left: `${Math.max(node.position.x, 24)}px`,
			top: `${Math.max(node.position.y, 72)}px`,
			width: `${node.size?.width ?? 288}px`,
		},
	}));
}
