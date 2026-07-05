import type { SelectMemoryItem } from "@rox/db/schema";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { authClient } from "renderer/lib/auth-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { ImportPanel } from "./components/ImportPanel";
import { MemoryGroup } from "./components/MemoryGroup";
import { MemorySuggestions } from "./components/MemorySuggestions";
import { MEMORY_GROUPS } from "./groups";

export function MemoryView() {
	const collections = useCollections();
	const { data: session } = authClient.useSession();
	const userId = session?.user?.id ?? "";

	const { data: items = [], isReady } = useLiveQuery(
		(q) =>
			q
				.from({ memoryItems: collections.memoryItems })
				.where(({ memoryItems }) => eq(memoryItems.createdBy, userId)),
		[collections, userId],
	);

	// Approved items grouped by category. Suggested items surface separately as
	// the Approve/Decline banner (phase 3); dismissed items are hidden.
	const approvedByCategory = useMemo(() => {
		const map = new Map<string, SelectMemoryItem[]>();
		for (const item of items) {
			if (item.status !== "approved") continue;
			const arr = map.get(item.category) ?? [];
			arr.push(item);
			map.set(item.category, arr);
		}
		return map;
	}, [items]);

	// Agent-suggested items pending review, newest first.
	const suggested = useMemo(
		() =>
			items
				.filter((item) => item.status === "suggested")
				.sort((a, b) =>
					a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0,
				),
		[items],
	);

	return (
		<div className="h-full min-w-0 overflow-y-auto bg-background/85">
			<div className="w-full px-6 py-8">
				<header className="mb-8">
					<h1 className="font-semibold text-2xl text-foreground">Память</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						Что Rox помнит о тебе и твоих проектах. Добавляй факты и правила —
						агент учитывает их в работе.
					</p>
				</header>

				<ImportPanel />

				<MemorySuggestions items={suggested} />

				<div className="grid gap-5 xl:grid-cols-2">
					{MEMORY_GROUPS.map((group) => (
						<MemoryGroup
							key={group.category}
							category={group.category}
							label={group.label}
							hint={group.hint}
							items={approvedByCategory.get(group.category) ?? []}
							isReady={isReady}
						/>
					))}
				</div>
			</div>
		</div>
	);
}
