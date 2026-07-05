import { beforeEach, describe, expect, mock, test } from "bun:test";

/**
 * Drive router tests (W2-DRIVE T5).
 *
 * Mirrors the env-free trpc test harness (dashboard.test.ts / economy.test.ts):
 * stubs `@rox/db/client` so no live DB is needed, and injects a MOCKED storage
 * provider via the storage seam so no R2 credentials are required. Covers the
 * upload→confirm→download flow, dedup, quota soft-meter (DQ2), shares with
 * password + expiry, and the public resolver.
 */

type AnyRow = Record<string, unknown>;

// Read a drizzle pgTable's name off its `Symbol(drizzle:Name)` symbol.
function tableName(table: unknown): string {
	if (!table || typeof table !== "object") return "";
	const sym = Object.getOwnPropertySymbols(table).find(
		(s) => s.description === "drizzle:Name",
	);
	return sym ? String((table as Record<symbol, unknown>)[sym]) : "";
}

function lastInsertInto(name: string): AnyRow | undefined {
	for (let i = state.inserted.length - 1; i >= 0; i--) {
		if (state.inserted[i]?.table === name) return state.inserted[i]?.values;
	}
	return undefined;
}

// --- DB stub ---------------------------------------------------------------
// A queue-driven fake. `selectQueue` feeds successive `db.select()` chains;
// `insertReturning` feeds the next insert's `.returning()`. `updateReturning`
// feeds `.update().set().where().returning()`. Atomic conditional UPDATE
// (commitUpload) reads `conditionalUpdateRows`.

const state: {
	selectQueue: AnyRow[][];
	insertReturning: AnyRow[];
	updateReturning: AnyRow[];
	conditionalUpdateRows: AnyRow[];
	inserted: { table: string; values: AnyRow }[];
	updated: AnyRow[];
	deleteCalls: number;
	quotaRow: AnyRow | undefined;
	transactionRan: number;
} = {
	selectQueue: [],
	insertReturning: [{ id: "new-id" }],
	updateReturning: [{ id: "new-id" }],
	conditionalUpdateRows: [{ bytesUsed: 1 }],
	inserted: [],
	updated: [],
	deleteCalls: 0,
	quotaRow: undefined,
	transactionRan: 0,
};

function nextSelect(): AnyRow[] {
	return state.selectQueue.shift() ?? [];
}

// Chainable select builder: any terminal (.where/.orderBy/.limit) resolves to
// the queued rows.
function selectBuilder() {
	const rows = nextSelect();
	const step = (): Promise<AnyRow[]> & Record<string, () => unknown> => {
		const p = Promise.resolve(rows) as Promise<AnyRow[]> &
			Record<string, () => unknown>;
		p.from = step;
		p.where = step;
		p.orderBy = step;
		p.limit = step;
		p.innerJoin = step;
		p.leftJoin = step;
		return p;
	};
	return step();
}

// `.update().set().where()` may either await directly, chain `.returning()`, or
// be the conditional commit (returns conditionalUpdateRows). We make `where`
// return a thenable that also carries `.returning()`.
function makeDb() {
	const dbObj: AnyRow = {
		select: () => selectBuilder(),
		insert: (table: unknown) => ({
			values: (vals: AnyRow) => {
				state.inserted.push({ table: tableName(table), values: vals });
				const chain: AnyRow = {
					returning: () => Promise.resolve(state.insertReturning),
					onConflictDoNothing: () => chain,
					onConflictDoUpdate: () => chain,
				};
				return chain;
			},
		}),
		update: () => ({
			set: (vals: AnyRow) => {
				state.updated.push(vals);
				const whereResult = Promise.resolve(
					state.conditionalUpdateRows,
				) as Promise<AnyRow[]> & { returning?: () => Promise<AnyRow[]> };
				whereResult.returning = () => Promise.resolve(state.updateReturning);
				return { where: () => whereResult };
			},
		}),
		delete: () => ({
			where: () => {
				state.deleteCalls += 1;
				return Promise.resolve();
			},
		}),
		query: {
			storageQuota: {
				findFirst: () => Promise.resolve(state.quotaRow),
			},
			roxBalances: {
				findFirst: () => Promise.resolve(undefined),
			},
		},
		transaction: async (fn: (tx: AnyRow) => Promise<unknown>) => {
			state.transactionRan += 1;
			return fn(dbObj);
		},
	};
	return dbObj;
}

const fakeDb = makeDb();
mock.module("@rox/db/client", () => ({ db: fakeDb, dbWs: fakeDb }));

// --- imports (after mocks) -------------------------------------------------
const { driveRouter } = await import("./drive");
const { setDriveStorageForTest } = await import("./storage");
const { createTRPCRouter, createCallerFactory } = await import("../../trpc");

const appRouter = createTRPCRouter({ drive: driveRouter });
const createCaller = createCallerFactory(appRouter);

function authedCaller() {
	return createCaller({
		session: {
			user: { id: "user-1", email: "dev@rox.one" },
			session: { activeOrganizationId: null },
		},
		headers: new Headers(),
		// biome-ignore lint/suspicious/noExplicitAny: minimal test ctx
	} as any);
}

function anonCaller() {
	return createCaller({
		session: null,
		headers: new Headers(),
		// biome-ignore lint/suspicious/noExplicitAny: minimal test ctx
	} as any);
}

// A mocked StorageProvider recording its calls.
function mockStorage() {
	const calls: { method: string; arg: unknown }[] = [];
	return {
		calls,
		provider: {
			kind: "r2" as const,
			presignPut: async (arg: unknown) => {
				calls.push({ method: "presignPut", arg });
				return { url: "https://r2/put", expiresAt: new Date(Date.now() + 1e5) };
			},
			presignGet: async (arg: unknown) => {
				calls.push({ method: "presignGet", arg });
				return { url: "https://r2/get", expiresAt: new Date(Date.now() + 1e5) };
			},
			head: async (arg: unknown) => {
				calls.push({ method: "head", arg });
				return { contentLength: 100 };
			},
			delete: async (arg: unknown) => {
				calls.push({ method: "delete", arg });
			},
			copy: async () => {},
		},
	};
}

const FILE_ID = "11111111-1111-4111-8111-111111111111";
const _FOLDER_ID = "22222222-2222-4222-8222-222222222222";
const SHARE_ID = "33333333-3333-4333-8333-333333333333";
const SHA = "a".repeat(64);

const CAP = 10_737_418_240;

beforeEach(() => {
	state.selectQueue = [];
	state.insertReturning = [{ id: "new-id" }];
	state.updateReturning = [{ id: "new-id" }];
	state.conditionalUpdateRows = [{ bytesUsed: 1 }];
	state.inserted = [];
	state.updated = [];
	state.deleteCalls = 0;
	state.quotaRow = { bytesUsed: 0, quotaBytes: CAP, overageOptIn: false };
	state.transactionRan = 0;
	setDriveStorageForTest(undefined);
});

describe("auth", () => {
	test("listFolder requires a session", async () => {
		await expect(anonCaller().drive.listFolder()).rejects.toMatchObject({
			code: "UNAUTHORIZED",
		});
	});
});

describe("drive.quota", () => {
	test("returns the seeded quota snapshot", async () => {
		const res = await authedCaller().drive.quota();
		expect(res.quotaBytes).toBe(CAP);
		expect(res.bytesUsed).toBe(0);
		expect(res.overageOptIn).toBe(false);
	});
});

describe("drive.createFolder", () => {
	test("inserts a user-scoped folder", async () => {
		state.insertReturning = [{ id: "folder-new" }];
		const res = await authedCaller().drive.createFolder({ name: "Docs" });
		expect(res?.id).toBe("folder-new");
		const folder = lastInsertInto("drive_folders");
		expect(folder?.userId).toBe("user-1");
		expect(folder?.name).toBe("Docs");
	});
});

describe("drive.organizeFolder", () => {
	test("reports an empty folder without creating folders", async () => {
		state.selectQueue = [[]];
		const res = await authedCaller().drive.organizeFolder();
		expect(res.ok).toBe(true);
		expect(res.movedCount).toBe(0);
		expect(res.createdFolderCount).toBe(0);
		expect(state.inserted).toHaveLength(0);
	});

	test("creates a type folder and moves current-folder files into it", async () => {
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					name: "brief.pdf",
					mediaType: "application/pdf",
					folderId: null,
					trashedAt: null,
				},
			],
			[],
		];
		state.insertReturning = [{ id: "folder-docs", name: "Документы" }];

		const res = await authedCaller().drive.organizeFolder();

		expect(res.ok).toBe(true);
		expect(res.movedCount).toBe(1);
		expect(res.createdFolderCount).toBe(1);
		expect(res.targets).toEqual([
			{ key: "documents", folderId: "folder-docs", folderName: "Документы" },
		]);
		expect(lastInsertInto("drive_folders")?.name).toBe("Документы");
		expect(state.updated).toContainEqual({ folderId: "folder-docs" });
	});
});

describe("drive.requestUpload", () => {
	test("fails cleanly when R2 is unconfigured (null provider)", async () => {
		setDriveStorageForTest(null);
		await expect(
			authedCaller().drive.requestUpload({
				filename: "a.bin",
				mediaType: "application/octet-stream",
				sizeBytes: 10,
				sha256: SHA,
			}),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
	});

	test("presigns a PUT and creates a pending row", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		// selects: ensureQuota.findFirst is on db.query (not select); dedup select.
		state.selectQueue = [[]]; // dedup lookup → none
		state.insertReturning = [{ id: "file-new" }];
		const res = await authedCaller().drive.requestUpload({
			filename: "a.bin",
			mediaType: "application/octet-stream",
			sizeBytes: 10,
			sha256: SHA,
		});
		expect(res.dedup).toBe(false);
		expect(res.fileId).toBe("file-new");
		expect(res.upload?.url).toBe("https://r2/put");
		expect(s.calls.some((c) => c.method === "presignPut")).toBe(true);
		// content-addressed key scheme u/<userId>/<sha256>
		expect(res.storageKey).toBe(`u/user-1/${SHA}`);
		expect(lastInsertInto("drive_files")?.status).toBe("pending");
	});

	test("dedup short-circuits when the content already exists", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [[{ id: "existing-file", status: "clean" }]];
		const res = await authedCaller().drive.requestUpload({
			filename: "dup.bin",
			mediaType: "application/octet-stream",
			sizeBytes: 10,
			sha256: SHA,
		});
		expect(res.dedup).toBe(true);
		expect(res.fileId).toBe("existing-file");
		expect(res.upload).toBeNull();
		expect(s.calls.some((c) => c.method === "presignPut")).toBe(false);
	});

	test("blocks an over-quota upload when overage is off", async () => {
		setDriveStorageForTest(mockStorage().provider);
		state.quotaRow = { bytesUsed: CAP, quotaBytes: CAP, overageOptIn: false };
		await expect(
			authedCaller().drive.requestUpload({
				filename: "big.bin",
				mediaType: "application/octet-stream",
				sizeBytes: 1_000,
				sha256: SHA,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("allows an over-quota upload when overage is on (soft-meter DQ2)", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.quotaRow = { bytesUsed: CAP, quotaBytes: CAP, overageOptIn: true };
		state.selectQueue = [[]]; // dedup → none
		state.insertReturning = [{ id: "file-over" }];
		const res = await authedCaller().drive.requestUpload({
			filename: "over.bin",
			mediaType: "application/octet-stream",
			sizeBytes: 1_000,
			sha256: SHA,
		});
		expect(res.dedup).toBe(false);
		expect(res.fileId).toBe("file-over");
	});
});

describe("drive.confirmUpload", () => {
	test("HEAD size mismatch rejects", async () => {
		const s = mockStorage();
		s.provider.head = async () => ({ contentLength: 999 });
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					status: "pending",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
		];
		await expect(
			authedCaller().drive.confirmUpload({ fileId: FILE_ID }),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});

	test("commits quota and flips status to clean on a size match", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider); // head returns contentLength 100
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					status: "pending",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
		];
		state.quotaRow = { bytesUsed: 0, quotaBytes: CAP, overageOptIn: false };
		state.conditionalUpdateRows = [{ bytesUsed: 100 }]; // commit applied
		// claim (pending→scanning) + final flip both read updateReturning; the
		// final flip carries the scan verdict (D3 + D5).
		state.updateReturning = [{ id: FILE_ID, status: "clean" }];
		const res = await authedCaller().drive.confirmUpload({ fileId: FILE_ID });
		expect(res.ok).toBe(true);
		expect(res.alreadyConfirmed).toBe(false);
		expect(res.file?.status).toBe("clean");
		expect(res.status).toBe("clean");
	});

	test("a confirm that loses the atomic claim race commits nothing (D3)", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			// getOwnedFile (initial read)
			[
				{
					id: FILE_ID,
					userId: "user-1",
					status: "pending",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
			// getOwnedFile re-read after losing the claim
			[
				{
					id: FILE_ID,
					userId: "user-1",
					status: "clean",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
		];
		state.quotaRow = { bytesUsed: 0, quotaBytes: CAP, overageOptIn: false };
		state.updateReturning = []; // claim UPDATE matched 0 rows → lost the race
		const res = await authedCaller().drive.confirmUpload({ fileId: FILE_ID });
		expect(res.alreadyConfirmed).toBe(true);
		expect(res.file?.status).toBe("clean");
		// only the claim attempt ran a set(); no commit/flip → no double count
		expect(state.updated).toHaveLength(1);
	});

	test("blocks confirm when the conditional quota UPDATE loses (cap exceeded)", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					status: "pending",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
		];
		state.quotaRow = {
			bytesUsed: CAP - 50,
			quotaBytes: CAP,
			overageOptIn: false,
		};
		state.conditionalUpdateRows = []; // conditional UPDATE matched 0 rows
		await expect(
			authedCaller().drive.confirmUpload({ fileId: FILE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});
});

describe("drive.requestDownload", () => {
	test("presigns a GET for an owned file", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					name: "a.bin",
					storageKey: "k",
					status: "clean",
				},
			],
		];
		const res = await authedCaller().drive.requestDownload({ fileId: FILE_ID });
		expect(res.url).toBe("https://r2/get");
		expect(s.calls.some((c) => c.method === "presignGet")).toBe(true);
	});

	test("withholds a non-clean (quarantined) file (D5)", async () => {
		setDriveStorageForTest(mockStorage().provider);
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					name: "bad.bin",
					storageKey: "k",
					status: "quarantined",
				},
			],
		];
		await expect(
			authedCaller().drive.requestDownload({ fileId: FILE_ID }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	test("404s for a file the user does not own", async () => {
		setDriveStorageForTest(mockStorage().provider);
		state.selectQueue = [[]];
		await expect(
			authedCaller().drive.requestDownload({ fileId: FILE_ID }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});
});

describe("drive.deleteFile", () => {
	test("reclaims quota + deletes the object when it was the last reference", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			// getOwnedFile
			[
				{
					id: FILE_ID,
					userId: "user-1",
					sha256: SHA,
					status: "clean",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
			// drive_file_refs lookup → none (D4: no attachment ref)
			[],
			// remaining-refs lookup → none
			[],
		];
		state.quotaRow = { bytesUsed: 100, quotaBytes: CAP, overageOptIn: false };
		const res = await authedCaller().drive.deleteFile({ fileId: FILE_ID });
		expect(res.ok).toBe(true);
		expect(res.softTrashed).toBe(false);
		expect(state.deleteCalls).toBe(1);
		expect(s.calls.some((c) => c.method === "delete")).toBe(true);
	});

	test("keeps the object when another row still references the content (dedup)", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			[
				{
					id: FILE_ID,
					userId: "user-1",
					sha256: SHA,
					status: "clean",
					sizeBytes: 100,
					storageKey: "k",
				},
			],
			[], // drive_file_refs lookup → none
			[{ id: "other-file" }], // remaining ref exists
		];
		const res = await authedCaller().drive.deleteFile({ fileId: FILE_ID });
		expect(res.ok).toBe(true);
		expect(s.calls.some((c) => c.method === "delete")).toBe(false);
	});

	test("soft-trashes (no hard delete) when an attachment ref exists (D4)", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			// getOwnedFile
			[
				{
					id: FILE_ID,
					userId: "user-1",
					sha256: SHA,
					status: "clean",
					sizeBytes: 100,
					storageKey: "k",
					trashedAt: null,
				},
			],
			// drive_file_refs lookup → a live ref
			[{ id: "ref-1" }],
		];
		const res = await authedCaller().drive.deleteFile({ fileId: FILE_ID });
		expect(res.ok).toBe(true);
		expect(res.softTrashed).toBe(true);
		// no hard delete, no object delete, no quota reclaim
		expect(state.deleteCalls).toBe(0);
		expect(s.calls.some((c) => c.method === "delete")).toBe(false);
		// the soft-trash UPDATE set trashedAt
		expect(state.updated.some((u) => u.trashedAt instanceof Date)).toBe(true);
	});
});

describe("drive.attachToMessage / detachFromMessage (D4)", () => {
	test("attachToMessage records a ref for an owned file", async () => {
		state.selectQueue = [[{ id: FILE_ID, userId: "user-1" }]]; // getOwnedFile
		const res = await authedCaller().drive.attachToMessage({
			fileId: FILE_ID,
			sourceKind: "chat_message",
			sourceId: "44444444-4444-4444-8444-444444444444",
		});
		expect(res.ok).toBe(true);
		const ref = lastInsertInto("drive_file_refs");
		expect(ref?.fileId).toBe(FILE_ID);
		expect(ref?.sourceKind).toBe("chat_message");
	});

	test("attachToMessage 404s for a file the user does not own", async () => {
		state.selectQueue = [[]]; // getOwnedFile → none
		await expect(
			authedCaller().drive.attachToMessage({
				fileId: FILE_ID,
				sourceKind: "email_message",
				sourceId: "44444444-4444-4444-8444-444444444444",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("detachFromMessage drops the ref for an owned file", async () => {
		state.selectQueue = [[{ id: FILE_ID, userId: "user-1" }]]; // getOwnedFile
		const res = await authedCaller().drive.detachFromMessage({
			fileId: FILE_ID,
			sourceKind: "chat_message",
			sourceId: "44444444-4444-4444-8444-444444444444",
		});
		expect(res.ok).toBe(true);
		expect(state.deleteCalls).toBe(1);
	});
});

describe("drive.setOverageOptIn (D1)", () => {
	test("flips the overage flag and returns the snapshot", async () => {
		state.quotaRow = { bytesUsed: 0, quotaBytes: CAP, overageOptIn: true };
		const res = await authedCaller().drive.setOverageOptIn({ optIn: true });
		expect(res.overageOptIn).toBe(true);
	});
});

describe("drive.requestUpload MIME allow-list (D5)", () => {
	test("rejects a blocked executable media type", async () => {
		setDriveStorageForTest(mockStorage().provider);
		await expect(
			authedCaller().drive.requestUpload({
				filename: "evil.exe",
				mediaType: "application/x-msdownload",
				sizeBytes: 10,
				sha256: SHA,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
	});
});

describe("drive.requestUpload conflict fallback (D7)", () => {
	test("falls back to the existing row when the insert conflicts", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			[], // dedup lookup → none (status clean)
			[{ id: "conflicting-row" }], // post-conflict fallback select
		];
		state.insertReturning = []; // ON CONFLICT DO NOTHING → no row
		const res = await authedCaller().drive.requestUpload({
			filename: "race.bin",
			mediaType: "application/octet-stream",
			sizeBytes: 10,
			sha256: SHA,
		});
		expect(res.dedup).toBe(false);
		expect(res.fileId).toBe("conflicting-row");
	});
});

describe("drive.createShare", () => {
	test("rejects when neither file nor folder is given", async () => {
		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: deliberate bad input
			authedCaller().drive.createShare({} as any),
		).rejects.toThrow();
	});

	test("creates a file share with a generated token + hashed password", async () => {
		setDriveStorageForTest(mockStorage().provider);
		state.selectQueue = [[{ id: FILE_ID, userId: "user-1", status: "clean" }]]; // getOwnedFile
		state.insertReturning = [{ id: SHARE_ID, token: "tok" }];
		const res = await authedCaller().drive.createShare({
			fileId: FILE_ID,
			password: "hunter2",
			expiresInSeconds: 3600,
		});
		expect(res?.id).toBe(SHARE_ID);
		const vals = lastInsertInto("drive_shares");
		expect(vals?.userId).toBe("user-1");
		expect(typeof vals?.token).toBe("string");
		expect((vals?.token as string).length).toBeGreaterThanOrEqual(22);
		expect(typeof vals?.passwordHash).toBe("string");
		expect((vals?.passwordHash as string).startsWith("scrypt$")).toBe(true);
		expect(vals?.expiresAt).toBeInstanceOf(Date);
	});

	test("rejects a clean file share when object storage is unconfigured", async () => {
		setDriveStorageForTest(null);
		state.selectQueue = [[{ id: FILE_ID, userId: "user-1", status: "clean" }]];

		await expect(
			authedCaller().drive.createShare({ fileId: FILE_ID }),
		).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

		expect(state.inserted).toHaveLength(0);
	});

	test("rejects a non-clean file share instead of minting a dead link", async () => {
		setDriveStorageForTest(mockStorage().provider);
		state.selectQueue = [
			[{ id: FILE_ID, userId: "user-1", status: "scanning" }],
		];

		await expect(
			authedCaller().drive.createShare({ fileId: FILE_ID }),
		).rejects.toMatchObject({
			code: "PRECONDITION_FAILED",
			message: "This file is still being processed and cannot be shared yet.",
		});

		expect(state.inserted).toHaveLength(0);
	});

	test("creates a folder share without object storage", async () => {
		setDriveStorageForTest(null);
		state.selectQueue = [[{ id: _FOLDER_ID, userId: "user-1" }]];
		state.insertReturning = [{ id: SHARE_ID, token: "folder-tok" }];

		const res = await authedCaller().drive.createShare({
			folderId: _FOLDER_ID,
		});

		expect(res?.id).toBe(SHARE_ID);
		const vals = lastInsertInto("drive_shares");
		expect(vals?.folderId).toBe(_FOLDER_ID);
		expect(vals?.fileId).toBeNull();
	});
});

describe("drive.resolveShare (public)", () => {
	test("404s for an unknown / revoked token", async () => {
		state.selectQueue = [[]];
		await expect(
			anonCaller().drive.resolveShare({ token: "nope" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("rejects an expired share", async () => {
		state.selectQueue = [
			[
				{
					id: SHARE_ID,
					token: "t",
					expiresAt: new Date(Date.now() - 1000),
					viewCount: 0,
				},
			],
		];
		await expect(
			anonCaller().drive.resolveShare({ token: "t" }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	test("requires the correct password", async () => {
		const { hashSharePassword } = await import("./password");
		const hash = await hashSharePassword("secret");
		state.selectQueue = [
			[
				{
					id: SHARE_ID,
					token: "t",
					passwordHash: hash,
					viewCount: 0,
					fileId: FILE_ID,
				},
			],
		];
		await expect(
			anonCaller().drive.resolveShare({ token: "t", password: "wrong" }),
		).rejects.toMatchObject({ code: "UNAUTHORIZED" });
	});

	test("returns a short-TTL presigned GET for a valid file share", async () => {
		const s = mockStorage();
		setDriveStorageForTest(s.provider);
		state.selectQueue = [
			// share lookup
			[
				{
					id: SHARE_ID,
					token: "t",
					viewCount: 2,
					fileId: FILE_ID,
					permission: "view",
				},
			],
			// file lookup
			[
				{
					id: FILE_ID,
					name: "doc.pdf",
					mediaType: "application/pdf",
					sizeBytes: 100,
					status: "clean",
					storageKey: "k",
				},
			],
		];
		const res = await anonCaller().drive.resolveShare({ token: "t" });
		expect(res.kind).toBe("file");
		expect(res.download?.url).toBe("https://r2/get");
		// view_count incremented
		expect(state.updated.some((u) => u.viewCount === 3)).toBe(true);
	});
});
