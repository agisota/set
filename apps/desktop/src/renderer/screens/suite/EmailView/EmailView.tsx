import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@rox/ui/dialog";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { Skeleton } from "@rox/ui/skeleton";
import { toast } from "@rox/ui/sonner";
import { Textarea } from "@rox/ui/textarea";
import { cn } from "@rox/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ArrowDownLeft,
	ArrowUpRight,
	AtSign,
	Download,
	Mail,
	Paperclip,
	PenSquare,
	Send,
	UserRound,
} from "lucide-react";
import { useMemo, useState } from "react";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { authClient } from "renderer/lib/auth-client";
import { logger } from "renderer/lib/logger";
import { SuiteQueryError } from "../components/SuiteQueryError";
import { SuiteScreen } from "../components/SuiteScreen";
import { sanitizeMailHtml } from "./sanitizeMailHtml";
import { useMailBody } from "./useMailBody";

function formatDateTime(value: Date | string | null | undefined): string {
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
 * Email inbox (Suite P3 surfaced in P0), mirroring the web inbox: a thread list
 * on the left (`mail.listThreads`), the selected thread's messages on the right
 * (`mail.getThread`), compose/reply via `mail.send`, and read-state via
 * `mail.markRead`.
 *
 * Bodies live in R2: the FULL body is fetched per message via `mail.getBodyUrl`
 * (FEATURE A). An HTML body is sanitized with DOMPurify (`sanitizeMailHtml`) and
 * rendered in an isolated, clipped container; a text body renders as escaped
 * plain text. The server-trimmed `snippet` is the loading/error fallback.
 * Attachments are downloadable via short-TTL presigned `mail.getAttachmentUrl`.
 *
 * Cache-first (AGENTS.md rule 9): cached threads render while a refetch runs.
 *
 * Selection is OPTIONALLY controllable: when `InboxView` mounts EmailView inside
 * the unified inbox it lifts the open thread up (so live SSE can invalidate the
 * open mail thread's `mail.getThread`). The standalone `/email` route mounts it
 * with no props and keeps its own internal selection — backward compatible.
 */
export interface EmailViewProps {
	/** Controlled open thread id; omit to use EmailView's internal selection. */
	activeThreadId?: string | null;
	/** Called when the open thread changes (only meaningful when controlled). */
	onSelectThread?: (id: string | null) => void;
}

export function EmailView(props: EmailViewProps = {}) {
	const trpc = useTRPC();
	const queryClient = useQueryClient();
	const { data: session } = authClient.useSession();

	const [internalThreadId, setInternalThreadId] = useState<string | null>(null);
	const isControlled = props.activeThreadId !== undefined;
	const activeThreadId = isControlled
		? (props.activeThreadId ?? null)
		: internalThreadId;
	const setActiveThreadId = (id: string | null) => {
		if (!isControlled) setInternalThreadId(id);
		props.onSelectThread?.(id);
	};
	const [composeOpen, setComposeOpen] = useState(false);
	const [to, setTo] = useState("");
	const [subject, setSubject] = useState("");
	const [body, setBody] = useState("");

	const threadsQuery = useQuery(
		trpc.mail.listThreads.queryOptions({ limit: 50 }),
	);
	const mailboxQuery = useQuery(trpc.mail.getMailbox.queryOptions());
	const threads = threadsQuery.data ?? [];
	const mailbox = mailboxQuery.data?.address ?? null;
	const sessionUser = session?.user;
	const loginEmail = sessionUser?.email ?? "Аккаунт загружается";
	const loginName = sessionUser?.name?.trim() || loginEmail;
	const mailboxAddress = mailbox?.address ?? "Почтовый ящик @rox.one не создан";
	const mailboxStatus =
		mailbox?.status === "active"
			? "Активен"
			: mailbox?.status === "disabled"
				? "Отключён"
				: mailbox?.status === "grace"
					? "Переходный период"
					: "Нужна настройка";

	const threadQuery = useQuery({
		...trpc.mail.getThread.queryOptions({ threadId: activeThreadId ?? "" }),
		enabled: activeThreadId !== null,
	});

	const markRead = useMutation(
		trpc.mail.markRead.mutationOptions({
			onSuccess: async () => {
				if (activeThreadId) {
					await queryClient.invalidateQueries({
						queryKey: trpc.mail.getThread.queryKey({
							threadId: activeThreadId,
						}),
					});
				}
			},
			onError: (error) => {
				logger.error("[EmailView] markRead failed", error);
			},
		}),
	);

	const send = useMutation(
		trpc.mail.send.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries({
					queryKey: trpc.mail.listThreads.queryKey({ limit: 50 }),
				});
				setComposeOpen(false);
				setTo("");
				setSubject("");
				setBody("");
				toast.success("Письмо отправлено");
			},
			onError: (error) => {
				logger.error("[EmailView] send failed", error);
				toast.error(error.message || "Не удалось отправить письмо");
			},
		}),
	);

	const messages = threadQuery.data?.messages ?? [];

	const handleSend = () => {
		const recipients = to
			.split(/[,;\s]+/)
			.map((value) => value.trim())
			.filter(Boolean);
		if (recipients.length === 0 || !body.trim()) return;
		send.mutate({
			to: recipients,
			subject: subject.trim() || undefined,
			body,
		});
	};

	return (
		<SuiteScreen
			title="Почта"
			description="Входящие, чтение и отправка"
			icon={Mail}
			actions={
				<Button onClick={() => setComposeOpen(true)}>
					<PenSquare className="size-4" /> Написать
				</Button>
			}
		>
			{threadsQuery.isError && (
				<SuiteQueryError
					message={threadsQuery.error.message}
					onRetry={() => threadsQuery.refetch()}
				/>
			)}

			<div className="mb-4 grid w-full gap-3 rounded-lg border border-border bg-card/80 p-3 sm:grid-cols-[minmax(0,1fr)_minmax(18rem,0.9fr)]">
				<div className="flex min-w-0 items-center gap-3">
					<div className="flex size-9 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
						<UserRound className="size-4" />
					</div>
					<div className="min-w-0">
						<p className="truncate text-sm font-medium">{loginName}</p>
						<p className="truncate text-muted-foreground text-xs">
							Вход выполнен: {loginEmail}
						</p>
					</div>
				</div>
				<div className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border bg-background/70 px-3 py-2">
					<div className="flex min-w-0 items-center gap-2">
						<AtSign className="size-4 shrink-0 text-muted-foreground" />
						<div className="min-w-0">
							<p className="truncate text-sm font-medium">{mailboxAddress}</p>
							<p className="truncate text-muted-foreground text-xs">
								Адрес для входящих и исходящих писем Rox
							</p>
						</div>
					</div>
					<Badge variant={mailbox?.status === "active" ? "default" : "outline"}>
						{mailboxStatus}
					</Badge>
				</div>
			</div>

			{threads.length === 0 && threadsQuery.isLoading && (
				<div className="space-y-2">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-14 w-full" />
					))}
				</div>
			)}

			{threads.length === 0 && threadsQuery.isSuccess && (
				<div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed py-20 text-center">
					<Mail className="mb-3 size-8 text-muted-foreground" />
					<span className="text-foreground text-sm">Входящих нет</span>
					<span className="mt-1 max-w-sm text-muted-foreground text-xs">
						Когда придут письма, они появятся здесь.
					</span>
				</div>
			)}

			{threads.length > 0 && (
				<div className="flex h-[calc(100vh-220px)] min-h-96 min-w-0 gap-4">
					<div className="w-[clamp(20rem,28vw,26rem)] min-w-72 max-w-[45vw] resize-x overflow-y-auto overflow-x-hidden rounded-lg border border-border bg-card/80">
						{threads.map((thread) => (
							<button
								key={thread.id}
								type="button"
								onClick={() => setActiveThreadId(thread.id)}
								className={cn(
									"flex w-full flex-col gap-0.5 border-border border-b px-3 py-2.5 text-left last:border-b-0 transition-colors hover:bg-accent/40",
									thread.id === activeThreadId && "bg-accent",
								)}
							>
								<div className="flex items-center justify-between gap-2">
									<span className="truncate text-sm font-medium">
										{thread.subjectNorm?.trim() || "(без темы)"}
									</span>
									<span className="shrink-0 text-[10px] text-muted-foreground">
										{formatDateTime(thread.lastMessageAt)}
									</span>
								</div>
								<span className="text-muted-foreground text-xs">
									{thread.messageCount} сообщ.
								</span>
							</button>
						))}
					</div>

					<div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card/80">
						{activeThreadId === null ? (
							<div className="flex h-full flex-col items-center justify-center text-center">
								<Mail className="mb-3 size-8 text-muted-foreground" />
								<span className="text-muted-foreground text-sm">
									Выберите переписку
								</span>
							</div>
						) : threadQuery.isError ? (
							<p className="cursor-text select-text p-4 text-destructive text-sm">
								{threadQuery.error.message}
							</p>
						) : threadQuery.isLoading && messages.length === 0 ? (
							<div className="space-y-3 p-4">
								<Skeleton className="h-6 w-1/2" />
								<Skeleton className="h-20 w-full" />
							</div>
						) : (
							<div className="h-full overflow-y-auto p-4">
								<div className="space-y-3">
									{messages.map((message) => {
										const isOutbound = message.direction === "outbound";
										const timestamp =
											message.receivedAt ??
											message.sentAt ??
											message.createdAt ??
											null;
										return (
											<div
												key={message.id}
												className="rounded-lg border border-border bg-card"
											>
												<div className="flex items-start justify-between gap-2 border-border border-b px-3 py-2">
													<div className="flex min-w-0 flex-col">
														<span className="flex items-center gap-2">
															<span className="truncate text-sm font-medium">
																{isOutbound
																	? "Вы"
																	: (message.fromName ?? message.fromAddr)}
															</span>
															<Badge
																variant="outline"
																className="shrink-0 gap-1 px-1.5 py-0 text-[10px]"
															>
																{isOutbound ? (
																	<ArrowUpRight className="size-2.5" />
																) : (
																	<ArrowDownLeft className="size-2.5" />
																)}
																{isOutbound ? "Исходящее" : "Входящее"}
															</Badge>
															{!message.isRead && !isOutbound && (
																<span className="size-1.5 shrink-0 rounded-full bg-primary" />
															)}
														</span>
														<span className="truncate text-[11px] text-muted-foreground">
															{message.subject?.trim() || "(без темы)"}
														</span>
													</div>
													<div className="flex shrink-0 items-center gap-2">
														<span className="text-[10px] text-muted-foreground">
															{formatDateTime(timestamp)}
														</span>
														{!message.isRead && !isOutbound && (
															<Button
																size="sm"
																variant="ghost"
																className="h-6 px-2 text-[10px]"
																disabled={markRead.isPending}
																onClick={() =>
																	markRead.mutate({
																		messageId: message.id,
																		isRead: true,
																	})
																}
															>
																Прочитано
															</Button>
														)}
													</div>
												</div>
												{/* Full body from R2 (FEATURE A): sanitized HTML or text. */}
												<MailMessageBody
													messageId={message.id}
													snippet={message.snippet ?? null}
													hasAttachments={message.hasAttachments ?? false}
												/>
											</div>
										);
									})}
								</div>
							</div>
						)}
					</div>
				</div>
			)}

			<Dialog open={composeOpen} onOpenChange={setComposeOpen}>
				<DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Новое письмо</DialogTitle>
						<DialogDescription>
							Отправка с вашего адреса @rox.one.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mail-to">Кому</Label>
							<Input
								id="mail-to"
								value={to}
								onChange={(e) => setTo(e.target.value)}
								placeholder="name@example.com, …"
								type="email"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mail-subject">Тема</Label>
							<Input
								id="mail-subject"
								value={subject}
								onChange={(e) => setSubject(e.target.value)}
								placeholder="Тема письма"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="mail-body">Текст</Label>
							<Textarea
								id="mail-body"
								value={body}
								onChange={(e) => setBody(e.target.value)}
								placeholder="Текст письма…"
								rows={8}
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							disabled={!to.trim() || !body.trim() || send.isPending}
							onClick={handleSend}
						>
							<Send className="size-4" /> Отправить
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SuiteScreen>
	);
}

/** Human-readable byte size for an attachment row. */
function formatSize(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface MailMessageBodyProps {
	messageId: string;
	snippet: string | null;
	hasAttachments: boolean;
}

/**
 * The full body + attachments of one email message (FEATURE A). Fetches the body
 * from R2 via `useMailBody`: HTML is sanitized with DOMPurify then injected into
 * an isolated clipped container; text renders as escaped plain text. Attachment
 * metadata loads via `mail.getMessage`; each is downloaded through a presigned
 * `mail.getAttachmentUrl`, opened in the default browser.
 */
function MailMessageBody({
	messageId,
	snippet,
	hasAttachments,
}: MailMessageBodyProps) {
	const trpc = useTRPC();
	const bodyQuery = useMailBody(messageId, true);
	const sanitizedHtml = useMemo(() => {
		if (bodyQuery.data?.kind !== "html") return null;
		return sanitizeMailHtml(bodyQuery.data.content);
	}, [bodyQuery.data]);

	const detail = useQuery({
		...trpc.mail.getMessage.queryOptions({ messageId }),
		enabled: hasAttachments,
	});
	const attachments = detail.data?.attachments ?? [];

	const attachmentUrl = useMutation(
		trpc.mail.getAttachmentUrl.mutationOptions({
			onSuccess: ({ url }) => {
				window.open(url, "_blank", "noopener,noreferrer");
			},
			onError: (error) => {
				logger.error("[EmailView] attachment presign failed", error);
			},
		}),
	);

	return (
		<div className="px-3 py-3">
			{bodyQuery.isLoading ? (
				<p className="cursor-text select-text whitespace-pre-wrap break-words text-muted-foreground text-sm">
					Загрузка письма…
				</p>
			) : sanitizedHtml !== null ? (
				<div
					className="mail-html-body max-h-[60vh] cursor-text select-text overflow-auto break-words text-sm [&_a]:underline [&_img]:max-w-full"
					// Sanitized via DOMPurify in sanitizeMailHtml; rendered in an isolated,
					// clipped container so even valid markup stays bounded.
					// biome-ignore lint/security/noDangerouslySetInnerHtml: content is DOMPurify-sanitized
					dangerouslySetInnerHTML={{ __html: sanitizedHtml }}
				/>
			) : (
				<p className="cursor-text select-text whitespace-pre-wrap break-words text-sm">
					{bodyQuery.data?.content?.trim() ||
						snippet?.trim() ||
						"Текст письма недоступен в предпросмотре."}
				</p>
			)}

			{hasAttachments && attachments.length > 0 && (
				<div className="mt-3 flex flex-col gap-1.5">
					<span className="flex items-center gap-1 text-[11px] font-medium text-muted-foreground">
						<Paperclip className="size-3" /> Вложения
					</span>
					{attachments.map((att) => (
						<button
							key={att.id}
							type="button"
							disabled={attachmentUrl.isPending}
							onClick={() => attachmentUrl.mutate({ attachmentId: att.id })}
							className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-muted/40 px-2 py-1 text-left transition-colors hover:bg-muted disabled:opacity-60"
							title={`${att.contentType} · скачать`}
						>
							<Paperclip className="size-3.5 shrink-0 text-muted-foreground" />
							<span className="truncate text-xs font-medium">
								{att.filename}
							</span>
							<span className="shrink-0 text-[10px] text-muted-foreground">
								{formatSize(att.sizeBytes)}
							</span>
							<Download className="size-3 shrink-0 text-muted-foreground" />
						</button>
					))}
				</div>
			)}
		</div>
	);
}
