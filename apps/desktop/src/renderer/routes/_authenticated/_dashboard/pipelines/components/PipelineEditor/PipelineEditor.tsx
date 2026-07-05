import { ReactFlowProvider } from "@rox/ui/ai-elements/flow";
import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { toast } from "@rox/ui/sonner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@rox/ui/tabs";
import type { RoxWorkflowState } from "@rox/workflow-core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
	ArrowLeft,
	CheckCircle2,
	Loader2,
	PanelRightClose,
	PanelRightOpen,
	Save,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { logger } from "renderer/lib/logger";
import { autoLayoutGraph } from "./auto-layout";
import {
	defaultLabelForType,
	flowToState,
	type PipelineFlowEdge,
	type PipelineFlowNode,
	stateToEdges,
	stateToNodes,
} from "./graph-adapter";
import { NodeInspector, useNodePatch } from "./NodeInspector";
import { NodePalette } from "./NodePalette";
import { PipelineCanvas, type PipelineCanvasHandle } from "./PipelineCanvas";
import { RoleLibraryPanel } from "./RoleLibraryPanel";
import { RunMonitorPanel } from "./RunMonitorPanel";
import { TriggerConfigPanel } from "./TriggerConfigPanel";
import {
	buildTemplateFromState,
	insertTemplate,
	isEmptyCanvas,
} from "./templateGraph";
import { useRunTrace } from "./useRunTrace";

const SAVE_DEBOUNCE_MS = 800;

type PipelineRow = {
	id: string;
	name: string;
	slug: string;
	v2ProjectId: string | null;
	draftState: RoxWorkflowState;
};

type PipelineEditorProps = {
	pipeline: PipelineRow;
};

/** Generate a unique block id for a freshly-added node. */
function newBlockId(kind: string): string {
	const stamp = Math.random().toString(36).slice(2, 8);
	return `${kind}_${stamp}`;
}

function slugifyTemplateName(name: string): string {
	const slug = name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return slug || "saved-template";
}

/**
 * The pipeline editor shell: a draggable/connectable canvas plus the role
 * library, trigger config, and run monitor panels. Owns the working
 * `RoxWorkflowState`, debounce-saves graph edits via `pipeline.updateGraph`,
 * validates via `pipeline.validate`, and adds role/loop/approval nodes.
 */
export function PipelineEditor({
	pipeline: initialPipeline,
}: PipelineEditorProps) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();

	// Authoritative working graph. Seeded from the server row, then mutated
	// locally and pushed back (debounced).
	const [graph, setGraph] = useState<RoxWorkflowState>(
		initialPipeline.draftState,
	);
	const graphRef = useRef(graph);
	graphRef.current = graph;
	const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
	const [saveState, setSaveState] = useState<"idle" | "saving" | "saved">(
		"idle",
	);
	const [rolesPanelOpen, setRolesPanelOpen] = useState(true);
	const [nodePaletteOpen, setNodePaletteOpen] = useState(false);
	const [savedTemplates, setSavedTemplates] = useState<
		ReturnType<typeof buildTemplateFromState>[]
	>([]);
	const [reseedKey, setReseedKey] = useState(0);
	const canvasHandle = useRef<PipelineCanvasHandle>(null);

	const pipelineId = initialPipeline.id;
	const v2ProjectId = initialPipeline.v2ProjectId ?? undefined;
	const validateInput = useMemo(() => ({ pipelineId }), [pipelineId]);
	const runTrace = useRunTrace(pipelineId);

	const nodes = useMemo(() => {
		const statuses = runTrace.runStatusByBlockId;
		return stateToNodes(graph).map((node) => ({
			...node,
			data: {
				...node.data,
				runStatus: statuses[node.id],
			},
		}));
	}, [graph, runTrace.runStatusByBlockId]);
	const edges = useMemo(() => stateToEdges(graph), [graph]);

	const selectedNode = useMemo(
		() => nodes.find((n) => n.id === selectedNodeId) ?? null,
		[nodes, selectedNodeId],
	);

	// Debounced persistence of the working graph.
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingSave = useRef<{
		pipelineId: string;
		draftState: RoxWorkflowState;
	} | null>(null);
	const saveInFlight = useRef(false);
	const flushPendingSaveRef = useRef<() => void>(() => {});

	const updateGraphMutation = useMutation(
		trpc.pipeline.updateGraph.mutationOptions({
			onSuccess: () => {
				void queryClient.invalidateQueries({
					queryKey: trpc.pipeline.validate.queryKey(validateInput),
				});
				saveInFlight.current = false;
				if (pendingSave.current) {
					flushPendingSaveRef.current();
					return;
				}
				setSaveState("saved");
			},
			onError: (error) => {
				saveInFlight.current = false;
				logger.error("[PipelineEditor] updateGraph failed", error);
				if (pendingSave.current) {
					flushPendingSaveRef.current();
					return;
				}
				setSaveState("idle");
				toast.error("Не удалось сохранить граф");
			},
		}),
	);

	const validateQuery = useQuery(
		trpc.pipeline.validate.queryOptions(validateInput),
	);

	const updateGraphMutationRef = useRef(updateGraphMutation);
	useEffect(() => {
		updateGraphMutationRef.current = updateGraphMutation;
	}, [updateGraphMutation]);

	const flushPendingSave = useCallback(() => {
		if (saveTimer.current) {
			clearTimeout(saveTimer.current);
			saveTimer.current = null;
		}
		const pending = pendingSave.current;
		if (!pending) return;
		if (saveInFlight.current) return;
		pendingSave.current = null;
		saveInFlight.current = true;
		updateGraphMutationRef.current.mutate({
			pipelineId: pending.pipelineId,
			draftState: pending.draftState,
		});
	}, []);
	flushPendingSaveRef.current = flushPendingSave;

	const persist = useCallback(
		(next: RoxWorkflowState) => {
			setSaveState("saving");
			pendingSave.current = { pipelineId, draftState: next };
			if (saveTimer.current) clearTimeout(saveTimer.current);
			saveTimer.current = setTimeout(() => {
				flushPendingSave();
			}, SAVE_DEBOUNCE_MS);
		},
		[pipelineId, flushPendingSave],
	);

	useEffect(() => () => flushPendingSave(), [flushPendingSave]);

	const applyGraphChange = useCallback(
		(next: RoxWorkflowState) => {
			graphRef.current = next;
			setGraph(next);
			persist(next);
		},
		[persist],
	);

	// Per-node inspector edits fold into the same authoritative graph + save loop.
	const nodePatch = useNodePatch(graphRef, applyGraphChange);

	// Canvas → state: fold node/edge edits back into the working graph + persist.
	const handleGraphChange = useCallback(
		(nextNodes: PipelineFlowNode[], nextEdges: PipelineFlowEdge[]) => {
			applyGraphChange(flowToState(graphRef.current, nextNodes, nextEdges));
		},
		[applyGraphChange],
	);

	const addNode = useCallback(
		(
			kind: string,
			opts?: {
				roleSlug?: string;
				label?: string;
				position?: { x: number; y: number };
			},
		) => {
			const prev = graphRef.current;
			const id = newBlockId(kind);
			const count = Object.keys(prev.blocks).length;
			const next: RoxWorkflowState = {
				...prev,
				blocks: {
					...prev.blocks,
					[id]: {
						type: kind,
						name:
							opts?.label ??
							(kind === "agent_run"
								? "Агент"
								: kind === "loop"
									? "Цикл"
									: kind === "human_approval"
										? "Подтверждение"
										: defaultLabelForType(kind)),
						position: opts?.position ?? {
							x: 180 + (count % 4) * 280,
							y: 360 + Math.floor(count / 4) * 180,
						},
						subBlocks: opts?.roleSlug ? { roleSlug: opts.roleSlug } : undefined,
					},
				},
			};
			applyGraphChange(next);
			// Open the inspector on the freshly-added node so it's ready to edit.
			setSelectedNodeId(id);
		},
		[applyGraphChange],
	);

	const addRoleNode = useCallback(
		(roleSlug: string, label: string) =>
			addNode("agent_run", { roleSlug, label }),
		[addNode],
	);

	const dropNode = useCallback(
		(
			kind: string,
			position: { x: number; y: number },
			roleSlug?: string,
			label?: string,
		) => addNode(kind, { position, roleSlug, label }),
		[addNode],
	);

	const autoLayout = useCallback(() => {
		applyGraphChange(autoLayoutGraph(graphRef.current));
		setReseedKey((key) => key + 1);
		requestAnimationFrame(() => canvasHandle.current?.fitView());
	}, [applyGraphChange]);

	const applyTemplate = useCallback(
		(template: RoxWorkflowState) => {
			const prev = graphRef.current;
			const next = isEmptyCanvas(prev)
				? template
				: insertTemplate(prev, template, selectedNodeId ?? "start").state;
			applyGraphChange(next);
			setReseedKey((key) => key + 1);
		},
		[applyGraphChange, selectedNodeId],
	);

	const saveAsTemplate = useCallback(
		(meta: { name: string; description: string }) => {
			const slug = slugifyTemplateName(meta.name);
			const id = `${slug}-${Date.now().toString(36)}`;
			setSavedTemplates((templates) => [
				buildTemplateFromState(graphRef.current, {
					id,
					name: meta.name,
					description: meta.description,
					slugSeed: slug,
					category: "Мои шаблоны",
					icon: "BookmarkPlus",
				}),
				...templates,
			]);
			toast.success("Шаблон сохранён в текущей сессии");
		},
		[],
	);

	const validation = validateQuery.data;

	return (
		<div className="flex h-[calc(100dvh-3rem)] w-full min-w-0 flex-1 flex-col">
			{/* Toolbar */}
			<div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
				<Button asChild size="icon" variant="ghost" className="size-8">
					<Link to="/pipelines" aria-label="К списку пайплайнов">
						<ArrowLeft className="size-4" />
					</Link>
				</Button>
				<div className="min-w-48 flex-1">
					<h1 className="truncate text-sm font-medium">
						{initialPipeline.name}
					</h1>
					<p className="truncate font-mono text-[11px] text-muted-foreground">
						{initialPipeline.slug}
					</p>
				</div>
				<div className="flex shrink-0 flex-wrap items-center justify-end gap-2">
					{validation &&
						(validation.valid ? (
							<Badge variant="default" className="gap-1 whitespace-nowrap">
								<CheckCircle2 className="size-3" /> граф валиден
							</Badge>
						) : (
							<Badge variant="destructive" className="whitespace-nowrap">
								{validation.issues.length} проблем(ы)
							</Badge>
						))}
					<SaveIndicator state={saveState} />
					<Button
						size="icon"
						variant="ghost"
						className="size-8"
						aria-label={
							rolesPanelOpen
								? "Скрыть библиотеку ролей"
								: "Показать библиотеку ролей"
						}
						aria-pressed={rolesPanelOpen}
						onClick={() => setRolesPanelOpen((open) => !open)}
					>
						{rolesPanelOpen ? (
							<PanelRightClose className="size-4" />
						) : (
							<PanelRightOpen className="size-4" />
						)}
					</Button>
				</div>
			</div>
			{validation && !validation.valid && (
				<div className="border-b border-destructive/25 bg-destructive/10 px-4 py-2 text-destructive text-xs">
					<div className="flex flex-wrap items-center gap-x-4 gap-y-1">
						<span className="font-medium">
							Запуск недоступен: {validation.issues.length} проблем(ы)
						</span>
						{validation.issues.slice(0, 4).map((issue) => (
							<span
								key={`${issue.code}:${issue.blockId ?? issue.edgeId ?? issue.path ?? issue.message}`}
								className="cursor-text select-text"
							>
								{issue.blockId ? `${issue.blockId}: ` : ""}
								{issue.message}
							</span>
						))}
					</div>
				</div>
			)}

			<div className="flex min-h-0 flex-1 overflow-hidden">
				<div className="relative h-full min-w-0 flex-1 basis-0">
					<ReactFlowProvider>
						<PipelineCanvas
							nodes={nodes}
							edges={edges}
							selectedNodeId={selectedNodeId}
							v2ProjectId={v2ProjectId}
							onSelectNode={setSelectedNodeId}
							onGraphChange={handleGraphChange}
							onAddNode={addNode}
							onDropNode={dropNode}
							onOpenPalette={() => setNodePaletteOpen(true)}
							onAutoLayout={autoLayout}
							onApplyTemplate={applyTemplate}
							savedTemplates={savedTemplates}
							onSaveAsTemplate={saveAsTemplate}
							handleRef={canvasHandle}
							showEmptyHint={isEmptyCanvas(graph)}
							reseedKey={reseedKey}
						/>
						<NodePalette
							open={nodePaletteOpen}
							onOpenChange={setNodePaletteOpen}
							v2ProjectId={v2ProjectId}
							onPick={(kind, roleSlug, label) => {
								addNode(kind, {
									roleSlug,
									label,
									position: canvasHandle.current?.getViewportCenter(),
								});
							}}
						/>
					</ReactFlowProvider>
				</div>

				{rolesPanelOpen && (
					<aside className="flex w-[clamp(17rem,30vw,21rem)] shrink-0 flex-col border-l bg-background">
						{selectedNode ? (
							<NodeInspector
								selectedNode={selectedNode}
								patch={nodePatch}
								issues={validation?.issues}
								onClose={() => setSelectedNodeId(null)}
								onDeleted={() => setSelectedNodeId(null)}
							/>
						) : (
							<Tabs
								defaultValue="roles"
								className="flex min-h-0 flex-1 flex-col"
							>
								<TabsList className="mx-2 mt-2 grid h-auto grid-cols-3">
									<TabsTrigger value="roles" className="text-xs">
										Роли
									</TabsTrigger>
									<TabsTrigger value="triggers" className="text-xs">
										Триггеры
									</TabsTrigger>
									<TabsTrigger value="runs" className="text-xs">
										Запуски
									</TabsTrigger>
								</TabsList>
								<TabsContent value="roles" className="min-h-0 flex-1">
									<RoleLibraryPanel
										v2ProjectId={v2ProjectId}
										onAddRole={addRoleNode}
									/>
								</TabsContent>
								<TabsContent value="triggers" className="min-h-0 flex-1">
									<TriggerConfigPanel
										pipelineId={pipelineId}
										selectedNodeId={selectedNodeId}
										selectedNodeLabel={null}
									/>
								</TabsContent>
								<TabsContent value="runs" className="min-h-0 flex-1">
									<RunMonitorPanel
										pipelineId={pipelineId}
										activeRunId={runTrace.activeRunId}
										onSelectRun={runTrace.setActiveRunId}
									/>
								</TabsContent>
							</Tabs>
						)}
					</aside>
				)}
			</div>
		</div>
	);
}

function SaveIndicator({ state }: { state: "idle" | "saving" | "saved" }) {
	if (state === "saving") {
		return (
			<output
				aria-live="polite"
				className="flex items-center gap-1 whitespace-nowrap text-xs text-muted-foreground"
			>
				<Loader2 className="size-3 animate-spin" /> сохранение…
			</output>
		);
	}
	if (state === "saved") {
		return (
			<output
				aria-live="polite"
				className="flex items-center gap-1 whitespace-nowrap text-xs text-emerald-500"
			>
				<Save className="size-3" /> сохранено
			</output>
		);
	}
	return null;
}
