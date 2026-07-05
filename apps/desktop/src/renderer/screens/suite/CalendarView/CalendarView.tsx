import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogHeader,
	DialogTitle,
} from "@rox/ui/dialog";
import { Skeleton } from "@rox/ui/skeleton";
import { toast } from "@rox/ui/sonner";
import { cn } from "@rox/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	CalendarDays,
	ChevronLeft,
	ChevronRight,
	Clock,
	Download,
	MapPin,
	Plus,
	Upload,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { authClient } from "renderer/lib/auth-client";
import { logger } from "renderer/lib/logger";
import { SuiteQueryError } from "../components/SuiteQueryError";
import { SuiteScreen } from "../components/SuiteScreen";
import { addMonths, dayKey, monthRange } from "../utils/monthRange";
import { SubscribeFeedDialog } from "./components/SubscribeFeedDialog";

type RsvpStatus = "needs_action" | "accepted" | "declined" | "tentative";

const RSVP_OPTIONS: { status: RsvpStatus; label: string }[] = [
	{ status: "accepted", label: "Принять" },
	{ status: "tentative", label: "Возможно" },
	{ status: "declined", label: "Отклонить" },
];

/** Reminder presets → minutes BEFORE the occurrence start (C6). */
const REMINDER_PRESETS: { label: string; offsetMinutes: number }[] = [
	{ label: "В момент", offsetMinutes: 0 },
	{ label: "За 10 мин", offsetMinutes: 10 },
	{ label: "За 1 час", offsetMinutes: 60 },
	{ label: "За 1 день", offsetMinutes: 1440 },
];

function reminderOffsetLabel(offsetMinutes: number | null): string {
	const offset = offsetMinutes ?? 0;
	return (
		REMINDER_PRESETS.find((p) => p.offsetMinutes === offset)?.label ??
		`За ${offset} мин`
	);
}

interface AgendaItem {
	key: string;
	eventId: string;
	/** RECURRENCE-ID (occ.start ISO) for "this event only" actions. */
	originalStart: string;
	start: Date;
	end: Date;
	/** Per-occurrence field overrides; absent = inherit the series value. */
	title?: string;
	description?: string;
	location?: string;
	allDay?: boolean;
}

interface CalendarDayCell {
	key: string;
	date: Date;
	isCurrentMonth: boolean;
	isToday: boolean;
}

function formatTime(date: Date): string {
	return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatDayHeading(date: Date): string {
	return date.toLocaleDateString([], {
		weekday: "long",
		day: "numeric",
		month: "long",
	});
}

function buildMonthGrid(anchor: Date): CalendarDayCell[] {
	const firstOfMonth = new Date(anchor.getFullYear(), anchor.getMonth(), 1);
	const gridStart = new Date(firstOfMonth);
	const mondayOffset = (firstOfMonth.getDay() + 6) % 7;
	gridStart.setDate(firstOfMonth.getDate() - mondayOffset);

	const todayKey = dayKey(new Date());
	const cells: CalendarDayCell[] = [];
	for (let index = 0; index < 42; index += 1) {
		const date = new Date(gridStart);
		date.setDate(gridStart.getDate() + index);
		cells.push({
			key: dayKey(date),
			date,
			isCurrentMonth: date.getMonth() === anchor.getMonth(),
			isToday: dayKey(date) === todayKey,
		});
	}
	return cells;
}

/**
 * Calendar agenda (Suite P0). Reads `calendar.listOccurrences` for the visible
 * month, groups expanded occurrences by local day, and opens an event detail
 * dialog with RSVP actions (`calendar.rsvp`). Month navigation re-queries the
 * range. Recurrence expansion + org scoping happen server-side; the view never
 * materialises recurrences itself.
 *
 * Cache-first (AGENTS.md rule 9): occurrences already in cache render while a
 * month re-fetch is in flight.
 */
export function CalendarView() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { data: session } = authClient.useSession();
	const currentUserId = session?.user?.id ?? null;

	const [anchor, setAnchor] = useState(() => new Date());
	// Selection carries the clicked instance's RECURRENCE-ID (originalStart) so a
	// recurring event can be cancelled "this event only"; null = nothing open.
	const [selected, setSelected] = useState<{
		eventId: string;
		originalStart: string;
	} | null>(null);

	// The public subscribe feed is owner-managed; load the calendar list to gate
	// the control on ownership and read the feed state.
	const calendarsQuery = useQuery(trpc.calendar.listCalendars.queryOptions());
	const firstCalendar = calendarsQuery.data?.[0] ?? null;
	const ownsFirstCalendar =
		firstCalendar !== null &&
		currentUserId !== null &&
		firstCalendar.ownerUserId === currentUserId;

	const range = useMemo(() => monthRange(anchor), [anchor]);
	const queryInput = useMemo(
		() => ({ rangeStart: range.start, rangeEnd: range.end }),
		[range],
	);

	const occQuery = useQuery(
		trpc.calendar.listOccurrences.queryOptions(queryInput),
	);

	const rsvp = useMutation(
		trpc.calendar.rsvp.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries({
					queryKey: trpc.calendar.listOccurrences.queryKey(queryInput),
				});
				toast.success("Ответ сохранён");
				setSelected(null);
			},
			onError: (error) => {
				logger.error("[CalendarView] rsvp failed", error);
				toast.error("Не удалось сохранить ответ");
			},
		}),
	);

	const cancelOccurrence = useMutation(
		trpc.calendar.cancelOccurrence.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries({
					queryKey: trpc.calendar.listOccurrences.queryKey(queryInput),
				});
				toast.success("Событие удалено (только это)");
				setSelected(null);
			},
			onError: (error) => {
				logger.error("[CalendarView] cancelOccurrence failed", error);
				toast.error("Не удалось удалить событие");
			},
		}),
	);

	const occurrences = occQuery.data?.occurrences ?? [];
	const events = occQuery.data?.events ?? [];
	const eventsById = useMemo(
		() => new Map(events.map((event) => [event.id, event])),
		[events],
	);

	const grouped = useMemo(() => {
		const byDay = new Map<string, AgendaItem[]>();
		for (const occ of occurrences) {
			const start = new Date(occ.start);
			const item: AgendaItem = {
				key: `${occ.eventId}-${occ.start}`,
				eventId: occ.eventId,
				originalStart: occ.originalStart ?? occ.start,
				start,
				end: new Date(occ.end),
				// Per-occurrence field overrides surfaced by listOccurrences; absent =
				// inherit the series value.
				title: occ.title,
				description: occ.description,
				location: occ.location,
				allDay: occ.allDay,
			};
			const key = dayKey(start);
			const list = byDay.get(key);
			if (list) list.push(item);
			else byDay.set(key, [item]);
		}
		return [...byDay.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
	}, [occurrences]);
	const groupedByDay = useMemo(() => new Map(grouped), [grouped]);
	const monthCells = useMemo(() => buildMonthGrid(anchor), [anchor]);

	const selectedEvent = selected
		? (eventsById.get(selected.eventId) ?? null)
		: null;
	// The clicked occurrence's per-occurrence overrides, so the detail dialog
	// reflects a "this event only" edit rather than the series defaults.
	const selectedOcc = selected
		? (occurrences.find(
				(o) =>
					o.eventId === selected.eventId &&
					(o.originalStart ?? o.start) === selected.originalStart,
			) ?? null)
		: null;
	const monthLabel = anchor.toLocaleDateString([], {
		month: "long",
		year: "numeric",
	});
	const isEmpty = occurrences.length === 0;

	return (
		<SuiteScreen
			title="Календарь"
			description="Повестка событий по месяцам, RSVP"
			icon={CalendarDays}
			actions={
				<div className="flex flex-wrap items-center justify-end gap-1">
					<Button
						size="sm"
						variant="outline"
						disabled
						title="Создание событий будет доступно после подключения календарного редактора."
					>
						<Plus className="size-4" /> Событие
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled
						title="Импорт .ics будет доступен после подключения безопасного парсера календарей."
					>
						<Upload className="size-4" /> Импорт .ics
					</Button>
					<Button
						size="sm"
						variant="outline"
						disabled
						title="Экспорт .ics будет доступен после подключения экспортера календарей."
					>
						<Download className="size-4" /> Экспорт .ics
					</Button>
					{ownsFirstCalendar && firstCalendar && (
						<SubscribeFeedDialog
							calendarId={firstCalendar.id}
							feedEnabled={firstCalendar.feedEnabled}
							feedBusyOnly={firstCalendar.feedBusyOnly}
						/>
					)}
					<Button
						size="icon"
						variant="ghost"
						aria-label="Предыдущий месяц"
						onClick={() => setAnchor((d) => addMonths(d, -1))}
					>
						<ChevronLeft className="size-4" />
					</Button>
					<span className="min-w-36 text-center font-medium text-sm capitalize">
						{monthLabel}
					</span>
					<Button
						size="icon"
						variant="ghost"
						aria-label="Следующий месяц"
						onClick={() => setAnchor((d) => addMonths(d, 1))}
					>
						<ChevronRight className="size-4" />
					</Button>
				</div>
			}
		>
			{occQuery.data?.truncated && (
				<div className="mb-4 rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-amber-700 text-xs dark:text-amber-400">
					Часть повторяющихся событий не уместилась в окно — список может быть
					неполным.
				</div>
			)}

			{occQuery.isError && (
				<SuiteQueryError
					message={occQuery.error.message}
					onRetry={() => occQuery.refetch()}
				/>
			)}

			{isEmpty && occQuery.isLoading && (
				<div className="space-y-4">
					{[0, 1, 2].map((i) => (
						<div key={i} className="space-y-2">
							<Skeleton className="h-4 w-40" />
							<Skeleton className="h-14 w-full" />
						</div>
					))}
				</div>
			)}

			{occQuery.isSuccess && (
				<div className="grid min-h-0 gap-4 xl:grid-cols-[minmax(0,1.5fr)_minmax(20rem,0.8fr)]">
					<section className="min-w-0 rounded-lg border border-border bg-card/80">
						<div className="grid grid-cols-7 border-border border-b text-center text-muted-foreground text-xs">
							{["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"].map((day) => (
								<div key={day} className="px-2 py-2">
									{day}
								</div>
							))}
						</div>
						<div className="grid grid-cols-7">
							{monthCells.map((cell) => {
								const items = groupedByDay.get(cell.key) ?? [];
								return (
									<div
										key={cell.key}
										className={cn(
											"min-h-28 border-border border-r border-b p-2 last:border-r-0",
											!cell.isCurrentMonth &&
												"bg-muted/20 text-muted-foreground",
											cell.isToday && "bg-primary/5",
										)}
									>
										<div className="mb-1 flex items-center justify-between gap-2">
											<span
												className={cn(
													"font-medium text-xs tabular-nums",
													cell.isToday &&
														"rounded-full bg-primary px-1.5 py-0.5 text-primary-foreground",
												)}
											>
												{cell.date.getDate()}
											</span>
											{items.length > 2 && (
												<span className="text-muted-foreground text-[10px]">
													+{items.length - 2}
												</span>
											)}
										</div>
										<div className="space-y-1">
											{items.slice(0, 2).map((item) => {
												const event = eventsById.get(item.eventId);
												const allDay = item.allDay ?? event?.allDay;
												const title = item.title ?? event?.title ?? "Событие";
												return (
													<button
														key={item.key}
														type="button"
														onClick={() =>
															setSelected({
																eventId: item.eventId,
																originalStart: item.originalStart,
															})
														}
														className="block w-full truncate rounded border border-border bg-background/80 px-1.5 py-1 text-left text-[11px] transition-colors hover:border-primary/50"
														title={title}
													>
														<span className="text-muted-foreground tabular-nums">
															{allDay ? "" : `${formatTime(item.start)} `}
														</span>
														{title}
													</button>
												);
											})}
										</div>
									</div>
								);
							})}
						</div>
					</section>

					<section className="min-w-0 rounded-lg border border-border bg-card/80 p-4">
						<div className="mb-3 flex items-center justify-between gap-2">
							<div>
								<h2 className="font-medium text-sm">Повестка месяца</h2>
								<p className="text-muted-foreground text-xs">
									События раскрываются из календарной сетки и списка.
								</p>
							</div>
							<Badge variant="outline">{occurrences.length}</Badge>
						</div>

						{isEmpty ? (
							<div className="flex min-h-52 flex-col items-center justify-center rounded-lg border border-border border-dashed px-4 text-center">
								<CalendarDays className="mb-3 size-8 text-muted-foreground" />
								<span className="text-foreground text-sm">Событий нет</span>
								<span className="mt-1 max-w-sm text-muted-foreground text-xs">
									В этом месяце запланированных событий не найдено.
								</span>
							</div>
						) : (
							<div className="max-h-[calc(100vh-320px)] space-y-6 overflow-y-auto pr-1">
								{grouped.map(([key, items]) => (
									<div key={key}>
										<h3 className="mb-2 font-medium text-muted-foreground text-sm capitalize">
											{formatDayHeading(items[0]?.start ?? new Date())}
										</h3>
										<div className="space-y-1.5">
											{items.map((item) => {
												const event = eventsById.get(item.eventId);
												const allDay = item.allDay ?? event?.allDay;
												const title = item.title ?? event?.title ?? "Событие";
												const location = item.location ?? event?.location;
												return (
													<button
														key={item.key}
														type="button"
														onClick={() =>
															setSelected({
																eventId: item.eventId,
																originalStart: item.originalStart,
															})
														}
														className="flex w-full items-center gap-3 rounded-lg border border-border bg-background/80 px-3 py-2.5 text-left transition-colors hover:border-primary/50"
													>
														<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
															{allDay ? "весь день" : formatTime(item.start)}
														</span>
														<span className="min-w-0 flex-1 truncate text-sm">
															{title}
														</span>
														{location && (
															<span className="hidden shrink-0 items-center gap-1 text-muted-foreground text-xs sm:flex">
																<MapPin className="size-3" />
																<span className="max-w-32 truncate">
																	{location}
																</span>
															</span>
														)}
													</button>
												);
											})}
										</div>
									</div>
								))}
							</div>
						)}
					</section>
				</div>
			)}

			{/* Event detail + RSVP dialog */}
			<Dialog
				open={selectedEvent !== null}
				onOpenChange={(open) => {
					if (!open) setSelected(null);
				}}
			>
				<DialogContent>
					{selectedEvent &&
						(() => {
							// Per-occurrence override wins over the series value; the
							// occurrence's start/end already reflect a moved-time override.
							const detailTitle = selectedOcc?.title ?? selectedEvent.title;
							const detailDescription =
								selectedOcc?.description ?? selectedEvent.description;
							const detailLocation =
								selectedOcc?.location ?? selectedEvent.location;
							const detailAllDay = selectedOcc?.allDay ?? selectedEvent.allDay;
							const detailStart = selectedOcc?.start ?? selectedEvent.dtstart;
							const detailEnd = selectedOcc?.end ?? selectedEvent.dtend;
							return (
								<>
									<DialogHeader>
										<DialogTitle className="cursor-text select-text">
											{detailTitle}
										</DialogTitle>
										{detailDescription && (
											<DialogDescription className="cursor-text select-text whitespace-pre-wrap">
												{detailDescription}
											</DialogDescription>
										)}
									</DialogHeader>
									<dl className="space-y-2 text-sm">
										<div className="flex items-center gap-2 text-muted-foreground">
											<Clock className="size-4 shrink-0" />
											<span>
												{new Date(detailStart).toLocaleString([], {
													dateStyle: "medium",
													timeStyle: detailAllDay ? undefined : "short",
												})}
												{" — "}
												{new Date(detailEnd).toLocaleString([], {
													dateStyle: "medium",
													timeStyle: detailAllDay ? undefined : "short",
												})}
											</span>
										</div>
										{detailLocation && (
											<div className="flex items-center gap-2 text-muted-foreground">
												<MapPin className="size-4 shrink-0" />
												<span className="cursor-text select-text">
													{detailLocation}
												</span>
											</div>
										)}
										{selectedEvent.rrule && (
											<Badge variant="outline" className="text-[10px]">
												повторяющееся
											</Badge>
										)}
									</dl>
									<div className="flex flex-wrap gap-2 pt-2">
										{RSVP_OPTIONS.map((option) => (
											<Button
												key={option.status}
												size="sm"
												variant={
													option.status === "accepted" ? "default" : "outline"
												}
												disabled={rsvp.isPending}
												onClick={() =>
													rsvp.mutate({
														eventId: selectedEvent.id,
														status: option.status,
													})
												}
												className={cn(
													option.status === "declined" &&
														"text-destructive hover:text-destructive",
												)}
											>
												{option.label}
											</Button>
										))}
									</div>

									{/* Recurring: cancel just this instance ("this event only"). */}
									{selectedEvent.rrule && selected && (
										<div className="border-t pt-3">
											<Button
												size="sm"
												variant="outline"
												disabled={cancelOccurrence.isPending}
												className="text-destructive hover:text-destructive"
												onClick={() =>
													cancelOccurrence.mutate({
														eventId: selected.eventId,
														originalStart: new Date(selected.originalStart),
													})
												}
											>
												Удалить только это событие
											</Button>
										</div>
									)}

									<EventReminders eventId={selectedEvent.id} />
								</>
							);
						})()}
				</DialogContent>
			</Dialog>
		</SuiteScreen>
	);
}

interface EventRemindersProps {
	eventId: string;
}

/**
 * C6 reminders surface for the desktop event detail (read + RSVP screen has no
 * full editor). Shows the caller's own reminders for the event with add-preset +
 * delete via `calendar.createReminder`/`deleteReminder`. Cache-first (AGENTS.md
 * rule 9): persisted rows render immediately; loading only gates the empty
 * branch.
 */
function EventReminders({ eventId }: EventRemindersProps) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const remindersQuery = useQuery(
		trpc.calendar.listReminders.queryOptions({ eventId }),
	);
	const reminders = remindersQuery.data ?? [];

	const refresh = async () => {
		await queryClient.invalidateQueries({
			queryKey: trpc.calendar.listReminders.queryKey({ eventId }),
		});
	};

	const createReminder = useMutation(
		trpc.calendar.createReminder.mutationOptions({
			onSuccess: async () => {
				await refresh();
				toast.success("Напоминание добавлено");
			},
			onError: (error) => {
				logger.error("[CalendarView] createReminder failed", error);
				toast.error("Не удалось добавить напоминание");
			},
		}),
	);

	const deleteReminder = useMutation(
		trpc.calendar.deleteReminder.mutationOptions({
			onSuccess: async () => {
				await refresh();
				toast.success("Напоминание удалено");
			},
			onError: (error) => {
				logger.error("[CalendarView] deleteReminder failed", error);
				toast.error("Не удалось удалить напоминание");
			},
		}),
	);

	return (
		<div className="space-y-2 border-t pt-3">
			<span className="font-medium text-muted-foreground text-xs">
				Напоминания
			</span>

			{reminders.length > 0 ? (
				<ul className="space-y-1">
					{reminders.map((reminder) => (
						<li
							key={reminder.id}
							className="flex items-center justify-between gap-2 rounded-md border px-2 py-1 text-sm"
						>
							<span className="cursor-text select-text truncate">
								{reminderOffsetLabel(reminder.offsetMinutes)}
								{reminder.channel === "email" ? " · Email" : " · В приложении"}
							</span>
							<Button
								size="sm"
								variant="ghost"
								className="h-7 px-2 text-destructive text-xs hover:text-destructive"
								disabled={deleteReminder.isPending}
								onClick={() =>
									deleteReminder.mutate({ reminderId: reminder.id })
								}
							>
								Удалить
							</Button>
						</li>
					))}
				</ul>
			) : remindersQuery.isLoading ? (
				<span className="text-muted-foreground text-xs">Загрузка…</span>
			) : (
				<span className="text-muted-foreground text-xs">
					Напоминаний пока нет.
				</span>
			)}

			<div className="flex flex-wrap gap-1.5 pt-1">
				{REMINDER_PRESETS.map((preset) => (
					<Button
						key={preset.offsetMinutes}
						size="sm"
						variant="outline"
						className="h-7 px-2 text-xs"
						disabled={createReminder.isPending}
						onClick={() =>
							createReminder.mutate({
								eventId,
								channel: "in_app",
								trigger: "relative",
								offsetMinutes: preset.offsetMinutes,
							})
						}
					>
						+ {preset.label}
					</Button>
				))}
			</div>
		</div>
	);
}
