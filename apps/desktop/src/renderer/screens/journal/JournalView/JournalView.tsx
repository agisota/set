import type { SelectJournalEntry, SelectJournalEvent } from "@rox/db/schema";
import { Skeleton } from "@rox/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@rox/ui/tabs";
import { eq } from "@tanstack/db";
import { useLiveQuery } from "@tanstack/react-db";
import { useMemo } from "react";
import { authClient } from "renderer/lib/auth-client";
import { useCollections } from "renderer/routes/_authenticated/providers/CollectionsProvider";
import { JournalDay } from "./components/JournalDay";
import { JournalFeed } from "./components/JournalFeed";

export function JournalView() {
	const collections = useCollections();
	const { data: session } = authClient.useSession();
	const userId = session?.user?.id ?? "";

	// Lane 1 — once-daily reflection (journal_entries).
	const { data: entries = [], isReady: entriesReady } = useLiveQuery(
		(q) =>
			q
				.from({ journalEntries: collections.journalEntries })
				.where(({ journalEntries }) => eq(journalEntries.createdBy, userId)),
		[collections, userId],
	);

	// Lane 2 — continuous event stream (journal_events).
	const { data: events = [], isReady: eventsReady } = useLiveQuery(
		(q) =>
			q
				.from({ journalEvents: collections.journalEvents })
				.where(({ journalEvents }) => eq(journalEvents.createdBy, userId)),
		[collections, userId],
	);

	// Newest day first. Sort client-side so we never depend on collection order.
	const sortedEntries = useMemo(
		() =>
			[...entries].sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0)),
		[entries],
	);

	// Newest event first.
	const sortedEvents = useMemo(
		() =>
			[...events].sort((a, b) => {
				const aTime = new Date(a.createdAt).getTime();
				const bTime = new Date(b.createdAt).getTime();
				return bTime - aTime;
			}),
		[events],
	);

	return (
		<div className="h-full min-w-0 overflow-y-auto bg-background/85">
			<div className="w-full px-6 py-8">
				<header className="mb-6">
					<h1 className="font-semibold text-2xl text-foreground">Журнал</h1>
					<p className="mt-1 text-muted-foreground text-sm">
						Ежедневная рефлексия и непрерывная лента событий
					</p>
				</header>

				<Tabs defaultValue="reflection" className="w-full">
					<TabsList className="mb-6">
						<TabsTrigger value="reflection">Рефлексия</TabsTrigger>
						<TabsTrigger value="feed">Лента</TabsTrigger>
					</TabsList>

					<TabsContent value="reflection">
						<ReflectionLane entries={sortedEntries} isReady={entriesReady} />
					</TabsContent>

					<TabsContent value="feed">
						<FeedLane events={sortedEvents} isReady={eventsReady} />
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}

interface ReflectionLaneProps {
	entries: SelectJournalEntry[];
	isReady: boolean;
}

function ReflectionLane({ entries, isReady }: ReflectionLaneProps) {
	// Cache-first: render existing rows immediately; show the skeleton only when
	// there is genuinely no data AND the collection isn't ready yet.
	if (entries.length === 0 && !isReady) {
		return <ReflectionSkeleton />;
	}

	if (entries.length === 0) {
		return <ReflectionEmpty />;
	}

	return (
		<div className="space-y-12">
			{entries.map((entry) => (
				<JournalDay key={entry.id} entry={entry} />
			))}
		</div>
	);
}

interface FeedLaneProps {
	events: SelectJournalEvent[];
	isReady: boolean;
}

function FeedLane({ events, isReady }: FeedLaneProps) {
	// Cache-first: render existing rows immediately; skeleton only when there is
	// genuinely no data AND the collection isn't ready yet.
	if (events.length === 0 && !isReady) {
		return <FeedSkeleton />;
	}

	return <JournalFeed events={events} />;
}

function ReflectionSkeleton() {
	return (
		<div className="space-y-12">
			{[0, 1, 2].map((i) => (
				<div key={i} className="space-y-3">
					<Skeleton className="h-4 w-28" />
					<Skeleton className="h-20 w-full" />
					<Skeleton className="h-16 w-3/4" />
				</div>
			))}
		</div>
	);
}

function FeedSkeleton() {
	return (
		<div className="space-y-2">
			{[0, 1, 2, 3, 4].map((i) => (
				<div
					key={i}
					className="flex items-center gap-3 rounded-md border border-border p-3"
				>
					<Skeleton className="size-2 rounded-full" />
					<Skeleton className="h-4 flex-1" />
					<Skeleton className="h-3 w-16" />
				</div>
			))}
		</div>
	);
}

function ReflectionEmpty() {
	return (
		<div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed py-20 text-center">
			<span className="text-foreground text-sm">Журнал пока пуст</span>
			<span className="mt-1 max-w-sm text-muted-foreground text-xs">
				Записи появляются автоматически: каждый день Rox R1 разбирает твои
				сессии и собирает рефлексию, выводы и советы.
			</span>
		</div>
	);
}
