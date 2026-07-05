/**
 * Drive tRPC router (D8 P0, workstream W2-DRIVE).
 *
 * Per-user file storage: a 10 GiB shared quota (DQ2 soft-meter), folders, files,
 * presigned direct upload/download (bytes never proxy through the API), and
 * public `rox.one/d/<token>` shares. Drive is GLOBAL per user (DQ3) — every
 * procedure scopes by `ctx.session.user.id`, never by org.
 *
 * Storage is the R2 provider from `@rox/storage`, resolved through the guarded
 * {@link getDriveStorage} seam: when R2 creds are absent (CI/dev) the
 * provider-dependent procedures fail with a clean `PRECONDITION_FAILED` instead
 * of crashing, and unit tests inject a mocked provider.
 *
 * Upload flow (D8 §2.1):
 *   requestUpload  → quota pre-flight + dedup check → presigned PUT + `pending` row
 *   (client PUTs bytes directly to the bucket)
 *   confirmUpload  → HEAD confirms size → atomic quota commit → flip to `clean`
 *   requestDownload→ presigned GET
 */

import { db } from "@rox/db/client";
import {
	driveFileRefs,
	driveFiles,
	driveFolders,
	driveShares,
	storageQuota,
} from "@rox/db/schema";
import { computeUploadDecision } from "@rox/shared/drive-quota";
import { TRPCError, type TRPCRouterRecord } from "@trpc/server";
import { and, asc, desc, eq, inArray, isNull } from "drizzle-orm";
import { protectedProcedure, publicProcedure } from "../../trpc";
import { hashSharePassword, verifySharePassword } from "./password";
import {
	commitUpload,
	ensureQuota,
	releaseBytes,
	setOverageOptIn,
} from "./quota";
import { isBlockedMediaType, scanObject } from "./scan";
import {
	attachToMessageSchema,
	confirmUploadSchema,
	createFolderSchema,
	createShareSchema,
	deleteFileSchema,
	deleteFolderSchema,
	detachFromMessageSchema,
	listFolderSchema,
	moveFileSchema,
	moveFolderSchema,
	organizeFolderSchema,
	renameFileSchema,
	renameFolderSchema,
	requestDownloadSchema,
	requestUploadSchema,
	resolveShareSchema,
	revokeShareSchema,
	setOverageOptInSchema,
} from "./schema";
import { driveStorageKey, getDriveStorage } from "./storage";
import { generateShareToken } from "./token";

// Presign TTLs (seconds). Short by design (D8 §2.5): uploads 10 min, downloads
// 5 min, share redirects 60 s so a leaked URL expires fast.
const UPLOAD_TTL = 600;
const DOWNLOAD_TTL = 300;
const SHARE_TTL = 60;

const DRIVE_ORGANIZE_CATEGORIES = [
	{
		key: "documents",
		folderName: "Документы",
		matches: (file: { name: string; mediaType: string }) => {
			const ext = getExtension(file.name);
			return (
				file.mediaType.startsWith("text/") ||
				file.mediaType.includes("pdf") ||
				[
					"csv",
					"doc",
					"docx",
					"md",
					"pages",
					"pdf",
					"rtf",
					"txt",
					"xls",
					"xlsx",
				].includes(ext)
			);
		},
	},
	{
		key: "images",
		folderName: "Изображения",
		matches: (file: { mediaType: string }) =>
			file.mediaType.startsWith("image/"),
	},
	{
		key: "media",
		folderName: "Медиа",
		matches: (file: { mediaType: string }) =>
			file.mediaType.startsWith("audio/") ||
			file.mediaType.startsWith("video/"),
	},
	{
		key: "archives",
		folderName: "Архивы",
		matches: (file: { name: string; mediaType: string }) => {
			const ext = getExtension(file.name);
			return (
				file.mediaType.includes("zip") ||
				file.mediaType.includes("gzip") ||
				file.mediaType.includes("tar") ||
				["7z", "gz", "rar", "tar", "tgz", "zip"].includes(ext)
			);
		},
	},
	{
		key: "code",
		folderName: "Код",
		matches: (file: { name: string }) =>
			[
				"css",
				"go",
				"html",
				"java",
				"js",
				"json",
				"jsx",
				"py",
				"rs",
				"sh",
				"sql",
				"ts",
				"tsx",
				"yaml",
				"yml",
			].includes(getExtension(file.name)),
	},
] as const;

function getExtension(name: string) {
	const match = /\.([^.]+)$/.exec(name.trim().toLowerCase());
	return match?.[1] ?? "";
}

function getOrganizeCategory(file: { name: string; mediaType: string }) {
	return (
		DRIVE_ORGANIZE_CATEGORIES.find((category) => category.matches(file)) ?? {
			key: "other" as const,
			folderName: "Прочее",
		}
	);
}

/** Resolve the storage provider or throw a clean error when R2 is unconfigured. */
function requireStorage() {
	const storage = getDriveStorage();
	if (!storage) {
		throw new TRPCError({
			code: "PRECONDITION_FAILED",
			message:
				"Drive object storage is not configured (missing R2 credentials).",
		});
	}
	return storage;
}

async function getOwnedFile(userId: string, fileId: string) {
	const [row] = await db
		.select()
		.from(driveFiles)
		.where(and(eq(driveFiles.id, fileId), eq(driveFiles.userId, userId)))
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
	}
	return row;
}

async function getOwnedFolder(userId: string, folderId: string) {
	const [row] = await db
		.select()
		.from(driveFolders)
		.where(and(eq(driveFolders.id, folderId), eq(driveFolders.userId, userId)))
		.limit(1);
	if (!row) {
		throw new TRPCError({ code: "NOT_FOUND", message: "Folder not found" });
	}
	return row;
}

export const driveRouter = {
	// ---- quota ------------------------------------------------------------
	quota: protectedProcedure.query(async ({ ctx }) => {
		return ensureQuota(ctx.session.user.id);
	}),

	/**
	 * Opt in/out of billed overage (DQ2 soft-meter, finding D1). The ONLY writer
	 * of `overage_opt_in`; without it the flag was stuck false and uploads
	 * hard-blocked at the cap, violating the locked soft-meter decision.
	 */
	setOverageOptIn: protectedProcedure
		.input(setOverageOptInSchema)
		.mutation(async ({ ctx, input }) => {
			return setOverageOptIn(ctx.session.user.id, input.optIn);
		}),

	// ---- folders ----------------------------------------------------------
	listFolder: protectedProcedure
		.input(listFolderSchema)
		.query(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const folderId = input?.folderId ?? null;
			const folders = await db
				.select()
				.from(driveFolders)
				.where(
					and(
						eq(driveFolders.userId, userId),
						folderId === null
							? isNull(driveFolders.parentId)
							: eq(driveFolders.parentId, folderId),
					),
				)
				.orderBy(asc(driveFolders.name));
			const files = await db
				.select()
				.from(driveFiles)
				.where(
					and(
						eq(driveFiles.userId, userId),
						folderId === null
							? isNull(driveFiles.folderId)
							: eq(driveFiles.folderId, folderId),
						isNull(driveFiles.trashedAt),
					),
				)
				.orderBy(desc(driveFiles.createdAt));
			return { folders, files };
		}),

	createFolder: protectedProcedure
		.input(createFolderSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			if (input.parentId) {
				await getOwnedFolder(userId, input.parentId);
			}
			const [row] = await db
				.insert(driveFolders)
				.values({
					userId,
					parentId: input.parentId ?? null,
					name: input.name,
				})
				.returning();
			return row;
		}),

	organizeFolder: protectedProcedure
		.input(organizeFolderSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const folderId = input?.folderId ?? null;

			if (folderId) {
				await getOwnedFolder(userId, folderId);
			}

			const files = await db
				.select()
				.from(driveFiles)
				.where(
					and(
						eq(driveFiles.userId, userId),
						folderId === null
							? isNull(driveFiles.folderId)
							: eq(driveFiles.folderId, folderId),
						isNull(driveFiles.trashedAt),
					),
				);

			if (files.length === 0) {
				return {
					ok: true as const,
					movedCount: 0,
					createdFolderCount: 0,
					targets: [] as {
						key: string;
						folderId: string;
						folderName: string;
					}[],
				};
			}

			const filesByTarget = new Map<
				string,
				{ folderName: string; fileIds: string[] }
			>();

			for (const file of files) {
				const category = getOrganizeCategory({
					name: file.name,
					mediaType: file.mediaType,
				});
				const bucket = filesByTarget.get(category.key) ?? {
					folderName: category.folderName,
					fileIds: [],
				};
				bucket.fileIds.push(file.id);
				filesByTarget.set(category.key, bucket);
			}

			const targetNames = [...filesByTarget.values()].map(
				(target) => target.folderName,
			);
			const existingFolders = await db
				.select()
				.from(driveFolders)
				.where(
					and(
						eq(driveFolders.userId, userId),
						folderId === null
							? isNull(driveFolders.parentId)
							: eq(driveFolders.parentId, folderId),
						inArray(driveFolders.name, targetNames),
					),
				);

			const folderIdsByName = new Map(
				existingFolders.map((folder) => [folder.name, folder.id]),
			);
			let createdFolderCount = 0;

			for (const folderName of targetNames) {
				if (folderIdsByName.has(folderName)) continue;

				const [created] = await db
					.insert(driveFolders)
					.values({
						userId,
						parentId: folderId,
						name: folderName,
					})
					.onConflictDoNothing({
						target: [
							driveFolders.userId,
							driveFolders.parentId,
							driveFolders.name,
						],
					})
					.returning();

				if (created) {
					folderIdsByName.set(folderName, created.id);
					createdFolderCount += 1;
				} else {
					const [existing] = await db
						.select()
						.from(driveFolders)
						.where(
							and(
								eq(driveFolders.userId, userId),
								folderId === null
									? isNull(driveFolders.parentId)
									: eq(driveFolders.parentId, folderId),
								eq(driveFolders.name, folderName),
							),
						)
						.limit(1);
					if (existing) {
						folderIdsByName.set(folderName, existing.id);
					}
				}
			}

			const targets: { key: string; folderId: string; folderName: string }[] =
				[];
			let movedCount = 0;

			for (const [key, target] of filesByTarget) {
				const targetFolderId = folderIdsByName.get(target.folderName);
				if (!targetFolderId) continue;

				targets.push({
					key,
					folderId: targetFolderId,
					folderName: target.folderName,
				});

				for (const fileId of target.fileIds) {
					await db
						.update(driveFiles)
						.set({ folderId: targetFolderId })
						.where(
							and(eq(driveFiles.id, fileId), eq(driveFiles.userId, userId)),
						);
					movedCount += 1;
				}
			}

			return {
				ok: true as const,
				movedCount,
				createdFolderCount,
				targets,
			};
		}),

	renameFolder: protectedProcedure
		.input(renameFolderSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFolder(userId, input.folderId);
			const [row] = await db
				.update(driveFolders)
				.set({ name: input.name })
				.where(
					and(
						eq(driveFolders.id, input.folderId),
						eq(driveFolders.userId, userId),
					),
				)
				.returning();
			return row;
		}),

	moveFolder: protectedProcedure
		.input(moveFolderSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFolder(userId, input.folderId);
			if (input.parentId) {
				if (input.parentId === input.folderId) {
					throw new TRPCError({
						code: "BAD_REQUEST",
						message: "A folder cannot be its own parent",
					});
				}
				await getOwnedFolder(userId, input.parentId);
			}
			const [row] = await db
				.update(driveFolders)
				.set({ parentId: input.parentId })
				.where(
					and(
						eq(driveFolders.id, input.folderId),
						eq(driveFolders.userId, userId),
					),
				)
				.returning();
			return row;
		}),

	deleteFolder: protectedProcedure
		.input(deleteFolderSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFolder(userId, input.folderId);
			await db
				.delete(driveFolders)
				.where(
					and(
						eq(driveFolders.id, input.folderId),
						eq(driveFolders.userId, userId),
					),
				);
			return { ok: true as const };
		}),

	// ---- files ------------------------------------------------------------
	renameFile: protectedProcedure
		.input(renameFileSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFile(userId, input.fileId);
			const [row] = await db
				.update(driveFiles)
				.set({ name: input.name })
				.where(
					and(eq(driveFiles.id, input.fileId), eq(driveFiles.userId, userId)),
				)
				.returning();
			return row;
		}),

	moveFile: protectedProcedure
		.input(moveFileSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFile(userId, input.fileId);
			if (input.folderId) {
				await getOwnedFolder(userId, input.folderId);
			}
			const [row] = await db
				.update(driveFiles)
				.set({ folderId: input.folderId })
				.where(
					and(eq(driveFiles.id, input.fileId), eq(driveFiles.userId, userId)),
				)
				.returning();
			return row;
		}),

	deleteFile: protectedProcedure
		.input(deleteFileSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const file = await getOwnedFile(userId, input.fileId);

			// Ref-aware delete (finding D4): if a chat/email/canvas attachment still
			// points at this file via drive_file_refs, a hard object-delete would
			// orphan a live attachment. Soft-trash instead — the row is hidden from
			// the browser but the bytes + object survive until the ref is gone.
			const [ref] = await db
				.select({ id: driveFileRefs.id })
				.from(driveFileRefs)
				.where(eq(driveFileRefs.fileId, input.fileId))
				.limit(1);

			if (ref) {
				if (file.trashedAt) {
					return { ok: true as const, softTrashed: true as const };
				}
				await db
					.update(driveFiles)
					.set({ trashedAt: new Date() })
					.where(
						and(eq(driveFiles.id, input.fileId), eq(driveFiles.userId, userId)),
					);
				return { ok: true as const, softTrashed: true as const };
			}

			// No refs: hard delete the row. Only reclaim quota + delete the object
			// when this was the last reference to that content (per-user dedup, DQ1):
			// another non-trashed row with the same sha256 means the bytes are still
			// used.
			await db
				.delete(driveFiles)
				.where(
					and(eq(driveFiles.id, input.fileId), eq(driveFiles.userId, userId)),
				);

			const [remaining] = await db
				.select({ id: driveFiles.id })
				.from(driveFiles)
				.where(
					and(
						eq(driveFiles.userId, userId),
						eq(driveFiles.sha256, file.sha256),
					),
				)
				.limit(1);

			if (!remaining && file.status === "clean") {
				await releaseBytes(userId, Number(file.sizeBytes));
				const storage = getDriveStorage();
				if (storage) {
					await storage.delete({ key: file.storageKey });
				}
			}
			return { ok: true as const, softTrashed: false as const };
		}),

	// ---- attachment bridge (drive_file_refs, finding D4) ------------------
	/**
	 * Record that a Drive file is now referenced by a chat/email/canvas message.
	 * Idempotent (unique on (source_kind, source_id, file_id)); a duplicate ref
	 * is a no-op. Owning the file is required. Once a ref exists, `deleteFile`
	 * soft-trashes rather than hard-deleting so the attachment never dangles.
	 */
	attachToMessage: protectedProcedure
		.input(attachToMessageSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFile(userId, input.fileId);
			await db
				.insert(driveFileRefs)
				.values({
					fileId: input.fileId,
					sourceKind: input.sourceKind,
					sourceId: input.sourceId,
					organizationId: input.organizationId ?? null,
				})
				.onConflictDoNothing({
					target: [
						driveFileRefs.sourceKind,
						driveFileRefs.sourceId,
						driveFileRefs.fileId,
					],
				});
			return { ok: true as const };
		}),

	/**
	 * Drop a ref when its source message is deleted. Owning the file is required.
	 * After the last ref is gone a subsequent `deleteFile` hard-deletes normally.
	 */
	detachFromMessage: protectedProcedure
		.input(detachFromMessageSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			await getOwnedFile(userId, input.fileId);
			await db
				.delete(driveFileRefs)
				.where(
					and(
						eq(driveFileRefs.fileId, input.fileId),
						eq(driveFileRefs.sourceKind, input.sourceKind),
						eq(driveFileRefs.sourceId, input.sourceId),
					),
				);
			return { ok: true as const };
		}),

	// ---- upload / download ------------------------------------------------
	requestUpload: protectedProcedure
		.input(requestUploadSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const storage = requireStorage();

			// MIME allow-list (finding D5): refuse the obvious executable/script
			// payloads before any presigned PUT is issued.
			if (isBlockedMediaType(input.mediaType)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `File type "${input.mediaType}" is not allowed.`,
				});
			}

			if (input.folderId) {
				await getOwnedFolder(userId, input.folderId);
			}

			// Pre-flight quota check (advisory; the authoritative commit happens in
			// confirmUpload). Seeds the 10 GiB row on first use.
			const quota = await ensureQuota(userId);
			const decision = computeUploadDecision(quota, input.sizeBytes);
			if (!decision.allowed) {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						"Upload would exceed your storage quota. Enable overage or free up space.",
				});
			}

			const storageKey = driveStorageKey(userId, input.sha256);

			// Dedup short-circuit (DQ1): if this (user, content) already exists and
			// is committed, reuse it — no upload, no double-count.
			const [existing] = await db
				.select()
				.from(driveFiles)
				.where(
					and(
						eq(driveFiles.userId, userId),
						eq(driveFiles.sha256, input.sha256),
						eq(driveFiles.status, "clean"),
					),
				)
				.limit(1);
			if (existing) {
				return {
					dedup: true as const,
					fileId: existing.id,
					storageKey,
					upload: null,
				};
			}

			// Race-safe insert (finding D7): two concurrent identical uploads would
			// both pass the dedup check above, then collide on the
			// (user_id, sha256, version) unique index → a 500. ON CONFLICT DO NOTHING
			// RETURNING makes the loser return no row; we then fall back to the
			// existing row so both callers get a valid fileId.
			const [inserted] = await db
				.insert(driveFiles)
				.values({
					userId,
					folderId: input.folderId ?? null,
					name: input.filename,
					mediaType: input.mediaType,
					sizeBytes: input.sizeBytes,
					sha256: input.sha256,
					storageKey,
					status: "pending",
				})
				.onConflictDoNothing({
					target: [driveFiles.userId, driveFiles.sha256, driveFiles.version],
				})
				.returning();

			let row = inserted;
			if (!row) {
				const [conflicting] = await db
					.select()
					.from(driveFiles)
					.where(
						and(
							eq(driveFiles.userId, userId),
							eq(driveFiles.sha256, input.sha256),
						),
					)
					.limit(1);
				row = conflicting;
			}

			const presigned = await storage.presignPut({
				key: storageKey,
				contentType: input.mediaType,
				contentLength: input.sizeBytes,
				expiresIn: UPLOAD_TTL,
			});

			return {
				dedup: false as const,
				fileId: row?.id ?? "",
				storageKey,
				upload: { url: presigned.url, expiresAt: presigned.expiresAt },
			};
		}),

	confirmUpload: protectedProcedure
		.input(confirmUploadSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const storage = requireStorage();
			const file = await getOwnedFile(userId, input.fileId);

			if (file.status === "clean") {
				return { ok: true as const, alreadyConfirmed: true as const, file };
			}

			// HEAD the object to confirm the bytes actually landed at the declared
			// size. A size mismatch means a tampered/aborted upload — reject.
			const head = await storage.head({ key: file.storageKey });
			if (head.contentLength !== Number(file.sizeBytes)) {
				throw new TRPCError({
					code: "BAD_REQUEST",
					message: `Uploaded size ${head.contentLength} does not match declared ${file.sizeBytes}`,
				});
			}

			// Atomic confirm gate (finding D3): exactly one concurrent/retried
			// confirm may transition pending→scanning. The conditional UPDATE returns
			// the row only to the winner; the loser gets no row and commits nothing,
			// so quota is never double-counted.
			const [claimed] = await db
				.update(driveFiles)
				.set({ status: "scanning" })
				.where(
					and(
						eq(driveFiles.id, file.id),
						eq(driveFiles.userId, userId),
						eq(driveFiles.status, "pending"),
					),
				)
				.returning();

			if (!claimed) {
				// Lost the race: another confirm already claimed this file. Report the
				// current state without committing quota a second time.
				const current = await getOwnedFile(userId, file.id);
				return {
					ok: true as const,
					alreadyConfirmed: true as const,
					file: current,
				};
			}

			// Atomic quota commit (race-safe / soft-meter per DQ2).
			const commit = await commitUpload(userId, Number(file.sizeBytes));
			if (!commit.committed) {
				// Roll the claim back so the bytes can be retried after freeing space.
				await db
					.update(driveFiles)
					.set({ status: "pending" })
					.where(
						and(eq(driveFiles.id, file.id), eq(driveFiles.userId, userId)),
					);
				throw new TRPCError({
					code: "FORBIDDEN",
					message: "Upload would exceed your storage quota.",
				});
			}

			// Async safety scan (finding D5). The file is `scanning` until a verdict
			// lands; only `clean` makes it downloadable/shareable (the gates in
			// requestDownload/resolveShare enforce this). A quarantined file stays
			// undownloadable. The stub scanner returns clean; the gate is real.
			const scan = await scanObject({
				storageKey: file.storageKey,
				sizeBytes: Number(file.sizeBytes),
				mediaType: file.mediaType,
			});

			const [row] = await db
				.update(driveFiles)
				.set({ status: scan.verdict, scanResult: scan.result })
				.where(and(eq(driveFiles.id, file.id), eq(driveFiles.userId, userId)))
				.returning();

			// Quarantine releases the just-committed bytes (finding): commitUpload
			// already added them to bytes_used, but a quarantined file is never
			// downloadable/shareable and must not consume quota until the nightly
			// reconcile. Return them now so the counter stays honest immediately.
			if (scan.verdict === "quarantined") {
				await releaseBytes(userId, Number(file.sizeBytes));
			}

			return {
				ok: true as const,
				alreadyConfirmed: false as const,
				file: row,
				status: scan.verdict,
				overageBytes: commit.overageBytes,
			};
		}),

	requestDownload: protectedProcedure
		.input(requestDownloadSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const storage = requireStorage();
			const file = await getOwnedFile(userId, input.fileId);
			// Scan gate (finding D5): only a clean file is downloadable. A pending /
			// scanning / quarantined file is withheld.
			if (file.status !== "clean") {
				throw new TRPCError({
					code: "FORBIDDEN",
					message:
						file.status === "quarantined"
							? "This file failed a safety scan and cannot be downloaded."
							: "This file is still being processed.",
				});
			}
			const presigned = await storage.presignGet({
				key: file.storageKey,
				downloadFilename: file.name,
				expiresIn: DOWNLOAD_TTL,
			});
			return { url: presigned.url, expiresAt: presigned.expiresAt };
		}),

	// ---- public shares ----------------------------------------------------
	createShare: protectedProcedure
		.input(createShareSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			if (input.fileId) {
				const file = await getOwnedFile(userId, input.fileId);
				if (file.status === "quarantined") {
					throw new TRPCError({
						code: "FORBIDDEN",
						message: "This file failed a safety scan and cannot be shared.",
					});
				}
				if (file.status !== "clean") {
					throw new TRPCError({
						code: "PRECONDITION_FAILED",
						message:
							"This file is still being processed and cannot be shared yet.",
					});
				}
				requireStorage();
			} else if (input.folderId) {
				await getOwnedFolder(userId, input.folderId);
			}

			const token = generateShareToken();
			const passwordHash = input.password
				? await hashSharePassword(input.password)
				: null;
			const expiresAt = input.expiresInSeconds
				? new Date(Date.now() + input.expiresInSeconds * 1000)
				: null;

			const [row] = await db
				.insert(driveShares)
				.values({
					userId,
					fileId: input.fileId ?? null,
					folderId: input.folderId ?? null,
					token,
					passwordHash,
					expiresAt,
					permission: input.permission ?? "view",
				})
				.returning();
			return row;
		}),

	listShares: protectedProcedure.query(async ({ ctx }) => {
		const userId = ctx.session.user.id;
		return db
			.select()
			.from(driveShares)
			.where(eq(driveShares.userId, userId))
			.orderBy(desc(driveShares.createdAt));
	}),

	revokeShare: protectedProcedure
		.input(revokeShareSchema)
		.mutation(async ({ ctx, input }) => {
			const userId = ctx.session.user.id;
			const [share] = await db
				.select()
				.from(driveShares)
				.where(
					and(
						eq(driveShares.id, input.shareId),
						eq(driveShares.userId, userId),
					),
				)
				.limit(1);
			if (!share) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Share not found" });
			}
			await db
				.update(driveShares)
				.set({ revokedAt: new Date() })
				.where(eq(driveShares.id, input.shareId));
			return { ok: true as const };
		}),

	/**
	 * Public share resolver (D8 §2.5). Validates the token (not revoked, not
	 * expired, not taken-down, password matches if set), increments `view_count`,
	 * and returns a short-TTL presigned GET. Public — no session required — but it
	 * only ever exposes a single signed URL for the shared file (folder shares are
	 * not directly downloadable in P0; they resolve to metadata only).
	 */
	resolveShare: publicProcedure
		.input(resolveShareSchema)
		.mutation(async ({ input }) => {
			const [share] = await db
				.select()
				.from(driveShares)
				.where(eq(driveShares.token, input.token))
				.limit(1);

			if (!share || share.revokedAt || share.takedown) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Share not found" });
			}
			if (share.expiresAt && share.expiresAt.getTime() <= Date.now()) {
				throw new TRPCError({ code: "NOT_FOUND", message: "Share expired" });
			}
			if (share.passwordHash) {
				const ok =
					input.password != null &&
					(await verifySharePassword(input.password, share.passwordHash));
				if (!ok) {
					throw new TRPCError({
						code: "UNAUTHORIZED",
						message: "A password is required for this share.",
					});
				}
			}

			await db
				.update(driveShares)
				.set({ viewCount: share.viewCount + 1 })
				.where(eq(driveShares.id, share.id));

			if (!share.fileId) {
				// Folder share: P0 returns metadata only (no bulk download URL yet).
				return {
					kind: "folder" as const,
					folderId: share.folderId,
					permission: share.permission,
					download: null,
				};
			}

			const storage = requireStorage();
			const [file] = await db
				.select()
				.from(driveFiles)
				.where(eq(driveFiles.id, share.fileId))
				.limit(1);
			if (!file || file.status !== "clean") {
				throw new TRPCError({
					code: "NOT_FOUND",
					message: "Shared file is unavailable",
				});
			}
			const presigned = await storage.presignGet({
				key: file.storageKey,
				downloadFilename: file.name,
				expiresIn: SHARE_TTL,
			});
			return {
				kind: "file" as const,
				fileId: file.id,
				name: file.name,
				mediaType: file.mediaType,
				sizeBytes: Number(file.sizeBytes),
				permission: share.permission,
				download: { url: presigned.url, expiresAt: presigned.expiresAt },
			};
		}),
} satisfies TRPCRouterRecord;

// Re-export so a host/cron caller can settle daily overage without reaching into
// the file directly (keeps the engine the single write path).
export { accrueDailyOverage, reconcileUserQuota } from "./quota";
export { storageQuota };
