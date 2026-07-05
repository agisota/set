import type { SelectJournalEvent } from "@rox/db/schema";

interface JournalFeedProps {
	events: SelectJournalEvent[];
}

const KIND_LABELS: Record<string, string> = {
	ambient_nudge: "Подсказка",
	automation_run: "Автоматизация",
};

const STATUS_DOT: Record<string, string> = {
	ambient: "bg-sky-500",
	conflict: "bg-amber-500",
	dispatched: "bg-emerald-500",
	dispatch_failed: "bg-red-500",
	dispatching: "bg-sky-500",
	skipped_offline: "bg-muted-foreground",
};

function eventStatus(event: SelectJournalEvent): string | undefined {
	const payload = event.payload as {
		status?: unknown;
		source?: unknown;
	} | null;
	if (typeof payload?.status === "string") return payload.status;
	if (typeof payload?.source === "string") return payload.source;
	return undefined;
}

function statusDotClass(status: string | undefined): string {
	return (status && STATUS_DOT[status]) ?? "bg-muted-foreground";
}

function formatEventTime(value: Date | string): string {
	return new Intl.DateTimeFormat("ru-RU", {
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
		month: "short",
	}).format(typeof value === "string" ? new Date(value) : value);
}

export function JournalFeed({ events }: JournalFeedProps) {
	if (events.length === 0) {
		return (
			<div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed py-20 text-center">
				<span className="text-foreground text-sm">Лента пока пуста</span>
				<span className="mt-1 max-w-sm text-muted-foreground text-xs">
					События появятся здесь после запусков автоматизаций и фоновых
					подсказок.
				</span>
			</div>
		);
	}

	return (
		<div className="space-y-2">
			{events.map((event) => {
				const status = eventStatus(event);
				return (
					<div
						key={event.id}
						className="flex items-start gap-3 rounded-md border border-border p-3"
					>
						<span
							className={`mt-1.5 size-2 shrink-0 rounded-full ${statusDotClass(status)}`}
						/>
						<div className="min-w-0 flex-1">
							<div className="flex items-baseline justify-between gap-3">
								<span className="truncate font-medium text-foreground text-sm">
									{event.title}
								</span>
								<time className="shrink-0 font-mono text-[11px] text-muted-foreground">
									{formatEventTime(event.createdAt)}
								</time>
							</div>
							{event.summary ? (
								<p className="mt-0.5 select-text text-muted-foreground text-xs">
									{event.summary}
								</p>
							) : null}
						</div>
						<span className="shrink-0 rounded bg-muted px-1.5 py-0.5 font-medium text-[10px] text-muted-foreground uppercase tracking-wider">
							{KIND_LABELS[event.kind] ?? event.kind}
						</span>
					</div>
				);
			})}
		</div>
	);
}
