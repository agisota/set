import {
	closestCenter,
	DndContext,
	type DragEndEvent,
	DragOverlay,
	KeyboardSensor,
	MeasuringStrategy,
	MouseSensor,
	TouchSensor,
	useSensor,
	useSensors,
} from "@dnd-kit/core";
import {
	arrayMove,
	SortableContext,
	sortableKeyboardCoordinates,
	useSortable,
	verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { CollapseLabel } from "@rox/ui/motion";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rox/ui/tooltip";
import { cn } from "@rox/ui/utils";
import { useMatchRoute, useNavigate } from "@tanstack/react-router";
import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
	HiOutlineBookOpen,
	HiOutlineCalendarDays,
	HiOutlineCog6Tooth,
	HiOutlineDocumentText,
	HiOutlineEnvelope,
	HiOutlineFolder,
	HiOutlineInbox,
	HiOutlineRectangleGroup,
	HiOutlineSparkles,
} from "react-icons/hi2";
import { useHotkeyDisplay } from "renderer/hotkeys";
import { useDashboardSidebarState } from "renderer/routes/_authenticated/hooks/useDashboardSidebarState";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useUnreadCount } from "renderer/screens/suite/InboxView";
import { useSurfaceVisibilityStore } from "renderer/stores/surface-visibility";
import { DashboardSidebarHeader } from "./components/DashboardSidebarHeader";
import { DashboardSidebarHelpMenu } from "./components/DashboardSidebarHelpMenu";
import { DashboardSidebarHoverCardOverlay } from "./components/DashboardSidebarHoverCardOverlay";
import { DashboardSidebarNavButton } from "./components/DashboardSidebarNavButton";
import { DashboardSidebarPortsList } from "./components/DashboardSidebarPortsList";
import { DashboardSidebarProjectSection } from "./components/DashboardSidebarProjectSection";
import { DashboardSidebarSectionRenameProvider } from "./components/DashboardSidebarSectionRenameContext";
import { V2SetupScriptCard } from "./components/V2SetupScriptCard";
import { useDashboardSidebarData } from "./hooks/useDashboardSidebarData";
import { useDashboardSidebarShortcuts } from "./hooks/useDashboardSidebarShortcuts";
import { DashboardSidebarHoverProvider } from "./providers/DashboardSidebarHoverProvider";
import type { DashboardSidebarProject } from "./types";
import { filterSidebarGroups } from "./utils/filterSidebarGroups";

interface DashboardSidebarProps {
	isCollapsed?: boolean;
}

interface SortableProjectWrapperProps {
	project: DashboardSidebarProject;
	isCollapsed: boolean;
	isDraggingProject: boolean;
	workspaceShortcutLabels: Map<string, string>;
	onWorkspaceHover: (workspaceId: string) => void | Promise<void>;
	onToggleCollapse: (projectId: string) => void;
}

const SortableProjectWrapper = memo(function SortableProjectWrapper({
	project,
	isCollapsed,
	isDraggingProject,
	workspaceShortcutLabels,
	onWorkspaceHover,
	onToggleCollapse,
}: SortableProjectWrapperProps) {
	const {
		attributes,
		listeners,
		setNodeRef,
		transform,
		transition,
		isDragging,
	} = useSortable({ id: project.id });

	return (
		<div
			ref={setNodeRef}
			style={{
				transform: CSS.Translate.toString(transform),
				transition,
				opacity: isDragging ? 0.5 : undefined,
			}}
		>
			<DashboardSidebarProjectSection
				project={project}
				isSidebarCollapsed={isCollapsed}
				isDraggingProject={isDraggingProject}
				workspaceShortcutLabels={workspaceShortcutLabels}
				onWorkspaceHover={onWorkspaceHover}
				onToggleCollapse={onToggleCollapse}
				dragHandleListeners={listeners}
				dragHandleAttributes={attributes}
			/>
		</div>
	);
});

export function DashboardSidebar({
	isCollapsed = false,
}: DashboardSidebarProps) {
	const { groups, refreshWorkspacePullRequest, toggleProjectCollapsed } =
		useDashboardSidebarData();
	const { reorderProjects } = useDashboardSidebarState();
	const navigate = useNavigate();
	const matchRoute = useMatchRoute();
	const settingsHotkey = useHotkeyDisplay("OPEN_SETTINGS").text;
	const isSettingsOpen = !!matchRoute({ to: "/settings", fuzzy: true });
	const isCanvasOpen = !!matchRoute({ to: "/canvas", fuzzy: true });
	const isJournalOpen = !!matchRoute({ to: "/journal", fuzzy: true });
	const isMemoryOpen = !!matchRoute({ to: "/memory", fuzzy: true });
	const isDriveOpen = !!matchRoute({ to: "/drive", fuzzy: true });
	const isCalendarOpen = !!matchRoute({ to: "/calendar", fuzzy: true });
	const isNotesOpen = !!matchRoute({ to: "/notes", fuzzy: true });
	const isEmailOpen = !!matchRoute({ to: "/email", fuzzy: true });
	const isInboxOpen = !!matchRoute({ to: "/inbox", fuzzy: true });
	const inboxUnread = useUnreadCount();
	const { activeHostUrl } = useLocalHostService();
	const v2RouteMatch = matchRoute({ to: "/v2-workspace/$workspaceId" });
	const activeV2WorkspaceId = v2RouteMatch ? v2RouteMatch.workspaceId : null;

	const surfaceVisibility = useSurfaceVisibilityStore(
		(state) => state.visibility,
	);
	const anySurfaceVisible = Object.values(surfaceVisibility).some(Boolean);

	const sensors = useSensors(
		useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
		useSensor(TouchSensor, {
			activationConstraint: { delay: 200, tolerance: 5 },
		}),
		useSensor(KeyboardSensor, {
			coordinateGetter: sortableKeyboardCoordinates,
		}),
	);

	const [activeProject, setActiveProject] =
		useState<DashboardSidebarProject | null>(null);

	// Local project order — syncs from groups, updated on drag end
	const [projectOrder, setProjectOrder] = useState(() =>
		groups.map((p) => p.id),
	);
	useEffect(() => {
		setProjectOrder(groups.map((p) => p.id));
	}, [groups]);

	const orderedGroups = useMemo(() => {
		const byId = new Map(groups.map((g) => [g.id, g]));
		return projectOrder
			.map((id) => byId.get(id))
			.filter((g): g is DashboardSidebarProject => g != null);
	}, [groups, projectOrder]);

	const [filterQuery, setFilterQuery] = useState("");
	const isFiltering = filterQuery.trim().length > 0;
	const displayGroups = useMemo(
		() => filterSidebarGroups(orderedGroups, filterQuery),
		[orderedGroups, filterQuery],
	);

	const workspaceShortcutLabels = useDashboardSidebarShortcuts(orderedGroups);

	const activeV2Project = useMemo(() => {
		if (!activeV2WorkspaceId) return null;
		for (const project of groups) {
			for (const child of project.children) {
				if (
					child.type === "workspace" &&
					child.workspace.id === activeV2WorkspaceId
				) {
					return project;
				}
				if (child.type === "section") {
					for (const ws of child.section.workspaces) {
						if (ws.id === activeV2WorkspaceId) return project;
					}
				}
			}
		}
		return null;
	}, [groups, activeV2WorkspaceId]);

	const handleDragEnd = useCallback(
		({ active, over }: DragEndEvent) => {
			if (isFiltering) {
				setActiveProject(null);
				return;
			}
			if (over && active.id !== over.id) {
				const oldIndex = projectOrder.indexOf(String(active.id));
				const newIndex = projectOrder.indexOf(String(over.id));
				if (oldIndex !== -1 && newIndex !== -1) {
					const reordered = arrayMove(projectOrder, oldIndex, newIndex);
					setProjectOrder(reordered);
					reorderProjects(reordered);
				}
			}
			setActiveProject(null);
		},
		[isFiltering, projectOrder, reorderProjects],
	);

	return (
		<DashboardSidebarSectionRenameProvider>
			<DashboardSidebarHoverProvider>
				<DashboardSidebarHoverCardOverlay>
					{/* No own border-r: the wrapping ResizablePanel already draws the
					    single 1px divider — a second border here stacked into 2px. */}
					<div className="flex h-full flex-col bg-muted/45 dark:bg-muted/35">
						<DashboardSidebarHeader isCollapsed={isCollapsed} />

						{!isCollapsed && (
							<div className="px-2 pt-0.5 pb-1">
								<input
									value={filterQuery}
									onChange={(event) => setFilterQuery(event.target.value)}
									placeholder="Фильтр по метке или ветке…"
									aria-label="Фильтр веток"
									className="h-7 w-full rounded-md border border-border bg-background px-2 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring"
								/>
							</div>
						)}

						<div className="flex-1 overflow-y-auto hide-scrollbar">
							<DndContext
								sensors={sensors}
								collisionDetection={closestCenter}
								measuring={{
									droppable: { strategy: MeasuringStrategy.Always },
								}}
								onDragStart={({ active }) => {
									const project = groups.find((p) => p.id === active.id);
									setActiveProject(project ?? null);
								}}
								onDragEnd={handleDragEnd}
								onDragCancel={() => setActiveProject(null)}
							>
								<SortableContext
									items={displayGroups.map((project) => project.id)}
									strategy={verticalListSortingStrategy}
								>
									{displayGroups.map((project) => (
										<SortableProjectWrapper
											key={project.id}
											project={project}
											isCollapsed={isCollapsed}
											isDraggingProject={activeProject != null}
											workspaceShortcutLabels={workspaceShortcutLabels}
											onWorkspaceHover={refreshWorkspacePullRequest}
											onToggleCollapse={toggleProjectCollapsed}
										/>
									))}
								</SortableContext>

								{createPortal(
									<DragOverlay dropAnimation={null}>
										{activeProject && (
											<div className="bg-background shadow-lg border-b border-border">
												<DashboardSidebarProjectSection
													project={activeProject}
													isSidebarCollapsed={isCollapsed}
													isDraggingProject
													workspaceShortcutLabels={workspaceShortcutLabels}
													onWorkspaceHover={() => {}}
													onToggleCollapse={() => {}}
												/>
											</div>
										)}
									</DragOverlay>,
									document.body,
								)}
							</DndContext>
							{isFiltering && displayGroups.length === 0 && (
								<p className="px-3 py-4 text-center text-xs text-muted-foreground">
									Ничего не найдено
								</p>
							)}
						</div>
						{!isCollapsed && <DashboardSidebarPortsList />}
						{!isCollapsed && activeV2Project && activeHostUrl && (
							<V2SetupScriptCard
								hostUrl={activeHostUrl}
								projectId={activeV2Project.id}
								projectName={activeV2Project.name}
							/>
						)}
						{/* Secondary surfaces (Settings → Поверхности). The whole block —
						    including its top divider — is omitted when every surface is
						    hidden, so the rail never shows an empty separator. */}
						{anySurfaceVisible && (
							<div
								className={cn(
									"border-t border-border",
									isCollapsed
										? "flex flex-col items-center gap-1 py-1"
										: "flex flex-col gap-0.5 px-2 py-1",
								)}
							>
								{surfaceVisibility.canvas && (
									<DashboardSidebarNavButton
										label="Канвас"
										icon={HiOutlineRectangleGroup}
										isActive={isCanvasOpen}
										isCollapsed={isCollapsed}
										onClick={() => navigate({ to: "/canvas" })}
									/>
								)}
								{surfaceVisibility.journal && (
									<DashboardSidebarNavButton
										label="Журнал"
										icon={HiOutlineBookOpen}
										isActive={isJournalOpen}
										isCollapsed={isCollapsed}
										onClick={() => navigate({ to: "/journal" })}
									/>
								)}
								{surfaceVisibility.memory && (
									<DashboardSidebarNavButton
										label="Память"
										icon={HiOutlineSparkles}
										isActive={isMemoryOpen}
										isCollapsed={isCollapsed}
										onboardingAnchor="nav-memory"
										onClick={() => navigate({ to: "/memory" })}
									/>
								)}
								{surfaceVisibility.inbox && (
									<DashboardSidebarNavButton
										label="Входящие"
										icon={HiOutlineInbox}
										isActive={isInboxOpen}
										isCollapsed={isCollapsed}
										badgeCount={inboxUnread}
										onClick={() => navigate({ to: "/inbox" })}
									/>
								)}
								{surfaceVisibility.drive && (
									<DashboardSidebarNavButton
										label="Диск"
										icon={HiOutlineFolder}
										isActive={isDriveOpen}
										isCollapsed={isCollapsed}
										onClick={() => navigate({ to: "/drive" })}
									/>
								)}
								{surfaceVisibility.calendar && (
									<DashboardSidebarNavButton
										label="Календарь"
										icon={HiOutlineCalendarDays}
										isActive={isCalendarOpen}
										isCollapsed={isCollapsed}
										onClick={() => navigate({ to: "/calendar" })}
									/>
								)}
								{surfaceVisibility.notes && (
									<DashboardSidebarNavButton
										label="Заметки"
										icon={HiOutlineDocumentText}
										isActive={isNotesOpen}
										isCollapsed={isCollapsed}
										onClick={() => navigate({ to: "/notes" })}
									/>
								)}
								{surfaceVisibility.email && (
									<DashboardSidebarNavButton
										label="Почта"
										icon={HiOutlineEnvelope}
										isActive={isEmailOpen}
										isCollapsed={isCollapsed}
										onClick={() => navigate({ to: "/email" })}
									/>
								)}
							</div>
						)}

						<div
							className={cn(
								"border-t border-border",
								isCollapsed
									? "flex flex-col items-center gap-1 py-1"
									: "flex items-center gap-1 px-2 py-1",
							)}
						>
							{isCollapsed ? (
								<Tooltip delayDuration={300}>
									<TooltipTrigger asChild>
										<button
											type="button"
											aria-label="Настройки"
											data-onboarding-anchor="nav-settings"
											onClick={() => navigate({ to: "/settings/account" })}
											className={cn(
												"flex size-8 items-center justify-center rounded-md transition-colors",
												isSettingsOpen
													? "bg-accent text-foreground"
													: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
											)}
										>
											<HiOutlineCog6Tooth className="size-4" />
										</button>
									</TooltipTrigger>
									<TooltipContent side="right">Настройки</TooltipContent>
								</Tooltip>
							) : (
								<button
									type="button"
									data-onboarding-anchor="nav-settings"
									onClick={() => navigate({ to: "/settings/account" })}
									className={cn(
										"group flex flex-1 min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-sm font-medium transition-colors",
										isSettingsOpen
											? "bg-accent text-foreground"
											: "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
									)}
								>
									<HiOutlineCog6Tooth className="size-4 shrink-0" />
									<CollapseLabel
										show={!isCollapsed}
										className="flex-1 text-left"
									>
										Настройки
									</CollapseLabel>
									{settingsHotkey !== "Unassigned" && (
										<span
											className={cn(
												"shrink-0 text-[10px] font-mono tabular-nums text-muted-foreground/60",
												"opacity-0 transition-opacity group-hover:opacity-100 group-focus-visible:opacity-100",
											)}
										>
											{settingsHotkey}
										</span>
									)}
								</button>
							)}

							<DashboardSidebarHelpMenu isCollapsed={isCollapsed} />
						</div>
					</div>
				</DashboardSidebarHoverCardOverlay>
			</DashboardSidebarHoverProvider>
		</DashboardSidebarSectionRenameProvider>
	);
}
