import {
	type AgentDefinitionId,
	DEFAULT_CHAT_AGENT_TYPE,
	getEnabledAgentConfigs,
	indexResolvedAgentConfigs,
} from "@rox/shared/agent-settings";
import { sanitizeBranchNameWithMaxLength } from "@rox/shared/workspace-launch";
import {
	PromptInput,
	PromptInputAttachment,
	PromptInputAttachments,
	PromptInputButton,
	PromptInputFooter,
	PromptInputSubmit,
	PromptInputTextarea,
	PromptInputTools,
	usePromptInputAttachments,
	useProviderAttachments,
} from "@rox/ui/ai-elements/prompt-input";
import { Button } from "@rox/ui/button";
import {
	Command,
	CommandEmpty,
	CommandGroup,
	CommandInput,
	CommandItem,
	CommandList,
	CommandSeparator,
} from "@rox/ui/command";
import { Input } from "@rox/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@rox/ui/popover";
import { toast } from "@rox/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rox/ui/tooltip";
import { cn } from "@rox/ui/utils";
import { blobToBase64, MicButton, type Recording } from "@rox/ui/voice";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { AnimatePresence, motion } from "framer-motion";
import {
	ArrowUpIcon,
	ExternalLinkIcon,
	PaperclipIcon,
	PlusIcon,
} from "lucide-react";
import { useCallback, useMemo, useRef, useState } from "react";
import {
	GoArrowUpRight,
	GoGitBranch,
	GoGlobe,
	GoIssueOpened,
} from "react-icons/go";
import { HiCheck, HiChevronUpDown } from "react-icons/hi2";
import { LuFolderGit, LuFolderOpen, LuGitPullRequest } from "react-icons/lu";
import { AgentSelect } from "renderer/components/AgentSelect";
import { getDictationDisabledReason } from "renderer/components/Chat/ChatInterface/components/ChatInputFooter/components/ChatComposerControls/dictationAffordance";
import { LinkedIssuePill } from "renderer/components/Chat/ChatInterface/components/ChatInputFooter/components/LinkedIssuePill";
import { useAgentLaunchPreferences } from "renderer/hooks/useAgentLaunchPreferences";
import { PLATFORM } from "renderer/hotkeys";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { formatRelativeTime } from "renderer/lib/formatRelativeTime";
import { apiClient } from "renderer/routes/_authenticated/providers/CollectionsProvider/collections";
import { ProjectThumbnail } from "renderer/screens/main/components/WorkspaceSidebar/ProjectSection/ProjectThumbnail";
import { useNewWorkspaceModalOpen } from "renderer/stores/new-workspace-modal";
import type { LinkedPR } from "../../NewWorkspaceModalDraftContext";
import { useNewWorkspaceModalDraft } from "../../NewWorkspaceModalDraftContext";
import { GitHubIssueLinkCommand } from "./components/GitHubIssueLinkCommand";
import { LinkedGitHubIssuePill } from "./components/LinkedGitHubIssuePill";
import { LinkedPRPill } from "./components/LinkedPRPill";
import { PRLinkCommand } from "./components/PRLinkCommand";
import { useBranchResolution } from "./hooks/useBranchResolution";
import { useWorkspaceCreate } from "./hooks/useWorkspaceCreate";
import type { OpenableWorktreeAction } from "./utils/resolveOpenableWorktrees";

type WorkspaceCreateAgent = AgentDefinitionId | "none";

const AGENT_STORAGE_KEY = "lastSelectedWorkspaceCreateAgent";

const PILL_BUTTON_CLASS =
	"!h-[22px] min-h-0 rounded-md border-[0.5px] border-border bg-foreground/[0.04] shadow-none text-[11px]";

interface ProjectOption {
	id: string;
	name: string;
	color: string;
	githubOwner: string | null;
	iconUrl: string | null;
	hideImage: boolean | null;
}

interface PromptGroupProps {
	projectId: string | null;
	selectedProject: ProjectOption | undefined;
	recentProjects: ProjectOption[];
	onSelectProject: (projectId: string) => void;
	onImportRepo: () => void;
	onNewProject: () => void;
}

export function PromptGroup(props: PromptGroupProps) {
	return <PromptGroupInner {...props} />;
}

function AttachmentButtons({
	anchorRef,
	onOpenGitHubIssue,
	onOpenPRLink,
}: {
	anchorRef: React.RefObject<HTMLDivElement | null>;
	onOpenGitHubIssue: () => void;
	onOpenPRLink: () => void;
}) {
	const attachments = usePromptInputAttachments();

	return (
		<div ref={anchorRef} className="flex items-center gap-1">
			<Tooltip>
				<TooltipTrigger asChild>
					<PromptInputButton
						className={`${PILL_BUTTON_CLASS} w-[22px]`}
						onClick={() => attachments.openFileDialog()}
					>
						<PaperclipIcon className="size-3.5" />
					</PromptInputButton>
				</TooltipTrigger>
				<TooltipContent side="bottom">Добавить вложение</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<PromptInputButton
						className={`${PILL_BUTTON_CLASS} w-[22px]`}
						onClick={onOpenGitHubIssue}
					>
						<GoIssueOpened className="size-3.5" />
					</PromptInputButton>
				</TooltipTrigger>
				<TooltipContent side="bottom">Связать задачу GitHub</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<PromptInputButton
						className={`${PILL_BUTTON_CLASS} w-[22px]`}
						onClick={onOpenPRLink}
					>
						<LuGitPullRequest className="size-3.5" />
					</PromptInputButton>
				</TooltipTrigger>
				<TooltipContent side="bottom">Связать pull request</TooltipContent>
			</Tooltip>
		</div>
	);
}

function ProjectPickerPill({
	selectedProject,
	recentProjects,
	onSelectProject,
	onImportRepo,
	onNewProject,
}: {
	selectedProject: ProjectOption | undefined;
	recentProjects: ProjectOption[];
	onSelectProject: (projectId: string) => void;
	onImportRepo: () => void;
	onNewProject: () => void;
}) {
	const [open, setOpen] = useState(false);

	return (
		<Popover open={open} onOpenChange={setOpen}>
			<PopoverTrigger asChild>
				<PromptInputButton
					className={`${PILL_BUTTON_CLASS} px-1.5 gap-1 text-foreground w-auto max-w-[140px]`}
				>
					{selectedProject && (
						<ProjectThumbnail
							projectId={selectedProject.id}
							projectName={selectedProject.name}
							projectColor={selectedProject.color}
							githubOwner={selectedProject.githubOwner}
							iconUrl={selectedProject.iconUrl}
							hideImage={selectedProject.hideImage ?? false}
							className="!size-3"
						/>
					)}
					<span className="truncate">
						{selectedProject?.name ?? "Select project"}
					</span>
					<HiChevronUpDown className="size-3 shrink-0 text-muted-foreground" />
				</PromptInputButton>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="w-60 p-0"
				onWheel={(event) => event.stopPropagation()}
			>
				<Command>
					<CommandInput placeholder="Поиск проектов..." />
					<CommandList>
						<CommandEmpty>Проекты не найдены.</CommandEmpty>
						<CommandGroup>
							{recentProjects.map((project) => (
								<CommandItem
									key={project.id}
									value={project.name}
									onSelect={() => {
										onSelectProject(project.id);
										setOpen(false);
									}}
								>
									<ProjectThumbnail
										projectId={project.id}
										projectName={project.name}
										projectColor={project.color}
										githubOwner={project.githubOwner}
										iconUrl={project.iconUrl}
										hideImage={project.hideImage ?? false}
									/>
									{project.name}
									{project.id === selectedProject?.id && (
										<HiCheck className="ml-auto size-4" />
									)}
								</CommandItem>
							))}
						</CommandGroup>
						<CommandSeparator alwaysRender />
						<CommandGroup forceMount>
							<CommandItem
								forceMount
								onSelect={() => {
									setOpen(false);
									onImportRepo();
								}}
							>
								<LuFolderOpen className="size-4" />
								Open project
							</CommandItem>
							<CommandItem
								forceMount
								onSelect={() => {
									setOpen(false);
									onNewProject();
								}}
							>
								<LuFolderGit className="size-4" />
								New project
							</CommandItem>
						</CommandGroup>
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function CompareBaseBranchPickerInline({
	effectiveCompareBaseBranch,
	defaultBranch,
	isBranchesLoading,
	isBranchesError,
	branches,
	worktreeBranches,
	openableWorktrees,
	activeWorkspacesByBranch,
	externalWorktreeBranches,
	modKey,
	onSelectCompareBaseBranch,
	onOpenWorktree,
	onOpenActiveWorkspace,
}: {
	effectiveCompareBaseBranch: string | null;
	defaultBranch?: string;
	isBranchesLoading: boolean;
	isBranchesError: boolean;
	branches: Array<{ name: string; lastCommitDate: number; isLocal: boolean }>;
	worktreeBranches: Set<string>;
	openableWorktrees: Map<string, OpenableWorktreeAction>;
	activeWorkspacesByBranch: Map<string, string>;
	externalWorktreeBranches: Set<string>;
	modKey: string;
	onSelectCompareBaseBranch: (branchName: string) => void;
	onOpenWorktree: (action: OpenableWorktreeAction) => void;
	onOpenActiveWorkspace: (workspaceId: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const [branchSearch, setBranchSearch] = useState("");
	const [filterMode, setFilterMode] = useState<"all" | "worktrees">("all");

	const filteredBranches = useMemo(() => {
		if (!branches.length) return [];
		if (!branchSearch) return branches;
		const searchLower = branchSearch.toLowerCase();
		return branches.filter((branch) =>
			branch.name.toLowerCase().includes(searchLower),
		);
	}, [branches, branchSearch]);

	const displayBranches = useMemo(() => {
		if (filterMode === "all") return filteredBranches;
		return filteredBranches.filter((b) => worktreeBranches.has(b.name));
	}, [filteredBranches, filterMode, worktreeBranches]);

	if (isBranchesError) {
		return (
			<span className="text-xs text-destructive">
				Не удалось загрузить ветки
			</span>
		);
	}

	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) {
					setBranchSearch("");
					setFilterMode("all");
				}
			}}
		>
			<PopoverTrigger asChild>
				<button
					type="button"
					disabled={isBranchesLoading}
					className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-50 min-w-0 max-w-full"
				>
					<GoGitBranch className="size-3 shrink-0" />
					{isBranchesLoading ? (
						<span className="h-2.5 w-14 rounded-sm bg-muted-foreground/15 animate-pulse" />
					) : (
						<span className="font-mono truncate">
							{effectiveCompareBaseBranch || "..."}
						</span>
					)}
					<HiChevronUpDown className="size-3 shrink-0" />
				</button>
			</PopoverTrigger>
			<PopoverContent
				className="w-96 p-0"
				align="start"
				onWheel={(event) => event.stopPropagation()}
			>
				<Command shouldFilter={false}>
					<div className="flex items-center gap-0.5 rounded-md bg-muted/40 p-0.5 mx-2 mt-2">
						{(["all", "worktrees"] as const).map((value) => {
							const count =
								value === "all"
									? branches.length
									: branches.filter((b) => worktreeBranches.has(b.name)).length;
							return (
								<button
									key={value}
									type="button"
									onClick={() => setFilterMode(value)}
									className={cn(
										"flex-1 rounded px-2 py-1 text-xs text-center transition-colors",
										filterMode === value
											? "bg-background text-foreground shadow-sm"
											: "text-muted-foreground hover:text-foreground",
									)}
								>
									{value === "all" ? "All" : "Worktrees"}
									<span className="ml-1 text-foreground/40">{count}</span>
								</button>
							);
						})}
					</div>
					<CommandInput
						placeholder="Поиск веток..."
						value={branchSearch}
						onValueChange={setBranchSearch}
					/>
					<CommandList className="max-h-[400px]">
						<CommandEmpty>Ветки не найдены</CommandEmpty>
						{displayBranches.map((branch) => {
							const openAction = openableWorktrees.get(branch.name);
							const activeWorkspaceId = activeWorkspacesByBranch.get(
								branch.name,
							);
							const isExternal = externalWorktreeBranches.has(branch.name);
							const hasExistingWorkspace = !!(activeWorkspaceId || openAction);

							// Determine icon based on state - all same color
							let icon: React.ReactNode;
							if (activeWorkspaceId) {
								icon = (
									<GoArrowUpRight className="size-3.5 shrink-0 text-muted-foreground" />
								);
							} else if (openAction) {
								icon = (
									<ExternalLinkIcon className="size-3.5 shrink-0 text-muted-foreground" />
								);
							} else if (branch.isLocal) {
								icon = (
									<GoGitBranch className="size-3.5 shrink-0 text-muted-foreground" />
								);
							} else {
								icon = (
									<GoGlobe className="size-3.5 shrink-0 text-muted-foreground" />
								);
							}

							return (
								<CommandItem
									key={branch.name}
									value={branch.name}
									onSelect={() => {
										if (activeWorkspaceId) {
											onOpenActiveWorkspace(activeWorkspaceId);
										} else if (openAction) {
											onOpenWorktree(openAction);
										} else {
											onSelectCompareBaseBranch(branch.name);
										}
										setOpen(false);
									}}
									className="group h-11 flex items-center justify-between gap-3 px-3"
								>
									<span className="flex items-center gap-2.5 truncate flex-1 min-w-0">
										{icon}
										<span className="truncate font-mono text-xs">
											{branch.name}
										</span>

										{/* Inline badges */}
										<span className="flex items-center gap-1.5 shrink-0">
											{branch.name === defaultBranch && (
												<span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
													default
												</span>
											)}
											{isExternal && !activeWorkspaceId && (
												<span className="text-[10px] text-muted-foreground/60 bg-muted/60 px-1.5 py-0.5 rounded">
													external
												</span>
											)}
										</span>
									</span>

									{/* Right side: time + buttons */}
									<span className="flex items-center gap-2 shrink-0">
										{branch.lastCommitDate > 0 && (
											<span className="text-[11px] text-muted-foreground/70 group-data-[selected=true]:hidden">
												{formatRelativeTime(branch.lastCommitDate)}
											</span>
										)}

										{/* Show checkmark for selected base branch when not hovering */}
										{!hasExistingWorkspace &&
											effectiveCompareBaseBranch === branch.name && (
												<HiCheck className="size-4 text-primary group-data-[selected=true]:hidden" />
											)}

										{/* Action buttons - show on hover/select */}
										<span className="hidden group-data-[selected=true]:flex items-center gap-1.5">
											{hasExistingWorkspace && (
												<Button
													size="sm"
													variant="ghost"
													className="h-7 px-2.5 text-xs font-medium hover:bg-accent/10 hover:text-accent-foreground"
													onClick={(e) => {
														e.stopPropagation();
														if (activeWorkspaceId) {
															onOpenActiveWorkspace(activeWorkspaceId);
														} else if (openAction) {
															onOpenWorktree(openAction);
														}
														setOpen(false);
													}}
												>
													<GoArrowUpRight className="size-3.5 mr-1" />
													Open
													<span className="ml-1 text-[10px] opacity-60">↵</span>
												</Button>
											)}
											<Button
												size="sm"
												className="h-7 px-2.5 text-xs font-medium"
												onClick={(e) => {
													e.stopPropagation();
													onSelectCompareBaseBranch(branch.name);
													setOpen(false);
												}}
											>
												{hasExistingWorkspace ? (
													<>
														<PlusIcon className="size-3.5 mr-1" />
														Create
														<span className="ml-1 text-[10px] opacity-70">
															{modKey}↵
														</span>
													</>
												) : (
													<>
														Create
														<span className="ml-1 text-[10px] opacity-70">
															↵
														</span>
													</>
												)}
											</Button>
										</span>
									</span>
								</CommandItem>
							);
						})}
					</CommandList>
				</Command>
			</PopoverContent>
		</Popover>
	);
}

function PromptGroupInner({
	projectId,
	selectedProject,
	recentProjects,
	onSelectProject,
	onImportRepo,
	onNewProject,
}: PromptGroupProps) {
	const navigate = useNavigate();
	const modKey = PLATFORM === "mac" ? "⌘" : "Ctrl";
	const isNewWorkspaceModalOpen = useNewWorkspaceModalOpen();
	const {
		closeAndResetDraft,
		closeModal,
		createWorkspace,
		createFromPr,
		openTrackedWorktree,
		openExternalWorktree,
		draft,
		runAsyncAction,
		updateDraft,
	} = useNewWorkspaceModalDraft();
	const attachments = useProviderAttachments();
	const {
		compareBaseBranch,
		prompt,
		workspaceName,
		branchName,
		linkedIssues,
		linkedPR,
	} = draft;
	const agentPresetsQuery = electronTrpc.settings.getAgentPresets.useQuery();
	const agentPresets = agentPresetsQuery.data ?? [];
	const enabledAgentPresets = useMemo(
		() => getEnabledAgentConfigs(agentPresets),
		[agentPresets],
	);
	const agentConfigsById = useMemo(
		() => indexResolvedAgentConfigs(agentPresets),
		[agentPresets],
	);
	const selectableAgentIds = useMemo(
		() => enabledAgentPresets.map((preset) => preset.id),
		[enabledAgentPresets],
	);
	const { selectedAgent, setSelectedAgent } =
		useAgentLaunchPreferences<WorkspaceCreateAgent>({
			agentStorageKey: AGENT_STORAGE_KEY,
			defaultAgent: DEFAULT_CHAT_AGENT_TYPE,
			fallbackAgent: "none",
			validAgents: ["none", ...selectableAgentIds],
			agentsReady: agentPresetsQuery.isFetched,
		});
	const [gitHubIssueLinkOpen, setGitHubIssueLinkOpen] = useState(false);
	const [prLinkOpen, setPRLinkOpen] = useState(false);
	const plusMenuRef = useRef<HTMLDivElement>(null);

	const { handleCreate, handlePromptSubmit } = useWorkspaceCreate({
		projectId,
		isNewWorkspaceModalOpen,
		selectedAgent,
		agentConfigsById,
		draft,
		closeAndResetDraft,
		createWorkspace,
		createFromPr,
		runAsyncAction,
	});
	const electronUtils = electronTrpc.useUtils();
	const dictationEnabled =
		electronTrpc.settings.getDictationEnabled.useQuery().data;
	const { data: permissionStatus } =
		electronTrpc.permissions.getStatus.useQuery();
	const { data: voiceConfig } = useQuery({
		queryKey: ["voice", "isConfigured"],
		queryFn: () => apiClient.voice.isConfigured.query(),
		staleTime: Number.POSITIVE_INFINITY,
	});
	const micDisabledReason = getDictationDisabledReason({
		dictationEnabled,
		dictationConfigured: voiceConfig?.configured,
		microphoneGranted: permissionStatus?.microphone,
	});
	const [dictationTranscribing, setDictationTranscribing] = useState(false);
	const handleDictationComplete = useCallback(
		async (recording: Recording) => {
			setDictationTranscribing(true);
			try {
				const audioBase64 = await blobToBase64(recording.blob);
				const voiceAgentContext =
					await electronUtils.settings.getVoiceAgentContext
						.fetch()
						.catch(() => "");
				const result = await apiClient.voice.transcribe.mutate({
					audioBase64,
					mimeType: recording.mimeType,
					durationMs: recording.durationMs,
					voiceAgentContext: voiceAgentContext?.trim() || undefined,
				});
				const text = (result.processed?.ru || result.rawText || "").trim();
				if (!text) {
					toast.info("Не удалось распознать речь");
					return;
				}
				updateDraft({ prompt: prompt ? `${prompt} ${text}` : text });
			} catch {
				toast.error("Ошибка расшифровки — запись сохранена для повтора");
			} finally {
				setDictationTranscribing(false);
			}
		},
		[electronUtils, prompt, updateDraft],
	);

	const {
		project,
		branchData,
		isBranchesLoading,
		isBranchesError,
		worktreeBranches,
		activeWorkspacesByBranch,
		openableWorktrees,
		externalWorktreeBranches,
		effectiveCompareBaseBranch,
		handleCompareBaseBranchSelect,
		handleOpenWorktree,
		handleOpenActiveWorkspace,
	} = useBranchResolution({
		projectId,
		compareBaseBranch,
		closeModal,
		navigate,
		openTrackedWorktree,
		openExternalWorktree,
		runAsyncAction,
		updateDraft,
	});

	const addLinkedGitHubIssue = (
		issueNumber: number,
		title: string,
		url: string,
		state: string,
	) => {
		// Normalize state to valid type
		const normalizedState: "open" | "closed" =
			state.toLowerCase() === "closed" ? "closed" : "open";

		const issue = {
			slug: `#${issueNumber}`,
			title,
			source: "github" as const,
			url,
			number: issueNumber,
			state: normalizedState,
		};
		// Check for duplicates by URL to handle same issue numbers from different repos
		if (linkedIssues.some((i) => i.url === url)) return;
		updateDraft({ linkedIssues: [...linkedIssues, issue] });
	};

	const removeLinkedIssue = (slug: string) => {
		updateDraft({
			linkedIssues: linkedIssues.filter((issue) => issue.slug !== slug),
		});
	};

	const setLinkedPR = (pr: LinkedPR) => {
		updateDraft({ linkedPR: pr });
	};

	const removeLinkedPR = () => {
		updateDraft({ linkedPR: null });
	};

	return (
		<div className="p-3 space-y-2">
			<div className="flex items-center">
				<Input
					className="border-none bg-transparent dark:bg-transparent shadow-none text-base font-medium px-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/40 min-w-0 flex-1"
					placeholder="Имя рабочего пространства (необязательно)"
					value={workspaceName}
					onChange={(e) =>
						updateDraft({
							workspaceName: e.target.value,
							workspaceNameEdited: true,
						})
					}
					onBlur={() => {
						if (!workspaceName.trim()) {
							updateDraft({ workspaceName: "", workspaceNameEdited: false });
						}
					}}
				/>
				<div className="shrink min-w-0 ml-auto max-w-[50%]">
					<Input
						className={cn(
							"border-none bg-transparent dark:bg-transparent shadow-none text-xs font-mono text-muted-foreground/60 px-0 h-auto focus-visible:ring-0 placeholder:text-muted-foreground/30 focus:text-muted-foreground text-right placeholder:text-right overflow-hidden text-ellipsis",
						)}
						placeholder="имя ветки"
						value={branchName}
						onChange={(e) =>
							updateDraft({
								branchName: e.target.value.replace(/\s+/g, "-"),
								branchNameEdited: true,
							})
						}
						onBlur={() => {
							const sanitized = sanitizeBranchNameWithMaxLength(
								branchName.trim(),
								undefined,
								{ preserveCase: true },
							);
							if (!sanitized) {
								updateDraft({ branchName: "", branchNameEdited: false });
							} else {
								updateDraft({ branchName: sanitized });
							}
						}}
					/>
				</div>
			</div>

			<PromptInput
				onSubmit={handlePromptSubmit}
				multiple
				maxFiles={5}
				maxFileSize={10 * 1024 * 1024}
				className="[&>[data-slot=input-group]]:rounded-[13px] [&>[data-slot=input-group]]:border-[0.5px] [&>[data-slot=input-group]]:shadow-none [&>[data-slot=input-group]]:bg-foreground/[0.02]"
			>
				{(linkedPR ||
					linkedIssues.length > 0 ||
					attachments.files.length > 0) && (
					<div className="flex flex-wrap items-start gap-2 px-3 pt-3 self-stretch">
						<AnimatePresence initial={false}>
							{linkedPR && (
								<motion.div
									key="linked-pr"
									initial={{ opacity: 0, scale: 0.8 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.8 }}
									transition={{ duration: 0.15 }}
								>
									<LinkedPRPill
										prNumber={linkedPR.prNumber}
										title={linkedPR.title}
										state={linkedPR.state}
										onRemove={removeLinkedPR}
									/>
								</motion.div>
							)}
							{linkedIssues.map((issue) => (
								<motion.div
									key={issue.slug}
									initial={{ opacity: 0, scale: 0.8 }}
									animate={{ opacity: 1, scale: 1 }}
									exit={{ opacity: 0, scale: 0.8 }}
									transition={{ duration: 0.15 }}
								>
									{issue.source === "github" ? (
										<LinkedGitHubIssuePill
											issueNumber={issue.number ?? 0}
											title={issue.title}
											state={issue.state ?? "open"}
											onRemove={() => removeLinkedIssue(issue.slug)}
										/>
									) : (
										<LinkedIssuePill
											slug={issue.slug}
											title={issue.title}
											url={issue.url}
											taskId={issue.taskId}
											onRemove={() => removeLinkedIssue(issue.slug)}
										/>
									)}
								</motion.div>
							))}
						</AnimatePresence>
						<PromptInputAttachments>
							{(file) => <PromptInputAttachment data={file} />}
						</PromptInputAttachments>
					</div>
				)}
				<PromptInputTextarea
					autoFocus
					placeholder="Что вы хотите сделать?"
					className="min-h-10"
					value={prompt}
					onChange={(e) => updateDraft({ prompt: e.target.value })}
				/>
				<PromptInputFooter>
					<PromptInputTools className="gap-1.5">
						<AgentSelect<WorkspaceCreateAgent>
							agents={enabledAgentPresets}
							value={selectedAgent}
							placeholder="Без агента"
							onValueChange={setSelectedAgent}
							onBeforeConfigureAgents={closeModal}
							triggerClassName={`${PILL_BUTTON_CLASS} px-1.5 gap-1 text-foreground w-auto max-w-[160px]`}
							iconClassName="size-3 object-contain"
							allowNone
							noneLabel="Без агента"
							noneValue="none"
						/>
					</PromptInputTools>
					<div className="flex items-center gap-2">
						<AttachmentButtons
							anchorRef={plusMenuRef}
							onOpenGitHubIssue={() =>
								requestAnimationFrame(() => setGitHubIssueLinkOpen(true))
							}
							onOpenPRLink={() =>
								requestAnimationFrame(() => setPRLinkOpen(true))
							}
						/>
						<GitHubIssueLinkCommand
							open={gitHubIssueLinkOpen}
							onOpenChange={setGitHubIssueLinkOpen}
							onSelect={(issue) =>
								addLinkedGitHubIssue(
									issue.issueNumber,
									issue.title,
									issue.url,
									issue.state,
								)
							}
							projectId={projectId}
							anchorRef={plusMenuRef}
						/>
						<PRLinkCommand
							open={prLinkOpen}
							onOpenChange={setPRLinkOpen}
							onSelect={setLinkedPR}
							projectId={projectId}
							githubOwner={project?.githubOwner ?? null}
							repoName={project?.mainRepoPath.split("/").pop() ?? null}
							anchorRef={plusMenuRef}
						/>
						<MicButton
							onComplete={handleDictationComplete}
							transcribing={dictationTranscribing}
							disabled={micDisabledReason !== undefined}
							disabledReason={micDisabledReason}
						/>
						<PromptInputSubmit
							className="size-[22px] rounded-full border border-transparent bg-foreground/10 shadow-none p-[5px] hover:bg-foreground/20"
							onClick={(e) => {
								e.preventDefault();
								void handleCreate();
							}}
						>
							<ArrowUpIcon className="size-3.5 text-muted-foreground" />
						</PromptInputSubmit>
					</div>
				</PromptInputFooter>
			</PromptInput>

			<div className="flex items-center justify-between gap-2">
				<div className="flex items-center gap-2 min-w-0 flex-1">
					<ProjectPickerPill
						selectedProject={selectedProject}
						recentProjects={recentProjects}
						onSelectProject={onSelectProject}
						onImportRepo={onImportRepo}
						onNewProject={onNewProject}
					/>
					<AnimatePresence mode="wait" initial={false}>
						{linkedPR ? (
							<motion.span
								key="linked-pr-label"
								initial={{ opacity: 0, x: -8, filter: "blur(4px)" }}
								animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
								exit={{ opacity: 0, x: 8, filter: "blur(4px)" }}
								transition={{ duration: 0.2, ease: "easeOut" }}
								className="flex items-center gap-1 text-xs text-muted-foreground"
							>
								<LuGitPullRequest className="size-3 shrink-0" />
								от PR #{linkedPR.prNumber}
							</motion.span>
						) : (
							<motion.div
								key="branch-picker"
								className="min-w-0"
								initial={{ opacity: 0, x: -8, filter: "blur(4px)" }}
								animate={{ opacity: 1, x: 0, filter: "blur(0px)" }}
								exit={{ opacity: 0, x: 8, filter: "blur(4px)" }}
								transition={{ duration: 0.2, ease: "easeOut" }}
							>
								<CompareBaseBranchPickerInline
									effectiveCompareBaseBranch={effectiveCompareBaseBranch}
									defaultBranch={branchData?.defaultBranch}
									isBranchesLoading={isBranchesLoading}
									isBranchesError={isBranchesError}
									branches={branchData?.branches ?? []}
									worktreeBranches={worktreeBranches}
									openableWorktrees={openableWorktrees}
									activeWorkspacesByBranch={activeWorkspacesByBranch}
									externalWorktreeBranches={externalWorktreeBranches}
									modKey={modKey}
									onSelectCompareBaseBranch={handleCompareBaseBranchSelect}
									onOpenWorktree={handleOpenWorktree}
									onOpenActiveWorkspace={handleOpenActiveWorkspace}
								/>
							</motion.div>
						)}
					</AnimatePresence>
				</div>
				<span className="text-[11px] text-muted-foreground/50">
					{modKey}↵ создать
				</span>
			</div>
		</div>
	);
}
