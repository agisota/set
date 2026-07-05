import { beforeEach, describe, expect, mock, test } from "bun:test";

// --- DB stub -----------------------------------------------------------------
// Stubs `@rox/db/client` so the suite needs no live database (mirrors the
// comms/dashboard trpc harness). A queue of result-sets drives each `select`;
// inserts/updates record their values and return configured rows.

type AnyRow = Record<string, unknown>;

const state: {
	selectQueue: AnyRow[][];
	inserted: { values: AnyRow[] }[];
	insertReturning: AnyRow[];
	updated: AnyRow[];
	updateReturning: AnyRow[];
} = {
	selectQueue: [],
	inserted: [],
	insertReturning: [{ id: "new-id" }],
	updated: [],
	updateReturning: [{ id: "msg-1" }],
};

function selectBuilder(rows: AnyRow[]) {
	const step = (): Promise<AnyRow[]> & Record<string, () => unknown> => {
		const p = Promise.resolve(rows) as Promise<AnyRow[]> &
			Record<string, () => unknown>;
		p.from = step;
		p.where = step;
		p.orderBy = step;
		p.innerJoin = step;
		p.leftJoin = step;
		p.limit = step;
		return p;
	};
	return step();
}

function nextSelect() {
	return selectBuilder(state.selectQueue.shift() ?? []);
}

function insertChain() {
	return {
		values(vals: AnyRow | AnyRow[]) {
			const arr = Array.isArray(vals) ? vals : [vals];
			state.inserted.push({ values: arr });
			const chain = {
				onConflictDoNothing: () => chain,
				returning: () => Promise.resolve(state.insertReturning),
			};
			return chain;
		},
	};
}

function updateChain() {
	return {
		set(vals: AnyRow) {
			state.updated.push(vals);
			return {
				where: () => {
					const p = Promise.resolve(state.updateReturning) as Promise<
						AnyRow[]
					> & {
						returning: () => Promise<AnyRow[]>;
					};
					p.returning = () => Promise.resolve(state.updateReturning);
					return p;
				},
			};
		},
	};
}

const fakeDb = {
	select: () => nextSelect(),
	insert: () => insertChain(),
	update: () => updateChain(),
	delete: () => ({ where: () => Promise.resolve() }),
	transaction: <T>(fn: (tx: typeof fakeDb) => Promise<T>) => fn(fakeDb),
	query: {
		roxBalances: {
			findFirst: () => Promise.resolve(state.balanceRow),
		},
	},
} as typeof fakeDb & { query: { roxBalances: { findFirst: () => unknown } } };

// Mutable balance row the economy `ensureBalance` helper reads.
(state as unknown as { balanceRow: AnyRow | undefined }).balanceRow = {
	balanceRox: "500",
};

mock.module("@rox/db/client", () => ({ db: fakeDb, dbWs: fakeDb }));
mock.module("../integration/utils", () => ({
	verifyOrgMembership: () => Promise.resolve(),
	verifyOrgMembershipWithSubscription: () =>
		Promise.resolve({ subscription: null }),
}));

const { mailRouter, setMailSendFnForTest } = await import("./index");
const { setDriveStorageForTest } = await import("../drive/storage");
const { createTRPCRouter, createCallerFactory } = await import("../../trpc");

// Minimal storage provider stub for the M5 presign procedures.
const fakeStorage = {
	presignGet: async (p: { key: string }) => ({
		url: `https://r2.test/${p.key}?sig=x`,
		expiresAt: new Date(Date.now() + 300_000),
	}),
	// biome-ignore lint/suspicious/noExplicitAny: only presignGet is exercised
} as any;

const appRouter = createTRPCRouter({ mail: mailRouter });
const createCaller = createCallerFactory(appRouter);

function callerFor(activeOrganizationId: string | null, userId = "user-1") {
	return createCaller({
		session: {
			user: { id: userId, email: "dev@rox.one" },
			session: { activeOrganizationId },
		},
		headers: new Headers(),
		// biome-ignore lint/suspicious/noExplicitAny: minimal test ctx
	} as any);
}

const THREAD_ID = "11111111-1111-4111-8111-111111111111";
const MSG_ID = "22222222-2222-4222-8222-222222222222";

beforeEach(() => {
	state.selectQueue = [];
	state.inserted = [];
	state.insertReturning = [{ id: "new-id" }];
	state.updated = [];
	state.updateReturning = [{ id: "msg-1" }];
	(state as unknown as { balanceRow: AnyRow | undefined }).balanceRow = {
		balanceRox: "500",
	};
	setMailSendFnForTest(undefined);
	setDriveStorageForTest(undefined);
});

describe("mail.getMailbox", () => {
	test("requires an active organization", async () => {
		const caller = callerFor(null);
		await expect(caller.mail.getMailbox()).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("returns the provisioned primary address without writing", async () => {
		state.selectQueue = [
			[{ id: "addr-1", address: "mark@rox.one", status: "active" }],
		];
		const caller = callerFor("org-1");
		const res = await caller.mail.getMailbox();
		expect(res.address?.address).toBe("mark@rox.one");
		expect(state.inserted).toHaveLength(0);
	});
});

describe("mail.provisionAddress", () => {
	test("requires an active organization", async () => {
		const caller = callerFor(null);
		await expect(caller.mail.provisionAddress({})).rejects.toMatchObject({
			code: "FORBIDDEN",
		});
	});

	test("provisions <handle>@rox.one from an explicit handle", async () => {
		state.selectQueue = [
			[], // global reservation lookup → free
		];
		state.insertReturning = [{ id: "addr-1", address: "mark@rox.one" }];
		const caller = callerFor("org-1");
		const res = await caller.mail.provisionAddress({ handle: "Mark" });
		expect(res?.address).toBe("mark@rox.one");
		expect(state.inserted[0]?.values[0]?.address).toBe("mark@rox.one");
	});

	test("refuses an address already reserved by another user", async () => {
		state.selectQueue = [[{ id: "addr-x", userId: "someone-else" }]];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.provisionAddress({ handle: "taken" }),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});

describe("mail.getThread", () => {
	test("404s when the thread is not owned by the caller", async () => {
		state.selectQueue = [[]]; // getOwnedThread → empty
		const caller = callerFor("org-1");
		await expect(
			caller.mail.getThread({ threadId: THREAD_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("returns thread + messages for the owner", async () => {
		state.selectQueue = [
			[{ id: THREAD_ID, organizationId: "org-1", ownerUserId: "user-1" }],
			[{ id: MSG_ID, subject: "hi" }],
		];
		const caller = callerFor("org-1");
		const res = await caller.mail.getThread({ threadId: THREAD_ID });
		expect(res.thread.id).toBe(THREAD_ID);
		expect(res.messages).toHaveLength(1);
	});
});

describe("mail.send", () => {
	test("requires an active organization", async () => {
		const caller = callerFor(null);
		await expect(
			caller.mail.send({ to: ["a@example.com"], body: "hi" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("blocks when the Rox balance is non-positive", async () => {
		(state as unknown as { balanceRow: AnyRow | undefined }).balanceRow = {
			balanceRox: "0",
		};
		const caller = callerFor("org-1");
		await expect(
			caller.mail.send({ to: ["a@example.com"], body: "hi" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("rejects with TOO_MANY_REQUESTS when the per-user send rate is exceeded", async () => {
		setMailSendFnForTest(async () => ({ id: "evt" }));
		state.selectQueue = [
			[{ n: 999 }], // rate-cap count → over the cap
		];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.send({ to: ["a@example.com"], body: "hi" }),
		).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
	});

	test("fails with PRECONDITION_FAILED when the mailbox is not provisioned", async () => {
		setMailSendFnForTest(async () => ({ id: "evt" }));
		state.selectQueue = [
			[{ n: 0 }], // rate-cap count
			[], // getPrimaryAddress → none
		];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.send({ to: ["a@example.com"], body: "hi" }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("blocks a disabled (suppressed) mailbox from sending", async () => {
		setMailSendFnForTest(async () => ({ id: "evt" }));
		state.selectQueue = [
			[{ n: 0 }], // rate-cap count
			[{ id: "addr-1", address: "mark@rox.one", status: "disabled" }],
		];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.send({ to: ["a@example.com"], body: "hi" }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("fails with PRECONDITION_FAILED when outbound is not configured", async () => {
		setMailSendFnForTest(null); // simulate no MAIL_OUTBOUND_ENABLED / key
		state.selectQueue = [
			[{ n: 0 }], // rate-cap count
			[{ id: "addr-1", address: "mark@rox.one", status: "active" }],
		];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.send({ to: ["a@example.com"], body: "hi" }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("happy path: sends From <handle>@rox.one, persists an outbound row, and debits the ledger", async () => {
		const sent: { from: string; to: string[] }[] = [];
		setMailSendFnForTest(async (payload) => {
			sent.push({ from: payload.from, to: payload.to });
			return { id: "resend-evt-1" };
		});
		state.selectQueue = [
			[{ n: 0 }], // rate-cap count
			[{ id: "addr-1", address: "mark@rox.one", status: "active" }],
		];
		state.insertReturning = [{ id: "out-msg-1" }];
		const caller = callerFor("org-1");
		const res = await caller.mail.send({
			to: ["alice@example.com"],
			subject: "Hi",
			body: "Hello",
		});
		expect(res.messageId).toBe("out-msg-1");
		expect(res.providerId).toBe("resend-evt-1");
		expect(sent[0]?.from).toBe("mark@rox.one");
		expect(sent[0]?.to).toEqual(["alice@example.com"]);
		// An outbound mail_messages row + a mail_send ledger debit were written.
		const outbound = state.inserted.find(
			(i) => i.values[0]?.direction === "outbound",
		)?.values[0];
		expect(outbound?.direction).toBe("outbound");
		expect(outbound?.provider).toBe("resend");
		const ledger = state.inserted.find((i) => i.values[0]?.kind === "mail_send")
			?.values[0];
		expect(ledger?.kind).toBe("mail_send");
		expect(ledger?.deltaRox).toBe("-1");
		// The balance was decremented (the gate is no longer a no-op).
		expect(state.updated.some((u) => "balanceRox" in u)).toBe(true);
		// M6: the outbound mail was emitted into the D1 unified inbox.
		const commsEmit = state.inserted.find(
			(i) =>
				i.values[0]?.transport === "email" &&
				i.values[0]?.direction === "outbound",
		)?.values[0];
		expect(commsEmit).toBeDefined();
		expect(commsEmit?.authorUserId).toBe("user-1");
		// Outbound comms rows carry NO external_id (so they never collide with an
		// inbound RFC Message-ID on the global unique).
		expect(commsEmit?.externalId).toBeNull();

		// FIX 1: the SENDER (mailbox owner) is inserted as a comms_participant so the
		// outbound thread is participant-scoped visible + SSE-forwardable. Identified
		// by a row carrying `role` + the author's userId (no transport column).
		const participantInsert = state.inserted.find(
			(i) =>
				i.values[0]?.role === "member" &&
				i.values[0]?.userId === "user-1" &&
				!("transport" in (i.values[0] ?? {})),
		)?.values;
		expect(participantInsert).toBeDefined();
		expect(participantInsert?.[0]?.userId).toBe("user-1");
	});

	test("FIX 1: an internal rox recipient is added as a thread participant", async () => {
		setMailSendFnForTest(async () => ({ id: "resend-evt-x" }));
		state.selectQueue = [
			[{ n: 0 }], // rate-cap count
			[{ id: "addr-1", address: "mark@rox.one", status: "active" }], // primary
			[], // emitOutbound: thread by dedup → none → create
			[{ userId: "user-bob" }], // resolveRoxRecipientUserIds → internal rox user
		];
		state.insertReturning = [{ id: "out-msg-1" }];
		const caller = callerFor("org-1");
		await caller.mail.send({ to: ["bob@rox.one"], body: "hi bob" });

		// Both the sender (user-1) and the resolved internal recipient (user-bob)
		// become participants, so the conversation surfaces for both parties.
		const participantRows = state.inserted
			.filter((i) => i.values[0]?.role === "member")
			.flatMap((i) => i.values.map((v) => v.userId));
		expect(participantRows).toContain("user-1");
		expect(participantRows).toContain("user-bob");
	});

	test("reply derives References server-side from the parent and bumps message_count", async () => {
		setMailSendFnForTest(async () => ({ id: "resend-evt-2" }));
		const THREAD = "33333333-3333-4333-8333-333333333333";
		state.selectQueue = [
			[{ n: 0 }], // rate-cap count
			[{ id: "addr-1", address: "mark@rox.one", status: "active" }], // primary
			[{ id: THREAD, organizationId: "org-1", ownerUserId: "user-1" }], // getOwnedThread
			[
				{
					rfcMessageId: "<parent@rox.one>",
					inReplyTo: null,
					referencesIds: ["<root@rox.one>"],
				},
			], // parent message
		];
		state.insertReturning = [{ id: "reply-msg-1" }];
		const caller = callerFor("org-1");
		await caller.mail.send({
			to: ["alice@example.com"],
			body: "reply",
			threadId: THREAD,
			// Client lies about references — server must ignore and derive its own.
			references: ["<spoofed@evil.test>"],
		});
		const outbound = state.inserted.find(
			(i) => i.values[0]?.direction === "outbound",
		)?.values[0];
		expect(outbound?.referencesIds).toEqual([
			"<root@rox.one>",
			"<parent@rox.one>",
		]);
		expect(outbound?.inReplyTo).toBe("<parent@rox.one>");
		// message_count bump used a SQL expression on the thread update.
		expect(state.updated.some((u) => "messageCount" in u)).toBe(true);
	});
});

describe("mail.markRead", () => {
	test("404s when no owned message matches", async () => {
		state.updateReturning = [];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.markRead({ messageId: MSG_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("marks an owned message read", async () => {
		state.updateReturning = [{ id: MSG_ID }];
		const caller = callerFor("org-1");
		const res = await caller.mail.markRead({ messageId: MSG_ID });
		expect(res.ok).toBe(true);
		expect(state.updated[0]?.isRead).toBe(true);
	});
});

describe("mail.getAttachmentUrl (M5)", () => {
	const ATT_ID = "44444444-4444-4444-8444-444444444444";

	test("PRECONDITION_FAILED when storage is unconfigured", async () => {
		setDriveStorageForTest(null);
		const caller = callerFor("org-1");
		await expect(
			caller.mail.getAttachmentUrl({ attachmentId: ATT_ID }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("404s when the attachment is not owned by the caller", async () => {
		setDriveStorageForTest(fakeStorage);
		state.selectQueue = [[]]; // owner-scoped join → none
		const caller = callerFor("org-1");
		await expect(
			caller.mail.getAttachmentUrl({ attachmentId: ATT_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("returns a short-TTL presigned URL for an owned attachment", async () => {
		setDriveStorageForTest(fakeStorage);
		state.selectQueue = [[{ blobKey: "u/user-1/abc", filename: "a.pdf" }]];
		const caller = callerFor("org-1");
		const res = await caller.mail.getAttachmentUrl({ attachmentId: ATT_ID });
		expect(res.url).toContain("u/user-1/abc");
		expect(res.expiresAt).toBeInstanceOf(Date);
	});
});

describe("mail.getBodyUrl (M5)", () => {
	test("404s when the message has no stored body for the variant", async () => {
		setDriveStorageForTest(fakeStorage);
		state.selectQueue = [[{ bodyTextKey: null, bodyHtmlKey: null }]];
		const caller = callerFor("org-1");
		await expect(
			caller.mail.getBodyUrl({ messageId: MSG_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("returns a presigned URL for the text body by default", async () => {
		setDriveStorageForTest(fakeStorage);
		state.selectQueue = [
			[{ bodyTextKey: "u/user-1/body.txt", bodyHtmlKey: "u/user-1/body.html" }],
		];
		const caller = callerFor("org-1");
		const res = await caller.mail.getBodyUrl({ messageId: MSG_ID });
		expect(res.url).toContain("body.txt");
	});

	test("returns the html body when variant=html", async () => {
		setDriveStorageForTest(fakeStorage);
		state.selectQueue = [
			[{ bodyTextKey: "u/user-1/body.txt", bodyHtmlKey: "u/user-1/body.html" }],
		];
		const caller = callerFor("org-1");
		const res = await caller.mail.getBodyUrl({
			messageId: MSG_ID,
			variant: "html",
		});
		expect(res.url).toContain("body.html");
	});
});
