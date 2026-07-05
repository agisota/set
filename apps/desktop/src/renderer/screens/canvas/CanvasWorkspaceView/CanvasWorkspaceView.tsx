import type { CanvasMutationBatch } from "@rox/shared/canvas";
import {
	createInverseCanvasMutationBatch,
	rebaseCanvasMutationBatch,
} from "@rox/shared/canvas";
import { cn } from "@rox/ui/utils";
import { workspaceTrpc } from "@rox/workspace-client";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	HiOutlineArrowPathRoundedSquare,
	HiOutlineBolt,
	HiOutlineChatBubbleLeftRight,
	HiOutlineDocumentText,
	HiOutlineMagnifyingGlass,
	HiOutlineSparkles,
} from "react-icons/hi2";
import { registerCanvasCommandHandlers } from "renderer/commandPalette/modules/canvas/commands";
import { ReactFlowCanvasAdapter } from "../ReactFlowCanvasAdapter";
import { resolveActiveCanvasId } from "./canvas-active-selection";
import {
	type CanvasSelectionState,
	emptyCanvasSelection,
	getCanvasCapabilityDisabledReason,
	getCanvasSelectionCount,
	toCanvasCapabilitySelectionInput,
} from "./canvas-capability-selection";
import {
	canvasEntityTypeLabels,
	type DisplayNodeCard,
	documentNodesToCards,
} from "./canvas-node-display";
import {
	CANVAS_ACTIVE_REFRESH_INTERVAL_MS,
	getCanvasSyncStatus,
} from "./canvas-sync-status";

interface CanvasWorkspaceViewProps {
	compact?: boolean;
	workspaceId?: string;
	initialCanvasId?: string | null;
}

interface CapabilityRunState {
	capabilityId: string;
	label: string;
	status: "success" | "unavailable" | "error";
	summary: string;
}

interface CanvasHistoryEntry {
	label: string;
	undoBatch: CanvasMutationBatch;
	redoBatch: CanvasMutationBatch;
}

interface CanvasCommandItem {
	id: string;
	title: string;
	description: string;
	shortcut?: string;
	disabled?: boolean;
	disabledReason?: string;
	keywords?: string[];
	run: () => void | Promise<void>;
}

interface ImportExportState {
	status: "idle" | "success" | "error";
	message: string;
}

const fallbackCapabilities = [
	"zoomToFit",
	"autoLayout",
	"groupSelection",
	"summarizeSelection",
	"extractTasks",
	"generateSuggestedEdges",
	"exportJsonCanvas",
	"validateMutationReplay",
];

const minimapCellIds = [
	"northwest",
	"north",
	"northeast",
	"west",
	"center",
	"east",
	"southwest",
	"south",
	"southeast",
];

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function summarizeCapabilityResult(result: unknown): string {
	if (!isRecord(result)) return String(result);
	if (result.status === "unavailable") {
		const risks = Array.isArray(result.risks)
			? `risks=${result.risks.join(",")}`
			: null;
		const reason = typeof result.reason === "string" ? result.reason : null;
		return [reason, risks].filter(Boolean).join(" · ");
	}
	const ok = typeof result.ok === "boolean" ? `ok=${result.ok}` : null;
	const issueCount = Array.isArray(result.issues)
		? `issues=${result.issues.length}`
		: null;
	const nodeCount = Array.isArray(result.nodes)
		? `nodes=${result.nodes.length}`
		: null;
	const cycleCount = Array.isArray(result.cycles)
		? `cycles=${result.cycles.length}`
		: null;
	const summaryParts = [ok, issueCount, nodeCount, cycleCount].filter(Boolean);
	if (summaryParts.length > 0) return summaryParts.join(" · ");
	return JSON.stringify(result).slice(0, 220);
}

function getCapabilityRunStatus(result: unknown): CapabilityRunState["status"] {
	if (isRecord(result) && result.status === "unavailable") {
		return "unavailable";
	}
	return "success";
}

function summarizeCapabilityError(error: unknown): string {
	if (error instanceof Error) return error.message;
	return String(error);
}

function isEditableShortcutTarget(target: EventTarget | null): boolean {
	if (!(target instanceof HTMLElement)) return false;
	const tagName = target.tagName.toLowerCase();
	return (
		tagName === "input" ||
		tagName === "textarea" ||
		tagName === "select" ||
		target.isContentEditable
	);
}

function CanvasNodeCard({
	card,
	index,
}: {
	card: DisplayNodeCard;
	index: number;
}) {
	return (
		<div
			className={cn(
				"absolute rounded-2xl border p-4 shadow-[0_22px_60px_rgba(0,0,0,0.38)] backdrop-blur-xl",
				"transition-transform duration-300 hover:-translate-y-1",
				card.className,
			)}
			style={card.style}
		>
			<div className="flex items-center justify-between gap-3">
				<span className="rounded-full border border-white/10 bg-white/10 px-2 py-1 font-medium text-[10px] text-white/70 uppercase tracking-[0.22em]">
					{card.label}
				</span>
				<span className="rounded-full bg-black/25 px-2 py-1 font-mono text-[10px] text-white/45">
					N{index + 1}
				</span>
			</div>
			<h3 className="mt-4 font-semibold text-base text-white">{card.title}</h3>
			<p className="mt-2 text-sm text-white/58">{card.meta}</p>
			<div className="mt-4 flex items-center gap-2">
				<div className="h-1.5 flex-1 rounded-full bg-white/10">
					<div className="h-full w-2/3 rounded-full bg-white/50" />
				</div>
				<span className="font-mono text-[10px] text-white/40">ref</span>
			</div>
		</div>
	);
}

function CanvasConnectionLayer() {
	return (
		<svg
			className="absolute inset-0 h-full w-full text-white/35"
			viewBox="0 0 1200 720"
			role="presentation"
			aria-hidden="true"
		>
			<defs>
				<marker
					id="canvas-arrow"
					markerHeight="8"
					markerWidth="8"
					orient="auto"
					refX="7"
					refY="4"
				>
					<path d="M0,0 L8,4 L0,8 Z" fill="currentColor" />
				</marker>
				<linearGradient id="canvas-line" x1="0%" y1="0%" x2="100%" y2="100%">
					<stop offset="0%" stopColor="rgb(56 189 248)" stopOpacity="0.82" />
					<stop offset="55%" stopColor="rgb(217 70 239)" stopOpacity="0.64" />
					<stop offset="100%" stopColor="rgb(250 204 21)" stopOpacity="0.72" />
				</linearGradient>
			</defs>
			<path
				d="M280 175 C420 120 480 122 575 160"
				fill="none"
				markerEnd="url(#canvas-arrow)"
				stroke="url(#canvas-line)"
				strokeDasharray="10 8"
				strokeWidth="2.5"
			/>
			<path
				d="M685 195 C805 190 845 220 925 285"
				fill="none"
				markerEnd="url(#canvas-arrow)"
				stroke="url(#canvas-line)"
				strokeWidth="2.5"
			/>
			<path
				d="M350 240 C300 360 330 450 430 535"
				fill="none"
				markerEnd="url(#canvas-arrow)"
				stroke="url(#canvas-line)"
				strokeWidth="2.5"
			/>
			<path
				d="M600 250 C630 390 710 475 825 548"
				fill="none"
				markerEnd="url(#canvas-arrow)"
				stroke="url(#canvas-line)"
				strokeWidth="2.5"
			/>
			<path
				d="M575 565 C675 595 740 595 840 575"
				fill="none"
				markerEnd="url(#canvas-arrow)"
				stroke="url(#canvas-line)"
				strokeDasharray="4 8"
				strokeWidth="2.5"
			/>
		</svg>
	);
}

export function CanvasWorkspaceView({
	compact = false,
	workspaceId,
	initialCanvasId,
}: CanvasWorkspaceViewProps) {
	const utils = workspaceTrpc.useUtils();
	const [lastCapabilityRun, setLastCapabilityRun] =
		useState<CapabilityRunState | null>(null);
	const [historyPast, setHistoryPast] = useState<CanvasHistoryEntry[]>([]);
	const [historyFuture, setHistoryFuture] = useState<CanvasHistoryEntry[]>([]);
	const [canvasSelection, setCanvasSelection] = useState<CanvasSelectionState>(
		() => emptyCanvasSelection(),
	);
	const [selectedCanvasId, setSelectedCanvasId] = useState<string | null>(null);
	const [lastCanvasRefreshAt, setLastCanvasRefreshAt] = useState<Date | null>(
		null,
	);
	const [lastCanvasRefreshError, setLastCanvasRefreshError] = useState<
		string | null
	>(null);
	const [canvasCommandPaletteOpen, setCanvasCommandPaletteOpen] =
		useState(false);
	const [canvasCommandQuery, setCanvasCommandQuery] = useState("");
	const [importJsonText, setImportJsonText] = useState("");
	const [exportedJsonText, setExportedJsonText] = useState("");
	const [importExportState, setImportExportState] = useState<ImportExportState>(
		{
			status: "idle",
			message: "Готово к импорту и экспорту JSON Canvas.",
		},
	);
	const canvasListQuery = workspaceTrpc.canvas.list.useQuery(
		{ workspaceId: workspaceId ?? "" },
		{ enabled: !!workspaceId },
	);
	const capabilitiesQuery = workspaceTrpc.canvas.listCapabilities.useQuery(
		undefined,
		{ enabled: !!workspaceId },
	);
	const createCanvas = workspaceTrpc.canvas.create.useMutation({
		onSuccess: async (result) => {
			if (!workspaceId) return;
			setSelectedCanvasId(result.document.id);
			await utils.canvas.list.invalidate({ workspaceId });
		},
	});
	const patchCanvas = workspaceTrpc.canvas.patch.useMutation({
		onSuccess: async (_result, input) => {
			await utils.canvas.list.invalidate({ workspaceId: input.workspaceId });
			await utils.canvas.get.invalidate({
				workspaceId: input.workspaceId,
				canvasId: input.batch.canvasId,
			});
			await utils.canvas.getHistory.invalidate({
				workspaceId: input.workspaceId,
				canvasId: input.batch.canvasId,
			});
		},
	});
	const undoCanvas = workspaceTrpc.canvas.undo.useMutation({
		onSuccess: async (_result, input) => {
			setHistoryPast([]);
			setHistoryFuture([]);
			await utils.canvas.list.invalidate({ workspaceId: input.workspaceId });
			await utils.canvas.get.invalidate({
				workspaceId: input.workspaceId,
				canvasId: input.canvasId,
			});
			await utils.canvas.getHistory.invalidate({
				workspaceId: input.workspaceId,
				canvasId: input.canvasId,
			});
			setImportExportState({
				status: "success",
				message: "Сохраненная правка канваса отменена.",
			});
		},
		onError: (error) => {
			setImportExportState({
				status: "error",
				message: summarizeCapabilityError(error),
			});
		},
	});
	const redoCanvas = workspaceTrpc.canvas.redo.useMutation({
		onSuccess: async (_result, input) => {
			setHistoryPast([]);
			setHistoryFuture([]);
			await utils.canvas.list.invalidate({ workspaceId: input.workspaceId });
			await utils.canvas.get.invalidate({
				workspaceId: input.workspaceId,
				canvasId: input.canvasId,
			});
			await utils.canvas.getHistory.invalidate({
				workspaceId: input.workspaceId,
				canvasId: input.canvasId,
			});
			setImportExportState({
				status: "success",
				message: "Сохраненная правка канваса повторена.",
			});
		},
		onError: (error) => {
			setImportExportState({
				status: "error",
				message: summarizeCapabilityError(error),
			});
		},
	});
	const runCapability = workspaceTrpc.canvas.runCapability.useMutation({
		onSuccess: (result, input) => {
			setLastCapabilityRun({
				capabilityId: input.capabilityId,
				label: input.capabilityId.replace(/^canvas\./, ""),
				status: getCapabilityRunStatus(result),
				summary: summarizeCapabilityResult(result),
			});
		},
		onError: (error, input) => {
			setLastCapabilityRun({
				capabilityId: input?.capabilityId ?? "canvas.unknown",
				label: input?.capabilityId?.replace(/^canvas\./, "") ?? "unknown",
				status: "error",
				summary: summarizeCapabilityError(error),
			});
		},
	});
	const importJsonCanvas = workspaceTrpc.canvas.importJsonCanvas.useMutation({
		onSuccess: async (result, input) => {
			setSelectedCanvasId(result.document.id);
			await utils.canvas.list.invalidate({ workspaceId: input.workspaceId });
			await utils.canvas.get.invalidate({
				workspaceId: input.workspaceId,
				canvasId: result.document.id,
			});
			setImportExportState({
				status: "success",
				message: `JSON Canvas импортирован: ${result.document.id}.`,
			});
			setImportJsonText("");
		},
		onError: (error) => {
			setImportExportState({
				status: "error",
				message: summarizeCapabilityError(error),
			});
		},
	});

	const selectionScopeKey = `${workspaceId ?? "no-workspace"}:${initialCanvasId ?? "default-canvas"}`;

	useEffect(() => {
		setSelectedCanvasId((currentCanvasId) =>
			selectionScopeKey ? null : currentCanvasId,
		);
	}, [selectionScopeKey]);

	useEffect(() => {
		if (!workspaceId) return;
		if (!canvasListQuery.isSuccess) return;
		if (canvasListQuery.data.length > 0) return;
		if (createCanvas.isPending) return;
		createCanvas.mutate({
			workspaceId,
			title: "Рабочий канвас",
			description: "Канвас Rox с сохранением в CanvasDocument.",
		});
	}, [
		canvasListQuery.data,
		canvasListQuery.isSuccess,
		createCanvas,
		workspaceId,
	]);

	const canvasIds = canvasListQuery.data?.map((canvas) => canvas.id) ?? [];
	const activeCanvasId = resolveActiveCanvasId({
		initialCanvasId,
		selectedCanvasId,
		canvasIds,
	});
	const activeCanvasQuery = workspaceTrpc.canvas.get.useQuery(
		{ workspaceId: workspaceId ?? "", canvasId: activeCanvasId ?? "" },
		{ enabled: !!workspaceId && !!activeCanvasId },
	);
	const historyQuery = workspaceTrpc.canvas.getHistory.useQuery(
		{ workspaceId: workspaceId ?? "", canvasId: activeCanvasId ?? "" },
		{ enabled: !!workspaceId && !!activeCanvasId },
	);
	const activeDocument = activeCanvasQuery.data?.document;
	const activeListIndex = canvasListQuery.data?.find(
		(canvas) => canvas.id === activeCanvasId,
	);
	const activeIndex =
		activeCanvasQuery.data?.index ??
		activeListIndex ??
		canvasListQuery.data?.[0];
	const displayCards = useMemo(
		() => documentNodesToCards(activeDocument),
		[activeDocument],
	);
	const capabilityItems = useMemo(
		() =>
			capabilitiesQuery.data?.map((capability) => ({
				id: capability.id,
				label: capability.id.replace(/^canvas\./, ""),
				risks: capability.risks,
				requiresSelection: capability.requiresSelection,
			})) ??
			fallbackCapabilities.map((capability) => ({
				id: `canvas.${capability}`,
				label: capability,
				risks: ["read"],
				requiresSelection: false,
			})),
		[capabilitiesQuery.data],
	);
	const refCount = activeDocument?.nodes.filter((node) => node.ref).length ?? 0;
	const canvasStatus = !workspaceId
		? "Рабочее пространство не выбрано"
		: activeCanvasQuery.isFetching || canvasListQuery.isFetching
			? "Загружаем сохраненный документ"
			: activeDocument
				? `Ревизия ${activeIndex?.revision ?? 0} · ${activeDocument.nodes.length} узлов · ${activeDocument.edges.length} связей`
				: "Готово";
	const persistedPatches = historyQuery.data?.patches ?? [];
	const lastPersistedPatch = persistedPatches.at(-1);
	const canServerUndo = persistedPatches.length > 0;
	const canServerRedo =
		lastPersistedPatch?.actor.id === "host-service-undo" ||
		lastPersistedPatch?.actor.id === "renderer-undo";
	const historyMutationPending =
		patchCanvas.isPending || undoCanvas.isPending || redoCanvas.isPending;
	const canUndo =
		(historyPast.length > 0 || canServerUndo) &&
		!!workspaceId &&
		!!activeIndex &&
		!historyMutationPending;
	const canRedo =
		(historyFuture.length > 0 || canServerRedo) &&
		!!workspaceId &&
		!!activeIndex &&
		!historyMutationPending;
	const selectedEntityCount = getCanvasSelectionCount(canvasSelection);
	const canvasSyncStatus = getCanvasSyncStatus({
		workspaceId,
		activeCanvasId,
		isFetching:
			canvasListQuery.isFetching ||
			activeCanvasQuery.isFetching ||
			historyQuery.isFetching,
		lastRefreshAt: lastCanvasRefreshAt,
		lastRefreshError: lastCanvasRefreshError,
		refreshIntervalMs: CANVAS_ACTIVE_REFRESH_INTERVAL_MS,
	});

	useEffect(() => {
		setCanvasSelection((currentSelection) =>
			activeCanvasId || getCanvasSelectionCount(currentSelection) > 0
				? emptyCanvasSelection()
				: currentSelection,
		);
	}, [activeCanvasId]);

	useEffect(() => {
		if (!workspaceId || !activeCanvasId) return;

		let cancelled = false;
		const refreshCanonicalCanvas = async () => {
			try {
				await Promise.all([
					canvasListQuery.refetch(),
					activeCanvasQuery.refetch(),
					historyQuery.refetch(),
				]);
				if (cancelled) return;
				setLastCanvasRefreshAt(new Date());
				setLastCanvasRefreshError(null);
			} catch (error) {
				if (cancelled) return;
				setLastCanvasRefreshError(summarizeCapabilityError(error));
			}
		};

		const intervalId = window.setInterval(() => {
			void refreshCanonicalCanvas();
		}, CANVAS_ACTIVE_REFRESH_INTERVAL_MS);

		return () => {
			cancelled = true;
			window.clearInterval(intervalId);
		};
	}, [
		activeCanvasId,
		activeCanvasQuery.refetch,
		canvasListQuery.refetch,
		historyQuery.refetch,
		workspaceId,
	]);

	const submitCanvasMutationBatch = useCallback(
		(batch: CanvasMutationBatch, label = "Правка канваса") => {
			if (!workspaceId || !activeDocument || !activeIndex) return;
			let undoBatch: CanvasMutationBatch;
			try {
				undoBatch = createInverseCanvasMutationBatch({
					document: activeDocument,
					batch,
					baseVersion: activeIndex.revision + 1,
					actorId: "renderer-undo",
				});
			} catch (error) {
				setImportExportState({
					status: "error",
					message: summarizeCapabilityError(error),
				});
				return;
			}
			const entry: CanvasHistoryEntry = {
				label,
				undoBatch,
				redoBatch: batch,
			};
			setHistoryPast((current) => [...current, entry].slice(-50));
			setHistoryFuture([]);
			patchCanvas.mutate(
				{
					workspaceId,
					batch,
				},
				{
					onError: (error) => {
						setHistoryPast((current) =>
							current.filter((candidate) => candidate !== entry),
						);
						setImportExportState({
							status: "error",
							message: summarizeCapabilityError(error),
						});
					},
				},
			);
		},
		[activeDocument, activeIndex, patchCanvas, workspaceId],
	);

	const handleCreateCanvas = useCallback(() => {
		if (!workspaceId || createCanvas.isPending) return;
		createCanvas.mutate({
			workspaceId,
			title: "Рабочий канвас",
			description: "Канвас Rox с сохранением в CanvasDocument.",
		});
	}, [createCanvas, workspaceId]);

	const handleAddTextNode = useCallback(() => {
		if (!workspaceId || !activeCanvasId || !activeDocument || !activeIndex)
			return;
		const nodeId = `node-${crypto.randomUUID()}`;
		submitCanvasMutationBatch(
			{
				id: crypto.randomUUID(),
				canvasId: activeCanvasId,
				baseVersion: activeIndex.revision,
				createdAt: new Date().toISOString(),
				actor: {
					id: "renderer",
					type: "user",
					label: "Канвас",
				},
				mutations: [
					{
						type: "node.add",
						node: {
							id: nodeId,
							type: "text",
							position: {
								x: 140 + activeDocument.nodes.length * 42,
								y: 130 + activeDocument.nodes.length * 34,
							},
							size: { width: 280, height: 160 },
							title: "Текстовая карточка",
							text: "Новая карточка сохранена как CanvasMutation batch.",
							tags: [],
							locked: false,
							collapsed: false,
							metadata: {},
						},
					},
				],
			},
			"Добавить текстовый узел",
		);
	}, [
		activeCanvasId,
		activeDocument,
		activeIndex,
		submitCanvasMutationBatch,
		workspaceId,
	]);

	const handleRunCapability = useCallback(
		(capabilityId: string) => {
			if (!workspaceId || !activeCanvasId || runCapability.isPending) return;
			const selectionInput = toCanvasCapabilitySelectionInput(canvasSelection);
			runCapability.mutate({
				workspaceId,
				canvasId: activeCanvasId,
				capabilityId,
				...(selectionInput ? { selection: selectionInput } : {}),
			});
		},
		[activeCanvasId, canvasSelection, runCapability, workspaceId],
	);

	const handleCanvasMutationBatch = useCallback(
		(batch: CanvasMutationBatch) => {
			submitCanvasMutationBatch(batch, "Правка канваса");
		},
		[submitCanvasMutationBatch],
	);

	const handleUndo = useCallback(() => {
		if (!workspaceId || !activeIndex || historyMutationPending) return;
		const entry = historyPast.at(-1);
		if (!entry) {
			if (!activeCanvasId || !canServerUndo) return;
			undoCanvas.mutate({ workspaceId, canvasId: activeCanvasId });
			return;
		}
		const batch = rebaseCanvasMutationBatch({
			batch: entry.undoBatch,
			baseVersion: activeIndex.revision,
			actorId: "renderer-undo",
		});
		patchCanvas.mutate(
			{ workspaceId, batch },
			{
				onSuccess: () => {
					setHistoryPast((current) => current.slice(0, -1));
					setHistoryFuture((current) => [...current, entry].slice(-50));
					setImportExportState({
						status: "success",
						message: `Отменено: ${entry.label}.`,
					});
				},
				onError: (error) => {
					setImportExportState({
						status: "error",
						message: summarizeCapabilityError(error),
					});
				},
			},
		);
	}, [
		activeCanvasId,
		activeIndex,
		canServerUndo,
		historyMutationPending,
		historyPast,
		patchCanvas,
		undoCanvas,
		workspaceId,
	]);

	const handleRedo = useCallback(() => {
		if (!workspaceId || !activeIndex || historyMutationPending) return;
		const entry = historyFuture.at(-1);
		if (!entry) {
			if (!activeCanvasId || !canServerRedo) return;
			redoCanvas.mutate({ workspaceId, canvasId: activeCanvasId });
			return;
		}
		const batch = rebaseCanvasMutationBatch({
			batch: entry.redoBatch,
			baseVersion: activeIndex.revision,
			actorId: "renderer-redo",
		});
		patchCanvas.mutate(
			{ workspaceId, batch },
			{
				onSuccess: () => {
					setHistoryFuture((current) => current.slice(0, -1));
					setHistoryPast((current) => [...current, entry].slice(-50));
					setImportExportState({
						status: "success",
						message: `Повторено: ${entry.label}.`,
					});
				},
				onError: (error) => {
					setImportExportState({
						status: "error",
						message: summarizeCapabilityError(error),
					});
				},
			},
		);
	}, [
		activeCanvasId,
		activeIndex,
		canServerRedo,
		historyFuture,
		historyMutationPending,
		patchCanvas,
		redoCanvas,
		workspaceId,
	]);

	const handleExportJsonCanvas = useCallback(async () => {
		if (!workspaceId || !activeCanvasId) return;
		setImportExportState({
			status: "idle",
			message: "Экспорт JSON Canvas...",
		});
		try {
			const result = await utils.canvas.exportJsonCanvas.fetch({
				workspaceId,
				canvasId: activeCanvasId,
			});
			const text = JSON.stringify(result.jsonCanvas, null, 2);
			setExportedJsonText(text);
			let copied = false;
			if (typeof navigator !== "undefined" && navigator.clipboard) {
				await navigator.clipboard.writeText(text);
				copied = true;
			}
			setImportExportState({
				status: "success",
				message: copied
					? "JSON Canvas экспортирован и скопирован в буфер."
					: "JSON Canvas экспортирован в поле предпросмотра.",
			});
		} catch (error) {
			setImportExportState({
				status: "error",
				message: summarizeCapabilityError(error),
			});
		}
	}, [activeCanvasId, utils.canvas.exportJsonCanvas, workspaceId]);

	const handleImportJsonCanvas = useCallback(() => {
		if (!workspaceId || importJsonCanvas.isPending) return;
		try {
			const jsonCanvas = JSON.parse(importJsonText);
			importJsonCanvas.mutate({
				workspaceId,
				title: "Импортированный JSON Canvas",
				jsonCanvas,
			});
		} catch (error) {
			setImportExportState({
				status: "error",
				message: summarizeCapabilityError(error),
			});
		}
	}, [importJsonCanvas, importJsonText, workspaceId]);

	useEffect(() => {
		function handleKeyDown(event: KeyboardEvent) {
			if (isEditableShortcutTarget(event.target)) return;
			const key = event.key.toLowerCase();
			const isMod = event.metaKey || event.ctrlKey;
			if (isMod && key === "z" && !event.altKey) {
				event.preventDefault();
				if (event.shiftKey) {
					handleRedo();
				} else {
					handleUndo();
				}
				return;
			}
			if (isMod && event.shiftKey && key === "p") {
				event.preventDefault();
				setCanvasCommandPaletteOpen(true);
				return;
			}
			if (isMod && event.shiftKey && key === "e") {
				event.preventDefault();
				void handleExportJsonCanvas();
			}
		}

		window.addEventListener("keydown", handleKeyDown, { capture: true });
		return () => {
			window.removeEventListener("keydown", handleKeyDown, { capture: true });
		};
	}, [handleExportJsonCanvas, handleRedo, handleUndo]);

	const canvasCommands = useMemo<CanvasCommandItem[]>(
		() => [
			{
				id: "canvas.addTextNode",
				title: "Добавить текстовый узел",
				description: "Создать текстовый CanvasNode через node.add mutation.",
				shortcut: "Кнопка на панели",
				disabled: !activeCanvasId || patchCanvas.isPending,
				disabledReason: !activeCanvasId
					? "Откройте сохраненный канвас перед добавлением узлов."
					: patchCanvas.isPending
						? "Изменение канваса уже сохраняется."
						: undefined,
				keywords: ["node", "text", "card", "create"],
				run: handleAddTextNode,
			},
			{
				id: "canvas.undo",
				title: "Отменить изменение канваса",
				description:
					"Применить обратный CanvasMutationBatch к активному документу.",
				shortcut: "Cmd/Ctrl+Z",
				disabled: !canUndo,
				disabledReason: !canUndo
					? "Нет изменений канваса для отмены."
					: undefined,
				keywords: ["history", "rollback", "mutation"],
				run: handleUndo,
			},
			{
				id: "canvas.redo",
				title: "Повторить изменение канваса",
				description:
					"Перебазировать и повторить сохраненный CanvasMutationBatch.",
				shortcut: "Cmd/Ctrl+Shift+Z",
				disabled: !canRedo,
				disabledReason: !canRedo
					? "Нет изменений канваса для повтора."
					: undefined,
				keywords: ["history", "replay", "mutation"],
				run: handleRedo,
			},
			{
				id: "canvas.exportJsonCanvas",
				title: "Экспортировать JSON Canvas",
				description:
					"Сериализовать текущий CanvasDocument через JSON Canvas codec.",
				shortcut: "Cmd/Ctrl+Shift+E",
				disabled: !activeCanvasId,
				disabledReason: !activeCanvasId
					? "Откройте сохраненный канвас перед экспортом."
					: undefined,
				keywords: ["json", "obsidian", "export", "interop"],
				run: () => void handleExportJsonCanvas(),
			},
			{
				id: "canvas.importJsonCanvas",
				title: "Импортировать JSON Canvas",
				description:
					"Прочитать поле импорта и создать новый сохраненный канвас.",
				disabled:
					!workspaceId || importJsonCanvas.isPending || !importJsonText.trim(),
				disabledReason: !workspaceId
					? "Откройте workspace перед импортом JSON Canvas."
					: importJsonCanvas.isPending
						? "Импорт JSON Canvas уже выполняется."
						: !importJsonText.trim()
							? "Сначала вставьте JSON Canvas в поле импорта."
							: undefined,
				keywords: ["json", "obsidian", "import", "interop"],
				run: handleImportJsonCanvas,
			},
			...capabilityItems.slice(0, 12).map((capability) => ({
				id: capability.id,
				title: capability.label,
				description: `Запустить ${capability.id} для активного CanvasDocument.`,
				disabled: Boolean(
					getCanvasCapabilityDisabledReason({
						hasActiveCanvas: Boolean(activeCanvasId),
						isPending: runCapability.isPending,
						requiresSelection: capability.requiresSelection,
						selection: canvasSelection,
					}),
				),
				disabledReason: getCanvasCapabilityDisabledReason({
					hasActiveCanvas: Boolean(activeCanvasId),
					isPending: runCapability.isPending,
					requiresSelection: capability.requiresSelection,
					selection: canvasSelection,
				}),
				keywords: ["capability", "canvas", ...capability.risks],
				run: () => handleRunCapability(capability.id),
			})),
		],
		[
			activeCanvasId,
			canRedo,
			canUndo,
			capabilityItems,
			canvasSelection,
			handleAddTextNode,
			handleExportJsonCanvas,
			handleImportJsonCanvas,
			handleRedo,
			handleRunCapability,
			handleUndo,
			importJsonCanvas.isPending,
			importJsonText,
			patchCanvas.isPending,
			runCapability.isPending,
			workspaceId,
		],
	);
	useEffect(() => {
		const handlers = Object.fromEntries(
			canvasCommands.map((command) => [
				command.id,
				{
					title: command.title,
					description: command.description,
					shortcut: command.shortcut,
					keywords: command.keywords,
					disabled: command.disabled,
					disabledReason: command.disabledReason,
					run: command.run,
				},
			]),
		);
		return registerCanvasCommandHandlers(handlers);
	}, [canvasCommands]);
	const filteredCanvasCommands = canvasCommands.filter((command) => {
		const query = canvasCommandQuery.trim().toLowerCase();
		if (!query) return true;
		return `${command.title} ${command.description} ${command.id}`
			.toLowerCase()
			.includes(query);
	});

	return (
		<div className="relative h-full w-full overflow-hidden bg-[#07090f] text-white">
			<div className="absolute inset-0 bg-[radial-gradient(circle_at_18%_16%,rgba(14,165,233,0.28),transparent_28%),radial-gradient(circle_at_78%_22%,rgba(168,85,247,0.25),transparent_30%),linear-gradient(135deg,rgba(15,23,42,0.95),rgba(2,6,23,0.98))]" />
			<div className="absolute inset-0 opacity-[0.18] [background-image:linear-gradient(rgba(255,255,255,0.08)_1px,transparent_1px),linear-gradient(90deg,rgba(255,255,255,0.08)_1px,transparent_1px)] [background-size:32px_32px]" />

			<div className="relative z-10 flex h-full flex-col">
				<header
					className={cn(
						"flex items-center justify-between border-white/10 border-b bg-black/20 px-5 py-3 backdrop-blur-xl",
						compact && "px-4 py-2",
					)}
				>
					<div className="flex items-center gap-3">
						<div className="flex size-9 items-center justify-center rounded-xl border border-cyan-300/35 bg-cyan-300/10">
							<HiOutlineSparkles className="size-5 text-cyan-200" />
						</div>
						<div>
							<h1 className="font-semibold text-lg tracking-tight">
								{activeDocument?.title ?? "Канвас"}
							</h1>
							<p className="text-white/50 text-xs">{canvasStatus}</p>
						</div>
					</div>
					<div
						className={cn(
							"flex items-center gap-2",
							compact && "hidden xl:flex",
						)}
					>
						<button
							type="button"
							className="rounded-lg border border-white/10 bg-white/8 px-3 py-2 text-sm text-white/75 hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
							onClick={handleUndo}
							disabled={!canUndo}
							title="Cmd/Ctrl+Z"
						>
							Отмена
						</button>
						<button
							type="button"
							className="rounded-lg border border-white/10 bg-white/8 px-3 py-2 text-sm text-white/75 hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
							onClick={handleRedo}
							disabled={!canRedo}
							title="Cmd/Ctrl+Shift+Z"
						>
							Повтор
						</button>
						<button
							type="button"
							className="rounded-lg border border-cyan-300/25 bg-cyan-300/10 px-3 py-2 text-cyan-100 text-sm hover:bg-cyan-300/15"
							onClick={() => setCanvasCommandPaletteOpen(true)}
							title="Cmd/Ctrl+Shift+P"
						>
							Команды
						</button>
						<button
							type="button"
							className="rounded-lg border border-white/10 bg-white/8 px-3 py-2 text-sm text-white/75 hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
							onClick={() => void handleExportJsonCanvas()}
							disabled={!activeCanvasId}
							title="Cmd/Ctrl+Shift+E"
						>
							Экспорт
						</button>
						<button
							type="button"
							className="rounded-lg border border-white/10 bg-white/8 px-3 py-2 text-sm text-white/75 hover:bg-white/12"
							onClick={handleAddTextNode}
							disabled={!activeCanvasId || patchCanvas.isPending}
						>
							Текст
						</button>
						<button
							type="button"
							className="rounded-lg bg-cyan-300 px-3 py-2 font-medium text-slate-950 text-sm hover:bg-cyan-200"
							onClick={handleCreateCanvas}
							disabled={!workspaceId || createCanvas.isPending}
						>
							Новый канвас
						</button>
					</div>
				</header>

				{canvasCommandPaletteOpen ? (
					<div className="absolute inset-0 z-40 flex items-start justify-center bg-black/45 px-4 pt-20 backdrop-blur-sm">
						<div className="w-full max-w-2xl overflow-hidden rounded-3xl border border-cyan-300/20 bg-slate-950/95 shadow-[0_30px_120px_rgba(8,47,73,0.55)]">
							<div className="border-white/10 border-b p-4">
								<div className="flex items-center justify-between gap-4">
									<div>
										<p className="font-medium text-cyan-100 text-sm uppercase tracking-[0.18em]">
											Команды канваса
										</p>
										<p className="mt-1 text-white/50 text-xs">
											Действия для активного CanvasDocument.
										</p>
									</div>
									<button
										type="button"
										className="rounded-lg border border-white/10 px-3 py-1.5 text-white/55 text-xs hover:bg-white/8"
										onClick={() => setCanvasCommandPaletteOpen(false)}
									>
										Esc
									</button>
								</div>
								<input
									className="mt-4 w-full rounded-2xl border border-white/10 bg-black/35 px-4 py-3 text-sm text-white outline-none placeholder:text-white/30 focus:border-cyan-300/45"
									placeholder="Поиск действий, возможностей, импорта и экспорта..."
									value={canvasCommandQuery}
									onChange={(event) =>
										setCanvasCommandQuery(event.target.value)
									}
									onKeyDown={(event) => {
										if (event.key === "Escape") {
											setCanvasCommandPaletteOpen(false);
										}
									}}
								/>
							</div>
							<div className="max-h-[52vh] overflow-y-auto p-2">
								{filteredCanvasCommands.map((command) => (
									<button
										key={command.id}
										type="button"
										className="flex w-full items-start justify-between gap-4 rounded-2xl px-4 py-3 text-left transition-colors hover:bg-white/8 disabled:cursor-not-allowed disabled:opacity-35"
										disabled={command.disabled}
										onClick={() => {
											void command.run();
											setCanvasCommandPaletteOpen(false);
											setCanvasCommandQuery("");
										}}
									>
										<span>
											<span className="block font-medium text-sm text-white">
												{command.title}
											</span>
											<span className="mt-1 block text-white/50 text-xs">
												{command.description}
											</span>
											<span className="mt-1 block font-mono text-[10px] text-cyan-200/55">
												{command.id}
											</span>
										</span>
										{command.shortcut ? (
											<span className="rounded-full border border-white/10 bg-white/6 px-2 py-1 font-mono text-[10px] text-white/45">
												{command.shortcut}
											</span>
										) : null}
									</button>
								))}
								{filteredCanvasCommands.length === 0 ? (
									<p className="px-4 py-8 text-center text-sm text-white/45">
										Нет команд канваса по этому запросу.
									</p>
								) : null}
							</div>
						</div>
					</div>
				) : null}

				<div
					className={cn(
						"grid min-h-0 flex-1",
						compact
							? "grid-cols-[minmax(0,1fr)] xl:grid-cols-[minmax(0,1fr)_280px]"
							: "grid-cols-[240px_minmax(0,1fr)_300px]",
					)}
				>
					<aside
						className={cn(
							"border-white/10 border-r bg-black/20 p-4 backdrop-blur-xl",
							compact && "hidden",
						)}
					>
						<div className="rounded-2xl border border-white/10 bg-white/[0.04] p-3">
							<div className="mb-3 flex items-center gap-2 text-white/70 text-xs uppercase tracking-[0.18em]">
								<HiOutlineMagnifyingGlass className="size-4" />
								Библиотека
							</div>
							<div className="space-y-2 text-sm">
								{(canvasListQuery.data?.length
									? canvasListQuery.data.map((canvas) => canvas.title)
									: ["Рабочее пространство", "Запуски агентов", "Граф заметок"]
								).map((item, index) => (
									<button
										key={item}
										type="button"
										className={cn(
											"w-full rounded-xl px-3 py-2 text-left transition-colors",
											index === 0
												? "bg-cyan-300/14 text-cyan-100"
												: "text-white/58 hover:bg-white/8",
										)}
									>
										{item}
									</button>
								))}
							</div>
						</div>

						<div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-3">
							<div className="mb-3 flex items-center gap-2 text-white/70 text-xs uppercase tracking-[0.18em]">
								<HiOutlineDocumentText className="size-4" />
								Узлы из объектов
							</div>
							<div className="flex flex-wrap gap-2">
								{canvasEntityTypeLabels.map((type) => (
									<span
										key={type}
										className="rounded-full border border-white/10 bg-white/6 px-2 py-1 text-white/60 text-xs"
									>
										{type}
									</span>
								))}
							</div>
						</div>
					</aside>

					<main className="relative min-h-0 overflow-hidden">
						<div className="absolute left-5 top-5 z-20 flex items-center gap-2 rounded-2xl border border-white/10 bg-black/35 p-2 shadow-2xl backdrop-blur-xl">
							{["Выбор", "Текст", "Заметка", "Сессия", "Связь", "Группа"].map(
								(tool, index) => (
									<button
										key={tool}
										type="button"
										className={cn(
											"rounded-xl px-3 py-1.5 text-xs transition-colors",
											index === 0
												? "bg-white text-slate-950"
												: "text-white/65 hover:bg-white/10",
										)}
									>
										{tool}
									</button>
								),
							)}
						</div>
						<div className="absolute right-5 top-5 z-20 rounded-2xl border border-white/10 bg-black/35 px-3 py-2 text-white/60 text-xs backdrop-blur-xl">
							<div>
								Масштаб 86% · Сетка включена ·{" "}
								{activeDocument
									? "Автосохранение документа"
									: "Предпросмотр проекции"}
							</div>
							<div
								className="mt-1 font-mono text-cyan-100/65"
								data-testid="canvas-sync-status"
							>
								{canvasSyncStatus}
							</div>
						</div>
						{activeDocument && activeIndex ? (
							<ReactFlowCanvasAdapter
								baseVersion={activeIndex.revision}
								compact={compact}
								disabled={patchCanvas.isPending}
								document={activeDocument}
								onMutationBatch={handleCanvasMutationBatch}
								onSelectionChange={setCanvasSelection}
							/>
						) : (
							<>
								<CanvasConnectionLayer />
								{displayCards.map((card, index) => (
									<CanvasNodeCard key={card.id} card={card} index={index} />
								))}
								<div className="absolute right-5 bottom-5 z-20 h-28 w-44 rounded-2xl border border-white/10 bg-black/45 p-2 backdrop-blur-xl">
									<div className="h-full rounded-xl border border-white/8 bg-white/[0.03] p-2">
										<div className="h-2 w-12 rounded-full bg-cyan-300/50" />
										<div className="mt-4 grid grid-cols-3 gap-2">
											{minimapCellIds.map((cellId) => (
												<div
													key={cellId}
													className="h-2 rounded-full bg-white/20"
												/>
											))}
										</div>
									</div>
								</div>
							</>
						)}
					</main>

					<aside
						className={cn(
							"border-white/10 border-l bg-black/25 p-4 backdrop-blur-xl",
							compact && "hidden xl:block",
						)}
					>
						<div className="rounded-2xl border border-white/10 bg-white/[0.04] p-4">
							<div className="flex items-center gap-2 text-white/70 text-xs uppercase tracking-[0.18em]">
								<HiOutlineChatBubbleLeftRight className="size-4" />
								Выбор
							</div>
							<h2 className="mt-3 font-semibold text-white">
								{activeDocument?.title ?? "Контекст графа"}
							</h2>
							<p className="mt-2 text-sm text-white/55">
								{activeDocument
									? `${activeDocument.nodes.length} узлов, ${activeDocument.edges.length} направленных связей, ${refCount} ссылок на объекты. Выбрано: ${selectedEntityCount}. Изменения сохраняются как CanvasMutation batch.`
									: "Проекция канваса Rox на объектах. Откройте workspace, чтобы загрузить сохраненное состояние."}
							</p>
						</div>

						<div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
							<div className="flex items-center gap-2 text-white/70 text-xs uppercase tracking-[0.18em]">
								<HiOutlineBolt className="size-4" />
								Возможности
							</div>
							<div className="mt-3 space-y-2">
								{capabilityItems.map((capability) => (
									<button
										key={capability.id}
										type="button"
										disabled={
											!workspaceId ||
											Boolean(
												getCanvasCapabilityDisabledReason({
													hasActiveCanvas: Boolean(activeCanvasId),
													isPending: runCapability.isPending,
													requiresSelection: capability.requiresSelection,
													selection: canvasSelection,
												}),
											)
										}
										title={getCanvasCapabilityDisabledReason({
											hasActiveCanvas: Boolean(activeCanvasId),
											isPending: runCapability.isPending,
											requiresSelection: capability.requiresSelection,
											selection: canvasSelection,
										})}
										onClick={() => handleRunCapability(capability.id)}
										className="flex w-full items-center justify-between rounded-xl border border-white/8 bg-white/[0.04] px-3 py-2 text-left text-sm text-white/68 hover:bg-white/[0.08]"
									>
										<span>{capability.label}</span>
										<HiOutlineArrowPathRoundedSquare className="size-4 text-cyan-200/70" />
									</button>
								))}
							</div>
							{lastCapabilityRun ? (
								<div
									className={cn(
										"mt-3 rounded-xl border px-3 py-2 text-xs",
										lastCapabilityRun.status === "success"
											? "border-emerald-300/25 bg-emerald-400/10 text-emerald-100/75"
											: lastCapabilityRun.status === "unavailable"
												? "border-amber-300/25 bg-amber-400/10 text-amber-100/75"
												: "border-rose-300/25 bg-rose-400/10 text-rose-100/75",
									)}
								>
									<div className="font-medium">{lastCapabilityRun.label}</div>
									<div className="mt-1 line-clamp-3 font-mono opacity-80">
										{lastCapabilityRun.summary}
									</div>
								</div>
							) : null}
						</div>

						<div className="mt-4 rounded-2xl border border-white/10 bg-white/[0.04] p-4">
							<div className="flex items-center gap-2 text-white/70 text-xs uppercase tracking-[0.18em]">
								<HiOutlineDocumentText className="size-4" />
								Импорт / экспорт
							</div>
							<div className="mt-3 grid grid-cols-2 gap-2">
								<button
									type="button"
									className="rounded-xl border border-cyan-300/20 bg-cyan-300/10 px-3 py-2 text-cyan-100 text-xs hover:bg-cyan-300/15 disabled:cursor-not-allowed disabled:opacity-40"
									disabled={!activeCanvasId}
									onClick={() => void handleExportJsonCanvas()}
								>
									Экспорт JSON
								</button>
								<button
									type="button"
									className="rounded-xl border border-white/10 bg-white/8 px-3 py-2 text-white/70 text-xs hover:bg-white/12 disabled:cursor-not-allowed disabled:opacity-40"
									disabled={
										!workspaceId ||
										importJsonCanvas.isPending ||
										!importJsonText.trim()
									}
									onClick={handleImportJsonCanvas}
								>
									Импорт JSON
								</button>
							</div>
							<div className="mt-3 rounded-xl border border-white/8 bg-black/25 px-3 py-2 text-white/55 text-xs">
								История: {historyPast.length} отмена · {historyFuture.length}{" "}
								повтор
							</div>
							<textarea
								className="mt-3 min-h-24 w-full resize-y rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white/70 outline-none placeholder:text-white/25 focus:border-cyan-300/35"
								placeholder="Вставьте Obsidian JSON Canvas и нажмите «Импорт JSON»."
								value={importJsonText}
								onChange={(event) => setImportJsonText(event.target.value)}
							/>
							{exportedJsonText ? (
								<textarea
									className="mt-3 max-h-32 min-h-20 w-full resize-y rounded-xl border border-white/10 bg-black/30 px-3 py-2 font-mono text-[11px] text-white/60 outline-none"
									readOnly
									value={exportedJsonText}
									aria-label="Экспортированный JSON Canvas"
								/>
							) : null}
							<div
								className={cn(
									"mt-3 rounded-xl border px-3 py-2 text-xs",
									importExportState.status === "success" &&
										"border-emerald-300/25 bg-emerald-400/10 text-emerald-100/75",
									importExportState.status === "error" &&
										"border-rose-300/25 bg-rose-400/10 text-rose-100/75",
									importExportState.status === "idle" &&
										"border-white/10 bg-white/[0.04] text-white/50",
								)}
							>
								{importExportState.message}
							</div>
						</div>
					</aside>
				</div>
			</div>
		</div>
	);
}
