import { authClient } from "@rox/auth/client";
import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { Skeleton } from "@rox/ui/skeleton";
import { toast } from "@rox/ui/sonner";
import { Tabs, TabsList, TabsTrigger } from "@rox/ui/tabs";
import { Textarea } from "@rox/ui/textarea";
import { cn } from "@rox/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	Inbox,
	Mail,
	MessagesSquare,
	Pencil,
	Send,
	Trash2,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { logger } from "renderer/lib/logger";
import { SuiteQueryError } from "../components/SuiteQueryError";
import { SuiteScreen } from "../components/SuiteScreen";
import { EmailView } from "../EmailView";
import { ThreadPresence } from "./components/ThreadPresence";
import { useCommsStream } from "./useCommsStream";
import { formatThreadTitle } from "./utils/formatThreadTitle";

/**
 * Idle window after the last keystroke before typing presence is auto-cleared
 * (matches the web inbox composer's `TYPING_IDLE_MS`).
 */
const TYPING_IDLE_MS = 2500;

type InboxTransport = "chat" | "mail";

function formatTime(value: Date | string | null | undefined): string {
	if (!value) return "";
	const date = value instanceof Date ? value : new Date(value);
	if (Number.isNaN(date.getTime())) return "";
	return date.toLocaleString([], {
		day: "2-digit",
		month: "short",
		hour: "2-digit",
		minute: "2-digit",
	});
}

/**
 * The chat (in-app comms) tab: a split-pane mirror of the web inbox over
 * `comms.*`. Left = the org's threads the caller participates in
 * (`comms.listThreads`); right = the selected thread's messages + a composer
 * (`comms.getThread` + `comms.sendMessage`).
 *
 * Cache-first (AGENTS.md #9): persisted threads/messages render immediately; the
 * skeleton only shows on the empty first load, and the empty state only after a
 * query resolves with zero rows.
 *
 * Selection is lifted to {@link InboxView} so the shared live SSE hook can scope
 * an open-thread `comms.getThread` invalidation to the thread actually on screen.
 */
function ChatTab({
	activeThreadId,
	setActiveThreadId,
}: {
	activeThreadId: string | null;
	setActiveThreadId: (id: string | null) => void;
}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const session = authClient.useSession();
	const currentUserId = session.data?.user?.id;

	const [body, setBody] = useState("");

	// Typing presence: `ThreadPresence` hands us a `setTyping` once its room is
	// live (a no-op when the presence layer is inert), which we drive from the
	// composer — throttled so the LiveBlocks indicator is not spammed. Mirrors
	// the web inbox (`ThreadView` + `Composer`) without sharing app-local code.
	const setTypingRef = useRef<(typing: boolean) => void>(() => {});
	const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isTypingRef = useRef(false);

	const handleTypingControl = useCallback(
		(setter: (typing: boolean) => void) => {
			setTypingRef.current = setter;
		},
		[],
	);

	const stopTyping = useCallback(() => {
		if (typingTimer.current) clearTimeout(typingTimer.current);
		if (isTypingRef.current) {
			isTypingRef.current = false;
			setTypingRef.current(false);
		}
	}, []);

	const handleComposerChange = useCallback(
		(value: string) => {
			setBody(value);
			if (!isTypingRef.current && value.length > 0) {
				isTypingRef.current = true;
				setTypingRef.current(true);
			}
			if (typingTimer.current) clearTimeout(typingTimer.current);
			typingTimer.current = setTimeout(stopTyping, TYPING_IDLE_MS);
		},
		[stopTyping],
	);

	// Stop typing on thread switch / unmount.
	// biome-ignore lint/correctness/useExhaustiveDependencies: must also re-run when the active thread changes, not only on unmount.
	useEffect(() => stopTyping, [stopTyping, activeThreadId]);

	const threadsQuery = useQuery(
		trpc.comms.listThreads.queryOptions({ limit: 50 }),
	);
	const threads = threadsQuery.data ?? [];

	const threadQuery = useQuery({
		...trpc.comms.getThread.queryOptions({ threadId: activeThreadId ?? "" }),
		enabled: activeThreadId !== null,
	});
	const messages = threadQuery.data?.messages ?? [];
	const participants = threadQuery.data?.participants ?? [];
	const thread = threadQuery.data?.thread ?? null;

	// Recipients for an in-app reply: every other rox participant (the schema
	// requires at least one recipient even when appending to a thread).
	const recipientUserIds = participants
		.map((p) => p.userId)
		.filter((id): id is string => Boolean(id) && id !== currentUserId);

	const invalidateThreadAndList = async () => {
		await Promise.all([
			queryClient.invalidateQueries({
				queryKey: trpc.comms.getThread.queryKey({
					threadId: activeThreadId ?? "",
				}),
			}),
			queryClient.invalidateQueries({
				queryKey: trpc.comms.listThreads.queryKey({ limit: 50 }),
			}),
		]);
	};

	const send = useMutation(
		trpc.comms.sendMessage.mutationOptions({
			onSuccess: async () => {
				setBody("");
				stopTyping();
				await invalidateThreadAndList();
			},
			onError: (error) => {
				logger.error("[InboxView] sendMessage failed", error);
				toast.error("Не удалось отправить сообщение");
			},
		}),
	);

	// Edit/delete (T8/M): cache-first — invalidate getThread + listThreads so the
	// edited body / tombstone appears after the authoritative refetch (existing
	// rows stay rendered until then). Author-only is enforced server-side.
	const editMessage = useMutation(
		trpc.comms.editMessage.mutationOptions({
			onSuccess: () => invalidateThreadAndList(),
			onError: (error) => {
				logger.error("[InboxView] editMessage failed", error);
				toast.error("Не удалось изменить сообщение");
			},
		}),
	);
	const deleteMessage = useMutation(
		trpc.comms.deleteMessage.mutationOptions({
			onSuccess: () => invalidateThreadAndList(),
			onError: (error) => {
				logger.error("[InboxView] deleteMessage failed", error);
				toast.error("Не удалось удалить сообщение");
			},
		}),
	);

	const handleEditMessage = (id: string, currentBody: string) => {
		const next = window.prompt("Изменить сообщение", currentBody);
		if (next === null) return;
		const trimmed = next.trim();
		if (trimmed.length === 0 || trimmed === currentBody) return;
		editMessage.mutate({ messageId: id, body: trimmed });
	};
	const handleDeleteMessage = (id: string) => {
		if (!window.confirm("Удалить это сообщение?")) return;
		deleteMessage.mutate({ messageId: id });
	};

	// Auto-scroll to the newest message when the thread or count changes.
	const bottomRef = useRef<HTMLDivElement>(null);
	const messageCount = messages.length;
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll must re-run when a new message arrives or the thread switches, even though the body only touches a ref.
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ block: "end" });
	}, [messageCount, activeThreadId]);

	const canSend =
		body.trim().length > 0 && !send.isPending && recipientUserIds.length > 0;

	const handleSend = () => {
		if (!canSend || !activeThreadId) return;
		send.mutate({
			threadId: activeThreadId,
			recipients: recipientUserIds.map((userId) => ({
				kind: "userId" as const,
				userId,
			})),
			body: body.trim(),
		});
	};

	if (threadsQuery.isError) {
		return (
			<SuiteQueryError
				message={threadsQuery.error.message}
				onRetry={() => threadsQuery.refetch()}
			/>
		);
	}

	if (threads.length === 0 && threadsQuery.isLoading) {
		return (
			<div className="space-y-2">
				{[0, 1, 2, 3].map((i) => (
					<Skeleton key={i} className="h-14 w-full" />
				))}
			</div>
		);
	}

	if (threads.length === 0 && threadsQuery.isSuccess) {
		return (
			<div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed py-20 text-center">
				<Inbox className="mb-3 size-8 text-muted-foreground" />
				<span className="text-foreground text-sm">Переписок пока нет</span>
				<span className="mt-1 max-w-sm text-muted-foreground text-xs">
					Когда вы начнёте переписку, она появится здесь.
				</span>
			</div>
		);
	}

	return (
		<div className="flex h-[calc(100vh-260px)] min-h-96 min-w-0 gap-4">
			<div className="w-[clamp(20rem,28vw,26rem)] min-w-72 max-w-[45vw] resize-x overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-card/80">
				{threads.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setActiveThreadId(t.id)}
						className={cn(
							"flex w-full flex-col gap-0.5 border-border border-b px-3 py-2.5 text-left last:border-b-0 transition-colors hover:bg-accent/40",
							t.id === activeThreadId && "bg-accent",
						)}
					>
						<div className="flex w-full items-center gap-2">
							<span
								className={cn(
									"flex-1 truncate text-sm",
									t.unreadCount > 0 ? "font-semibold" : "font-medium",
								)}
							>
								{formatThreadTitle({ subject: t.subject, id: t.id })}
							</span>
							{t.unreadCount > 0 && (
								<Badge
									aria-label={`${t.unreadCount} непрочитанных`}
									className="h-5 min-w-5 shrink-0 justify-center rounded-full px-1.5 text-[10px] tabular-nums"
								>
									{t.unreadCount > 99 ? "99+" : t.unreadCount}
								</Badge>
							)}
						</div>
						<span className="text-[10px] text-muted-foreground">
							{formatTime(t.lastMessageAt)}
						</span>
					</button>
				))}
			</div>

			<div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden rounded-lg border border-border bg-card/80">
				{activeThreadId === null ? (
					<div className="flex h-full flex-col items-center justify-center gap-2 text-center">
						<MessagesSquare className="size-8 text-muted-foreground" />
						<span className="text-muted-foreground text-sm">
							Выберите переписку слева, чтобы открыть её.
						</span>
					</div>
				) : (
					<>
						<header className="flex items-center justify-between gap-3 border-border border-b px-4 py-2.5">
							<h2 className="truncate font-semibold text-sm">
								{thread
									? formatThreadTitle({
											subject: thread.subject,
											id: thread.id,
										})
									: "Переписка"}
							</h2>
							<ThreadPresence
								threadId={activeThreadId}
								onTypingControl={handleTypingControl}
							/>
						</header>

						<div className="min-h-0 flex-1 overflow-y-auto p-4">
							{threadQuery.isError ? (
								<p className="cursor-text select-text text-destructive text-sm">
									{threadQuery.error.message}
								</p>
							) : threadQuery.isLoading && messages.length === 0 ? (
								<div className="space-y-3">
									<Skeleton className="h-12 w-2/3 rounded-2xl" />
									<Skeleton className="h-12 w-1/2 rounded-2xl" />
								</div>
							) : messages.length === 0 ? (
								<p className="py-8 text-center text-muted-foreground text-xs">
									Сообщений пока нет — напишите первое.
								</p>
							) : (
								<div className="flex flex-col gap-3">
									{messages.map((message) => {
										const isOwn =
											!!currentUserId && message.authorUserId === currentUserId;
										const isDeleted = Boolean(message.deletedAt);
										const isEdited = Boolean(message.editedAt);
										const showActions = isOwn && !isDeleted;
										return (
											<div
												key={message.id}
												className={cn(
													"group flex flex-col",
													isOwn ? "items-end" : "items-start",
												)}
											>
												<div className="flex items-center gap-1">
													{showActions && (
														<div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
															<Button
																type="button"
																size="icon"
																variant="ghost"
																className="size-6"
																aria-label="Изменить"
																onClick={() =>
																	handleEditMessage(message.id, message.body)
																}
															>
																<Pencil className="size-3.5" />
															</Button>
															<Button
																type="button"
																size="icon"
																variant="ghost"
																className="size-6"
																aria-label="Удалить"
																onClick={() => handleDeleteMessage(message.id)}
															>
																<Trash2 className="size-3.5" />
															</Button>
														</div>
													)}
													<div
														className={cn(
															"max-w-[80%] rounded-2xl px-3 py-2 text-sm",
															isOwn
																? "bg-primary text-primary-foreground"
																: "bg-muted text-foreground",
														)}
													>
														{isDeleted ? (
															<p className="cursor-text select-text italic text-muted-foreground">
																Сообщение удалено
															</p>
														) : (
															<p className="cursor-text select-text whitespace-pre-wrap break-words">
																{message.body}
															</p>
														)}
													</div>
												</div>
												<span className="mt-0.5 text-[10px] text-muted-foreground">
													{formatTime(message.createdAt)}
													{!isDeleted && isEdited && " · изменено"}
												</span>
											</div>
										);
									})}
									<div ref={bottomRef} />
								</div>
							)}
						</div>

						{/* Composer */}
						<div className="border-border border-t p-3">
							<div className="flex items-end gap-2">
								<Textarea
									value={body}
									onChange={(e) => handleComposerChange(e.target.value)}
									onKeyDown={(e) => {
										if (e.key === "Enter" && !e.shiftKey) {
											e.preventDefault();
											handleSend();
										}
									}}
									placeholder="Сообщение…"
									rows={1}
									className="max-h-32 min-h-9 flex-1 resize-none"
								/>
								<Button
									type="button"
									size="icon"
									className="size-9 shrink-0"
									aria-label="Отправить"
									disabled={!canSend}
									onClick={handleSend}
								>
									<Send className="size-4" />
								</Button>
							</div>
						</div>
					</>
				)}
			</div>
		</div>
	);
}

/**
 * The unified inbox surface (desktop), porting the web InboxScreen pattern. A
 * transport switch sits above two views:
 *
 *   • "Чат"   — the in-app comms threads (`comms.*`): split-pane thread list +
 *               thread view + composer.
 *   • "Почта" — the per-user `@rox.one` mailbox (`mail.*`), reusing `EmailView`.
 *
 * Email is a transport WITHIN the one inbox, not a separate destination. The
 * standalone `/email` route is kept for back-compat, but the mail tab here
 * renders the same `EmailView`, so the two stay in sync without duplication.
 */
export function InboxView() {
	const [transport, setTransport] = useState<InboxTransport>("chat");

	// Open-thread selection is lifted here (out of ChatTab / EmailView) so the one
	// shared SSE hook can refresh the open thread's `*.getThread` cache only when
	// the event targets the thread on screen AND the open tab matches its
	// transport (mirrors web's open-thread gating).
	const [chatThreadId, setChatThreadId] = useState<string | null>(null);
	const [mailThreadId, setMailThreadId] = useState<string | null>(null);

	// Live unified-inbox delivery (B-desktop): refetch the right tRPC caches when
	// a new message/email lands. Invalidate-only (cache-first, AGENTS.md #9) — no
	// row blanking; existing threads/messages stay rendered during the refetch.
	useCommsStream({
		openThreadId: transport === "chat" ? chatThreadId : mailThreadId,
		transport,
	});

	// The mail tab reuses EmailView, which brings its own SuiteScreen header.
	if (transport === "mail") {
		return (
			<div className="flex h-full flex-col">
				<TransportTabs value={transport} onChange={setTransport} />
				<div className="min-h-0 flex-1">
					<EmailView
						activeThreadId={mailThreadId}
						onSelectThread={setMailThreadId}
					/>
				</div>
			</div>
		);
	}

	return (
		<SuiteScreen
			title="Входящие"
			description="Чат и почта в одном месте"
			icon={Inbox}
		>
			<TransportTabs value={transport} onChange={setTransport} />
			<div className="mt-4">
				<ChatTab
					activeThreadId={chatThreadId}
					setActiveThreadId={setChatThreadId}
				/>
			</div>
		</SuiteScreen>
	);
}

function TransportTabs({
	value,
	onChange,
}: {
	value: InboxTransport;
	onChange: (value: InboxTransport) => void;
}) {
	return (
		<Tabs
			value={value}
			onValueChange={(next) => onChange(next as InboxTransport)}
		>
			<TabsList>
				<TabsTrigger value="chat" className="gap-1.5 text-xs">
					<MessagesSquare className="size-3.5" /> Чат
				</TabsTrigger>
				<TabsTrigger value="mail" className="gap-1.5 text-xs">
					<Mail className="size-3.5" /> Почта
				</TabsTrigger>
			</TabsList>
		</Tabs>
	);
}
