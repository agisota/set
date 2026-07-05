export interface BranchBrowserRow {
	name: string;
	isLocal: boolean;
	isRemote: boolean;
	worktreePath?: string | null;
	lastCommitDate: number;
}

export interface BranchBrowserMetadata {
	color: string | null;
	labels: string[];
	workspaceId?: string | null;
	workspaceName?: string | null;
}

export function hasBranchMetadata(
	metadata: BranchBrowserMetadata | null | undefined,
): boolean {
	return Boolean(metadata?.color || metadata?.labels.length);
}

function getBranchPriority<Branch extends BranchBrowserRow>(
	branch: Branch,
	defaultBranch: string | null,
	metadataByBranch: Map<string, BranchBrowserMetadata>,
): number {
	if (hasBranchMetadata(metadataByBranch.get(branch.name))) return 0;
	if (branch.worktreePath) return 1;
	if (branch.name === defaultBranch) return 2;
	if (branch.isLocal) return 3;
	return 4;
}

export function sortBranchRows<Branch extends BranchBrowserRow>(
	branches: readonly Branch[],
	defaultBranch: string | null,
	metadataByBranch: Map<string, BranchBrowserMetadata>,
): Branch[] {
	return [...branches].sort((left, right) => {
		const priorityDelta =
			getBranchPriority(left, defaultBranch, metadataByBranch) -
			getBranchPriority(right, defaultBranch, metadataByBranch);
		if (priorityDelta !== 0) return priorityDelta;

		const dateDelta = right.lastCommitDate - left.lastCommitDate;
		if (dateDelta !== 0) return dateDelta;

		return left.name.localeCompare(right.name);
	});
}
