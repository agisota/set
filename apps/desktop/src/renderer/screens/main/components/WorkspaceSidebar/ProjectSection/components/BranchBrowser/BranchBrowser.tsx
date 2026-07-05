import {
	Command,
	CommandEmpty,
	CommandInput,
	CommandItem,
	CommandList,
} from "@rox/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@rox/ui/popover";
import { toast } from "@rox/ui/sonner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@rox/ui/tooltip";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GoGitBranch, GoGlobe } from "react-icons/go";
import { LuFolderOpen } from "react-icons/lu";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { formatRelativeTime } from "renderer/lib/formatRelativeTime";
import { useBranchContext } from "renderer/routes/_authenticated/components/DashboardNewWorkspaceModal/components/DashboardNewWorkspaceForm/hooks/useBranchContext";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { useLocalHostService } from "renderer/routes/_authenticated/providers/LocalHostServiceProvider";
import { useWorkspaceCreates } from "renderer/stores/workspace-creates";
import {
	type BranchBrowserMetadata,
	hasBranchMetadata,
	sortBranchRows,
} from "./branch-browser.utils";

interface BranchBrowserProps {
	projectId: string;
	/** Controlled open state. When provided, the internal trigger button is hidden. */
	open?: boolean;
	onOpenChange?: (open: boolean) => void;
}

/**
 * Sidebar branch browser: lists ALL branches (local + remote) for a project and
 * opens/creates a workspace from any of them. Reuses the creation-screen data
 * path (`useBranchContext` + `useWorkspaceCreates`) so behavior matches the
 * modal's CompareBaseBranchPicker without leaving the sidebar.
 *
 * Renders its own branch-icon trigger button by default. When `open` is
 * controlled (e.g. opened from a context-menu item), the trigger is replaced by
 * a hidden anchor so the popover stays positioned against the project header.
 */
export function BranchBrowser({
	projectId,
	open: controlledOpen,
	onOpenChange,
}: BranchBrowserProps) {
	const isControlled = controlledOpen !== undefined;
	const [internalOpen, setInternalOpen] = useState(false);
	const open = isControlled ? controlledOpen : internalOpen;
	const setOpen = useCallback(
		(v: boolean) => {
			if (isControlled) onOpenChange?.(v);
			else setInternalOpen(v);
		},
		[isControlled, onOpenChange],
	);
	const [search, setSearch] = useState("");
	const sentinelRef = useRef<HTMLDivElement | null>(null);

	const navigate = useNavigate();
	const collections = useCollections();
	const { machineId } = useLocalHostService();
	const { submit } = useWorkspaceCreates();
	const { data: sidebarGroups = [] } =
		electronTrpc.workspaces.getAllGrouped.useQuery();

	// Gate the branch query on `open` so the sidebar doesn't fetch branches for
	// every project on mount; passing `null` projectId disables the hook's query.
	const {
		branches,
		defaultBranch,
		isLoading,
		isError,
		isFetchingNextPage,
		hasNextPage,
		fetchNextPage,
	} = useBranchContext(open ? projectId : null, null, search, "all");

	const branchMetadataByName = useMemo(() => {
		const map = new Map<string, BranchBrowserMetadata>();
		const group = sidebarGroups.find((item) => item.project.id === projectId);
		if (!group) return map;

		const projectWorkspaces = [
			...group.workspaces,
			...group.sections.flatMap((section) => section.workspaces),
		];

		for (const workspace of projectWorkspaces) {
			const localState = collections.v2WorkspaceLocalState.get(workspace.id);
			const color = localState?.sidebarState.color ?? null;
			const labels = localState?.sidebarState.labels ?? [];
			if (!color && labels.length === 0) continue;
			map.set(workspace.branch, {
				color,
				labels,
				workspaceId: workspace.id,
				workspaceName: workspace.name,
			});
		}

		return map;
	}, [collections, projectId, sidebarGroups]);

	const sortedBranches = useMemo(
		() => sortBranchRows(branches, defaultBranch, branchMetadataByName),
		[branchMetadataByName, branches, defaultBranch],
	);

	useEffect(() => {
		if (!open || !hasNextPage || isFetchingNextPage) return;
		const el = sentinelRef.current;
		if (!el) return;
		let inFlight = false;
		const observer = new IntersectionObserver(
			(entries) => {
				if (inFlight) return;
				if (entries.some((e) => e.isIntersecting)) {
					inFlight = true;
					void fetchNextPage();
				}
			},
			{ rootMargin: "64px" },
		);
		observer.observe(el);
		return () => observer.disconnect();
	}, [open, hasNextPage, isFetchingNextPage, fetchNextPage]);

	// Mirrors useBranchPickerController.onOpenWorkspace: server's
	// workspaces.create resolves open-tracked, adopt-foreign-worktree, and
	// fresh-create; navigate to the optimistic id and reconcile on completion.
	const onOpenBranch = useCallback(
		(branchName: string, worktreePath: string | null) => {
			if (!machineId) {
				toast.error("Нет активного host-сервиса");
				return;
			}
			const snapshotId = crypto.randomUUID();
			setOpen(false);
			const { workspaceId, completed } = submit({
				hostId: machineId,
				snapshot: {
					id: snapshotId,
					projectId,
					name: branchName,
					branch: branchName,
					...(worktreePath ? { worktreePath } : {}),
				},
			});
			void navigate({
				to: "/v2-workspace/$workspaceId",
				params: { workspaceId },
			});
			void completed.then((outcome) => {
				if (outcome.ok && outcome.workspaceId !== workspaceId) {
					void navigate({
						to: "/v2-workspace/$workspaceId",
						params: { workspaceId: outcome.workspaceId },
						replace: true,
					});
				}
			});
		},
		[machineId, submit, projectId, navigate, setOpen],
	);

	return (
		<Popover
			open={open}
			onOpenChange={(v) => {
				setOpen(v);
				if (!v) setSearch("");
			}}
		>
			{isControlled ? (
				<PopoverTrigger
					aria-hidden
					tabIndex={-1}
					className="pointer-events-none absolute h-0 w-0 opacity-0"
				/>
			) : (
				<Tooltip delayDuration={500}>
					<TooltipTrigger asChild>
						<PopoverTrigger asChild>
							<button
								type="button"
								onClick={(e) => e.stopPropagation()}
								onContextMenu={(e) => e.stopPropagation()}
								className="p-1 rounded hover:bg-muted transition-colors shrink-0 ml-1"
							>
								<GoGitBranch className="size-3.5 text-muted-foreground" />
							</button>
						</PopoverTrigger>
					</TooltipTrigger>
					<TooltipContent side="bottom" sideOffset={4}>
						Ветки проекта
					</TooltipContent>
				</Tooltip>
			)}
			<PopoverContent
				className="w-[360px] p-0"
				align="start"
				onWheel={(event) => event.stopPropagation()}
			>
				{isError ? (
					<div className="px-3 py-4 text-xs text-destructive">
						Не удалось загрузить ветки
					</div>
				) : (
					<Command shouldFilter={false}>
						<CommandInput
							placeholder="Поиск веток..."
							value={search}
							onValueChange={setSearch}
						/>
						<CommandList className="max-h-[420px]">
							{!isLoading && branches.length === 0 && (
								<CommandEmpty>Ветки не найдены</CommandEmpty>
							)}
							{sortedBranches.map((branch) => {
								const isRemoteOnly = branch.isRemote && !branch.isLocal;
								const isWorktree = Boolean(branch.worktreePath);
								const metadata = branchMetadataByName.get(branch.name);
								const isPinnedByMetadata = hasBranchMetadata(metadata);
								return (
									<CommandItem
										key={branch.name}
										value={branch.name}
										onSelect={() =>
											onOpenBranch(branch.name, branch.worktreePath ?? null)
										}
										className="items-start gap-3 rounded-md px-2.5 py-2"
									>
										<div className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
											{metadata?.color ? (
												<span
													className="size-2.5 rounded-full border border-border"
													style={{ backgroundColor: metadata.color }}
												/>
											) : isWorktree ? (
												<LuFolderOpen className="size-4 text-primary/80" />
											) : isRemoteOnly ? (
												<GoGlobe className="size-4 text-muted-foreground/60" />
											) : (
												<GoGitBranch className="size-4 text-muted-foreground" />
											)}
										</div>
										<div className="flex min-w-0 flex-1 flex-col gap-0.5">
											<span className="truncate text-sm leading-snug">
												{branch.name}
											</span>
											<span className="flex flex-wrap items-center gap-1.5 text-[11px] text-muted-foreground">
												{branch.lastCommitDate > 0 && (
													<span>
														{formatRelativeTime(branch.lastCommitDate * 1000)}
													</span>
												)}
												{branch.name === defaultBranch && (
													<>
														<span aria-hidden>·</span>
														<span>основная</span>
													</>
												)}
												{isRemoteOnly && (
													<>
														<span aria-hidden>·</span>
														<span>remote</span>
													</>
												)}
												{isWorktree && (
													<>
														<span aria-hidden>·</span>
														<span className="text-primary/80">worktree</span>
													</>
												)}
												{isPinnedByMetadata && (
													<>
														<span aria-hidden>·</span>
														<span className="text-foreground/80">помечена</span>
													</>
												)}
											</span>
											{metadata?.labels && metadata.labels.length > 0 && (
												<span className="flex min-w-0 flex-wrap gap-1 pt-0.5">
													{metadata.labels.slice(0, 3).map((label) => (
														<span
															key={label}
															className="max-w-24 truncate rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground"
														>
															{label}
														</span>
													))}
													{metadata.labels.length > 3 && (
														<span className="rounded bg-muted px-1.5 py-0.5 text-[10px] leading-none text-muted-foreground">
															+{metadata.labels.length - 3}
														</span>
													)}
												</span>
											)}
										</div>
									</CommandItem>
								);
							})}
							{hasNextPage && (
								<div
									ref={sentinelRef}
									className="py-2 text-center text-[11px] text-muted-foreground/60"
								>
									{isFetchingNextPage ? "Загружаем ещё..." : ""}
								</div>
							)}
						</CommandList>
					</Command>
				)}
			</PopoverContent>
		</Popover>
	);
}
