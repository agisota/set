import { describe, expect, it } from "bun:test";
import {
	type BranchBrowserMetadata,
	type BranchBrowserRow,
	hasBranchMetadata,
	sortBranchRows,
} from "./branch-browser.utils";

function branch(
	name: string,
	overrides: Partial<BranchBrowserRow> = {},
): BranchBrowserRow {
	return {
		name,
		isLocal: true,
		isRemote: false,
		worktreePath: null,
		lastCommitDate: 10,
		...overrides,
	};
}

describe("sortBranchRows", () => {
	it("prioritizes branches with labels or color above worktrees and default branch", () => {
		const metadata = new Map<string, BranchBrowserMetadata>([
			["feature/labelled", { color: null, labels: ["release"] }],
			["feature/colored", { color: "#ff00aa", labels: [] }],
		]);

		const sorted = sortBranchRows(
			[
				branch("main", { lastCommitDate: 50 }),
				branch("feature/worktree", {
					worktreePath: "/tmp/worktree",
					lastCommitDate: 40,
				}),
				branch("feature/labelled", { lastCommitDate: 1 }),
				branch("feature/colored", { lastCommitDate: 2 }),
			],
			"main",
			metadata,
		);

		expect(sorted.map((item) => item.name)).toEqual([
			"feature/colored",
			"feature/labelled",
			"feature/worktree",
			"main",
		]);
	});
});

describe("hasBranchMetadata", () => {
	it("treats empty metadata as not prioritized", () => {
		expect(hasBranchMetadata({ color: null, labels: [] })).toBe(false);
		expect(hasBranchMetadata({ color: "#11aa44", labels: [] })).toBe(true);
		expect(hasBranchMetadata({ color: null, labels: ["ux"] })).toBe(true);
	});
});
