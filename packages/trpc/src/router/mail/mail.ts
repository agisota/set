/**
 * Mail tRPC router (D3 P3) — the per-user `<handle>@rox.one` mailbox API.
 *
 * INBOUND ingest is the `/api/mail/inbound` route (apps/api); this router owns
 * the read surface (threads/messages) + provisioning + OUTBOUND send. Every
 * procedure is org-scoped via `requireActiveOrgMembership` AND owner-scoped to
 * `ctx.session.user.id` — a user only ever sees their own mailbox (DQ3: the
 * mailbox is global per user; org is the Electric shape filter, not a silo).
 *
 * Outbound (`send`) goes through the `@rox/comms-core` {@link EmailAdapter} with
 * an INJECTED Resend send fn (the guarded {@link getMailSendFn} seam). The path
 * is inert without `MAIL_OUTBOUND_ENABLED` + `RESEND_API_KEY` — it then fails
 * with a clean `PRECONDITION_FAILED`. A per-user quota/rate gate runs first via
 * the WS-E economy `ensureBalance` helper (no new ledger kind is introduced).
 *
 * Bodies/attachments live in R2 (D8); these rows hold only metadata + pointers.
 */

import {
	deriveDedupKey,
	EmailAdapter,
	normalizeSubject,
} from "@rox/comms-core";
import { db } from "@rox/db/client";
import {
	commsAddresses,
	commsMessages,
	commsParticipants,
	commsThreads,
	mailAddresses,
	mailAttachments,
	mailMessages,
	mailThreads,
	ROX_MAIL_DOMAIN,
	roxBalances,
	roxLedger,
	userProfiles,
} from "@rox/db/schema";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, count, desc, eq, gt, inArray, sql } from "drizzle-orm";
import { protectedProcedure } from "../../trpc";
import { getDriveStorage } from "../drive/storage";
import { ensureBalance } from "../economy";
import { requireActiveOrgMembership } from "../utils/active-org";
import {
	MAIL_PRESIGN_TTL_SECONDS,
	MAIL_SEND_COST_ROX,
	MAIL_SEND_RATE_MAX,
	MAIL_SEND_RATE_WINDOW_MS,
} from "./config";
import {
	getAttachmentUrlSchema,
	getBodyUrlSchema,
	getMessageSchema,
	getThreadSchema,
	listThreadsSchema,
	markReadSchema,
	provisionAddressSchema,
	sendSchema,
} from "./schema";
import { getMailDomain, getMailSendFn } from "./transport";

/** Confirm a thread belongs to the org AND is owned by the caller. */
async function getOwnedThread(
	organizationId: string,
	ownerUserId: string,
	threadId: string,
) {
	const [row] = await db
		.select()
		.from(mailThreads)
		.where(
			and(
				eq(mailThreads.id, threadId),
				eq(mailThreads.organizationId, organizationId),
				eq(mailThreads.ownerUserId, ownerUserId),
			),
		)
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Thread not found" });
	}
	return row;
}

/**
 * Resolve the caller's primary `<handle>@rox.one` address row, if provisioned.
 * Returns the row regardless of status (active|grace|disabled) so the send path
 * can short-circuit explicitly on `disabled` (M3 kill-switch) rather than
 * silently treating a disabled address as "not provisioned".
 */
async function getPrimaryAddress(ownerUserId: string) {
	const [row] = await db
		.select()
		.from(mailAddresses)
		.where(
			and(
				eq(mailAddresses.userId, ownerUserId),
				eq(mailAddresses.kind, "primary"),
			),
		)
		.limit(1);
	return row ?? null;
}

/**
 * Resolve the object-storage provider (R2) or throw a clean error when storage
 * is unconfigured (CI/dev). Mail bodies + attachments share the Drive R2 store
 * (DECISIONS.md DQ1), so the Drive seam is reused rather than duplicated.
 */
function requireStorage() {
	const storage = getDriveStorage();
	if (!storage) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message: "Object storage is not configured (missing R2 credentials).",
		});
	}
	return storage;
}

/** A db/tx handle compatible with the outbound D1 emit (root client OR a tx). */
type MailTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Emit an outbound sent mail into the D1 unified inbox (M6). Finds-or-creates a
 * `comms_threads` row keyed by the cross-transport dedup key (reply root, else
 * the sorted participant set) and inserts a `comms_messages` row with
 * `transport='email'`, `direction='outbound'`. The (transport, external_id)
 * global unique is guarded with `onConflictDoNothing`, and `external_id` is
 * `null` for outbound (the provider id is carried in metadata) so it never
 * collides with an inbound RFC Message-ID.
 */
async function emitOutboundToUnifiedInbox(
	tx: MailTx,
	args: {
		organizationId: string;
		authorUserId: string;
		fromAddr: string;
		toAddrs: string[];
		subject: string | null;
		snippet: string;
		providerId: string;
		inReplyTo: string | null;
		mailMessageId: string;
	},
): Promise<void> {
	const dedupKey =
		deriveDedupKey({
			rootExternalId: args.inReplyTo ?? null,
			participantAddresses: [args.fromAddr, ...args.toAddrs],
		}) ?? `mail:${args.mailMessageId}`;

	// FIX 2: find-or-create with the (org, dedup_key) partial unique as a backstop.
	// A SELECT-then-INSERT race (a concurrent inbound emit for the same reply root)
	// collapses on the conflict + re-select, so both halves share ONE thread.
	const [existing] = await tx
		.select({ id: commsThreads.id })
		.from(commsThreads)
		.where(
			and(
				eq(commsThreads.organizationId, args.organizationId),
				eq(commsThreads.dedupKey, dedupKey),
			),
		)
		.limit(1);

	let threadId: string;
	if (existing) {
		threadId = existing.id;
		await tx
			.update(commsThreads)
			.set({ lastMessageAt: new Date() })
			.where(eq(commsThreads.id, threadId));
	} else {
		const [thread] = await tx
			.insert(commsThreads)
			.values({
				organizationId: args.organizationId,
				subject: args.subject,
				dedupKey,
				lastMessageAt: new Date(),
			})
			.onConflictDoNothing({
				target: [commsThreads.organizationId, commsThreads.dedupKey],
			})
			.returning({ id: commsThreads.id });
		if (thread) {
			threadId = thread.id;
		} else {
			// Lost the insert race — re-select the concurrent winner's thread.
			const [winner] = await tx
				.select({ id: commsThreads.id })
				.from(commsThreads)
				.where(
					and(
						eq(commsThreads.organizationId, args.organizationId),
						eq(commsThreads.dedupKey, dedupKey),
					),
				)
				.limit(1);
			if (!winner) throw new Error("Failed to create comms thread");
			threadId = winner.id;
		}
	}

	// FIX 1: the SENDER (mailbox owner) is always a participant; any recipient that
	// is an internal rox `@rox.one` user becomes one too, so an in-app reply to an
	// outbound email surfaces for both via the participant-scoped comms.* + the SSE
	// leak-gate forwards it. External recipients are NOT rox participants here.
	const recipientUserIds = await resolveRoxRecipientUserIds(tx, args.toAddrs);
	const participantUserIds = [
		...new Set([args.authorUserId, ...recipientUserIds]),
	];
	await tx
		.insert(commsParticipants)
		.values(
			participantUserIds.map((userId) => ({
				organizationId: args.organizationId,
				threadId,
				userId,
				role: "member" as const,
			})),
		)
		.onConflictDoNothing();

	await tx
		.insert(commsMessages)
		.values({
			organizationId: args.organizationId,
			threadId,
			transport: "email",
			direction: "outbound",
			authorUserId: args.authorUserId,
			externalId: null,
			inReplyToExternalId: args.inReplyTo,
			body: args.snippet,
			metadata: {
				mailMessageId: args.mailMessageId,
				providerId: args.providerId,
				source: "d3-email",
			},
		})
		.onConflictDoNothing();
}

/**
 * Resolve which of the given email addresses belong to internal rox users (a
 * live, non-alias `comms_addresses` email row). Used to add the rox counterpart
 * of an internal `@rox.one`→`@rox.one` send as a thread participant. Returns the
 * distinct user ids; an empty input or all-external recipients yields `[]`.
 */
async function resolveRoxRecipientUserIds(
	tx: MailTx,
	toAddrs: string[],
): Promise<string[]> {
	const normalized = [
		...new Set(toAddrs.map((a) => a.trim().toLowerCase()).filter(Boolean)),
	];
	if (normalized.length === 0) return [];
	const rows = await tx
		.select({ userId: commsAddresses.userId })
		.from(commsAddresses)
		.where(
			and(
				eq(commsAddresses.kind, "email"),
				eq(commsAddresses.isAlias, false),
				inArray(commsAddresses.value, normalized),
			),
		);
	return [...new Set(rows.map((r) => r.userId))];
}

export const mailRouter = {
	getMailbox: protectedProcedure.query(async ({ ctx }) => {
		await requireActiveOrgMembership(ctx);
		const address = await getPrimaryAddress(ctx.session.user.id);
		return { address };
	}),

	/**
	 * Provision (or re-affirm) the caller's routable `<handle>@rox.one` address.
	 * Idempotent: the global UNIQUE on `address` guards duplicates. The handle is
	 * taken from the caller's `user_profiles.handle` unless overridden.
	 */
	provisionAddress: protectedProcedure
		.input(provisionAddressSchema)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;

			let handle = input.handle?.trim().toLowerCase();
			if (!handle) {
				const [profile] = await db
					.select({ handle: userProfiles.handle })
					.from(userProfiles)
					.where(eq(userProfiles.userId, userId))
					.limit(1);
				handle = profile?.handle?.trim().toLowerCase() ?? undefined;
			}
			if (!handle) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Set a handle before provisioning your mailbox.",
				});
			}

			const address = `${handle}@${ROX_MAIL_DOMAIN}`;

			// Global reservation guard: if someone else already owns this address,
			// refuse rather than silently no-op into their mailbox (DQ4).
			const [existing] = await db
				.select()
				.from(mailAddresses)
				.where(eq(mailAddresses.address, address))
				.limit(1);
			if (existing && existing.userId !== userId) {
				throw new TRPCError({
					code: "CONFLICT",
					message: "That address is already reserved.",
				});
			}
			if (existing) return existing;

			const [row] = await db
				.insert(mailAddresses)
				.values({
					userId,
					organizationId,
					localPart: handle,
					domain: ROX_MAIL_DOMAIN,
					address,
					kind: "primary",
					status: "active",
				})
				.returning();
			return row;
		}),

	/** The caller's mailbox threads, newest-first. */
	listThreads: protectedProcedure
		.input(listThreadsSchema)
		.query(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			return db
				.select()
				.from(mailThreads)
				.where(
					and(
						eq(mailThreads.organizationId, organizationId),
						eq(mailThreads.ownerUserId, ctx.session.user.id),
					),
				)
				.orderBy(desc(mailThreads.lastMessageAt))
				.limit(input?.limit ?? 50);
		}),

	/** A thread plus its messages (chronological). Owner-scoped. */
	getThread: protectedProcedure
		.input(getThreadSchema)
		.query(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;
			const thread = await getOwnedThread(
				organizationId,
				userId,
				input.threadId,
			);

			const messages = await db
				.select()
				.from(mailMessages)
				.where(
					and(
						eq(mailMessages.organizationId, organizationId),
						eq(mailMessages.ownerUserId, userId),
						eq(mailMessages.threadId, thread.id),
					),
				)
				.orderBy(asc(mailMessages.createdAt))
				.limit(input.limit ?? 200);

			return { thread, messages };
		}),

	/** A single message + its attachment pointers. Owner-scoped. */
	getMessage: protectedProcedure
		.input(getMessageSchema)
		.query(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;

			const [message] = await db
				.select()
				.from(mailMessages)
				.where(
					and(
						eq(mailMessages.id, input.messageId),
						eq(mailMessages.organizationId, organizationId),
						eq(mailMessages.ownerUserId, userId),
					),
				)
				.limit(1);
			if (!message) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Message not found",
				});
			}

			const attachments = await db
				.select()
				.from(mailAttachments)
				.where(eq(mailAttachments.messageId, message.id));

			return { message, attachments };
		}),

	/**
	 * Send (compose or reply) from `<handle>@rox.one`. Quota-gated, then sent via
	 * the injected Resend transport. Persists an outbound `mail_messages` row
	 * (direction=out). Inert without outbound creds → `PRECONDITION_FAILED`.
	 */
	send: protectedProcedure
		.input(sendSchema)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;

			// Per-user balance gate (WS-E): the send must be affordable. The actual
			// debit happens atomically inside the persist transaction below; here we
			// only pre-flight so we can fail fast before touching the transport.
			const balance = await ensureBalance(userId);
			if (balance < MAIL_SEND_COST_ROX) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Insufficient Rox balance to send mail.",
				});
			}

			// Per-user rate cap (M3): count this user's outbound sends inside the
			// rolling window. Reuses `created_at` — no extra table.
			const windowStart = new Date(Date.now() - MAIL_SEND_RATE_WINDOW_MS);
			const [recent] = await db
				.select({ n: count() })
				.from(mailMessages)
				.where(
					and(
						eq(mailMessages.ownerUserId, userId),
						eq(mailMessages.direction, "outbound"),
						gt(mailMessages.createdAt, windowStart),
					),
				);
			if ((recent?.n ?? 0) >= MAIL_SEND_RATE_MAX) {
				throw new TRPCError({
					code: "TOO_MANY_REQUESTS",
					message: "Send rate limit exceeded. Try again shortly.",
				});
			}

			const address = await getPrimaryAddress(userId);
			if (!address) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Provision your mailbox before sending.",
				});
			}

			// Kill-switch (M3): a suppressed/disabled address may never send.
			if (address.status === "disabled") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "This mailbox is disabled and cannot send mail.",
				});
			}

			// Outbound transport gate: inert without MAIL_OUTBOUND_ENABLED + key.
			const sendFn = getMailSendFn();
			if (!sendFn) {
				throw new TRPCError({
					code: "PRECONDITION_FAILED",
					message: "Outbound email is not configured.",
				});
			}

			// Confirm thread ownership when replying, and derive the RFC References
			// chain server-side from the parent thread rather than trusting the
			// client (M7). The newest message in the thread is the reply parent.
			let parentThread: Awaited<ReturnType<typeof getOwnedThread>> | undefined;
			let derivedInReplyTo: string | null = input.inReplyTo ?? null;
			let derivedReferences: string[] = input.references ?? [];
			if (input.threadId) {
				parentThread = await getOwnedThread(
					organizationId,
					userId,
					input.threadId,
				);

				const [parent] = await db
					.select({
						rfcMessageId: mailMessages.rfcMessageId,
						inReplyTo: mailMessages.inReplyTo,
						referencesIds: mailMessages.referencesIds,
					})
					.from(mailMessages)
					.where(
						and(
							eq(mailMessages.threadId, parentThread.id),
							eq(mailMessages.ownerUserId, userId),
						),
					)
					.orderBy(desc(mailMessages.createdAt))
					.limit(1);

				if (parent) {
					// References = parent's References chain + the parent's Message-ID;
					// In-Reply-To = the parent's Message-ID. Both derived, not trusted.
					const chain = [
						...(parent.referencesIds ?? []),
						...(parent.rfcMessageId ? [parent.rfcMessageId] : []),
					];
					derivedReferences = chain;
					derivedInReplyTo = parent.rfcMessageId ?? derivedInReplyTo;
				}
			}

			const adapter = new EmailAdapter({
				send: sendFn,
				domain: getMailDomain(),
				resolveFromAddress: async () => address.address,
			});

			// The adapter builds RFC headers (From, Reply-To, In-Reply-To / References)
			// and hands the payload to the injected Resend send fn.
			const result = await adapter.send(
				{
					organizationId,
					authorUserId: userId,
					recipients: input.to.map((a) => ({ kind: "address", address: a })),
					subject: input.subject ?? null,
					body: input.body,
					bodyHtml: input.bodyHtml ?? null,
					metadata: {
						inReplyTo: derivedInReplyTo ?? undefined,
						references: derivedReferences,
						cc: input.cc ?? [],
						bcc: input.bcc ?? [],
					},
				},
				{
					toAddress: input.to[0] ?? "",
					delivery: {
						id: "outbound",
						messageId: "outbound",
						transport: "email",
					},
				},
			);

			// Persist + debit atomically (M3): the send cost decrements the WS-E
			// ledger/balance in the SAME transaction as the outbound row, so the
			// spam-cannon gate is no longer a no-op. The thread's `message_count`
			// + `last_message_at` are bumped on replies (M7).
			const row = await db.transaction(async (tx) => {
				const [inserted] = await tx
					.insert(mailMessages)
					.values({
						organizationId,
						ownerUserId: userId,
						addressId: address.id,
						threadId: input.threadId ?? null,
						direction: "outbound",
						status: "sent",
						inReplyTo: derivedInReplyTo,
						referencesIds: derivedReferences.length ? derivedReferences : null,
						fromAddr: address.address,
						toAddrs: input.to,
						ccAddrs: input.cc ?? [],
						bccAddrs: input.bcc ?? [],
						subject: input.subject ?? null,
						snippet: input.body.slice(0, 200),
						hasAttachments: false,
						provider: "resend",
						providerEventId: result.providerId,
						sentAt: new Date(),
					})
					.returning();

				// Debit the WS-E ledger + balance for this send (M3).
				await tx.insert(roxLedger).values({
					userId,
					deltaRox: String(-MAIL_SEND_COST_ROX),
					kind: "mail_send",
				});
				await tx
					.update(roxBalances)
					.set({
						balanceRox: sql`${roxBalances.balanceRox} - ${MAIL_SEND_COST_ROX}`,
					})
					.where(eq(roxBalances.userId, userId));

				// Bump the thread's activity + message_count on replies (M7).
				if (input.threadId) {
					await tx
						.update(mailThreads)
						.set({
							lastMessageAt: new Date(),
							messageCount: sql`${mailThreads.messageCount} + 1`,
						})
						.where(
							and(
								eq(mailThreads.id, input.threadId),
								eq(mailThreads.ownerUserId, userId),
							),
						);
				}

				// M6: emit the outbound mail into the D1 unified inbox so it shows
				// alongside inbound and a reply threads into the same conversation.
				// Keyed on the SAME participant-set dedup key the inbound emit uses
				// (sender `@rox.one` + recipients), or the reply root when present —
				// so the inbox shows BOTH halves of the conversation, not just inbound.
				await emitOutboundToUnifiedInbox(tx, {
					organizationId,
					authorUserId: userId,
					fromAddr: address.address,
					toAddrs: input.to,
					subject: input.subject ?? null,
					snippet: input.body.slice(0, 200),
					providerId: result.providerId,
					inReplyTo: derivedInReplyTo,
					mailMessageId: inserted?.id ?? "",
				});

				return inserted;
			});

			return {
				messageId: row?.id ?? "",
				providerId: result.providerId,
				subjectNorm: normalizeSubject(input.subject),
			};
		}),

	/** Set the read flag on a message the caller owns. */
	markRead: protectedProcedure
		.input(markReadSchema)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;

			const rows = await db
				.update(mailMessages)
				.set({ isRead: input.isRead ?? true })
				.where(
					and(
						eq(mailMessages.id, input.messageId),
						eq(mailMessages.organizationId, organizationId),
						eq(mailMessages.ownerUserId, userId),
					),
				)
				.returning({ id: mailMessages.id });

			if (rows.length === 0) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Message not found",
				});
			}
			return { ok: true as const };
		}),

	/**
	 * Short-TTL presigned R2 GET for one attachment the caller owns (M5). The
	 * attachment is owner-scoped via its parent message: a join confirms the
	 * message belongs to the caller before any URL is minted.
	 */
	getAttachmentUrl: protectedProcedure
		.input(getAttachmentUrlSchema)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;
			const storage = requireStorage();

			const [att] = await db
				.select({
					blobKey: mailAttachments.blobKey,
					filename: mailAttachments.filename,
				})
				.from(mailAttachments)
				.innerJoin(mailMessages, eq(mailAttachments.messageId, mailMessages.id))
				.where(
					and(
						eq(mailAttachments.id, input.attachmentId),
						eq(mailMessages.ownerUserId, userId),
						eq(mailMessages.organizationId, organizationId),
					),
				)
				.limit(1);
			if (!att) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Attachment not found",
				});
			}

			const presigned = await storage.presignGet({
				key: att.blobKey,
				downloadFilename: att.filename,
				expiresIn: MAIL_PRESIGN_TTL_SECONDS,
			});
			return { url: presigned.url, expiresAt: presigned.expiresAt };
		}),

	/**
	 * Short-TTL presigned R2 GET for a message body (M5). Defaults to the
	 * extracted text/plain variant; `variant: "html"` returns the sanitized
	 * text/html object. NOTE: the HTML object stored at `body_html_key` MUST be
	 * server-side sanitized before render (the ingest/sanitize step owns that);
	 * this procedure only mints a download URL, it does not render.
	 */
	getBodyUrl: protectedProcedure
		.input(getBodyUrlSchema)
		.mutation(async ({ ctx, input }) => {
			const organizationId = await requireActiveOrgMembership(ctx);
			const userId = ctx.session.user.id;
			const storage = requireStorage();

			const [message] = await db
				.select({
					bodyTextKey: mailMessages.bodyTextKey,
					bodyHtmlKey: mailMessages.bodyHtmlKey,
				})
				.from(mailMessages)
				.where(
					and(
						eq(mailMessages.id, input.messageId),
						eq(mailMessages.ownerUserId, userId),
						eq(mailMessages.organizationId, organizationId),
					),
				)
				.limit(1);
			if (!message) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Message not found",
				});
			}

			const key =
				input.variant === "html" ? message.bodyHtmlKey : message.bodyTextKey;
			if (!key) {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Body is not available for this message.",
				});
			}

			const presigned = await storage.presignGet({
				key,
				expiresIn: MAIL_PRESIGN_TTL_SECONDS,
			});
			return { url: presigned.url, expiresAt: presigned.expiresAt };
		}),
} satisfies TRPCRouterRecord;
