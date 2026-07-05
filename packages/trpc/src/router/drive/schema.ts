import { driveRefSourceValues, driveSharePermValues } from "@rox/db/enums";
import { z } from "zod";

/**
 * Zod inputs for the per-user Drive router (D8 P0).
 *
 * Drive is GLOBAL per user (DECISIONS.md DQ3) — every procedure scopes by
 * `ctx.session.user.id`, never by org. Folders form a per-user tree; files are
 * content-addressed pointers (`u/<userId>/<sha256>`); shares expose a file or
 * folder via `rox.one/d/<token>`.
 */

const uuid = z.string().uuid();

// SHA-256 hex digest (64 lowercase hex chars) — the content address (DQ1).
const sha256Schema = z
	.string()
	.regex(/^[a-f0-9]{64}$/, "sha256 must be a 64-char lowercase hex digest");

const filenameSchema = z.string().min(1).max(255);

export const sharePermSchema = z.enum(driveSharePermValues);

// ---- folders ---------------------------------------------------------------

export const listFolderSchema = z
	.object({ folderId: uuid.nullable().optional() })
	.optional();

export const createFolderSchema = z.object({
	name: filenameSchema,
	parentId: uuid.nullable().optional(),
});

export const renameFolderSchema = z.object({
	folderId: uuid,
	name: filenameSchema,
});

export const moveFolderSchema = z.object({
	folderId: uuid,
	parentId: uuid.nullable(),
});

export const deleteFolderSchema = z.object({ folderId: uuid });

export const organizeFolderSchema = z
	.object({ folderId: uuid.nullable().optional() })
	.optional();

// ---- files -----------------------------------------------------------------

export const renameFileSchema = z.object({
	fileId: uuid,
	name: filenameSchema,
});

export const moveFileSchema = z.object({
	fileId: uuid,
	folderId: uuid.nullable(),
});

export const deleteFileSchema = z.object({ fileId: uuid });

// ---- upload / download -----------------------------------------------------

export const requestUploadSchema = z.object({
	filename: filenameSchema,
	mediaType: z.string().min(1).max(255),
	sizeBytes: z.number().int().min(0),
	sha256: sha256Schema,
	folderId: uuid.nullable().optional(),
});

export const confirmUploadSchema = z.object({ fileId: uuid });

export const requestDownloadSchema = z.object({ fileId: uuid });

// ---- quota / overage -------------------------------------------------------

export const setOverageOptInSchema = z.object({ optIn: z.boolean() });

// ---- attachment bridge (drive_file_refs) -----------------------------------

export const sourceKindSchema = z.enum(driveRefSourceValues);

export const attachToMessageSchema = z.object({
	fileId: uuid,
	sourceKind: sourceKindSchema,
	sourceId: uuid,
	organizationId: uuid.nullable().optional(),
});

export const detachFromMessageSchema = z.object({
	fileId: uuid,
	sourceKind: sourceKindSchema,
	sourceId: uuid,
});

// ---- public shares ---------------------------------------------------------

export const createShareSchema = z
	.object({
		fileId: uuid.optional(),
		folderId: uuid.optional(),
		password: z.string().min(1).max(256).optional(),
		expiresInSeconds: z.number().int().positive().optional(),
		permission: sharePermSchema.optional(),
	})
	// Exactly one target (a file XOR a folder), matching the DB CHECK.
	.refine((v) => Boolean(v.fileId) !== Boolean(v.folderId), {
		message: "Provide exactly one of fileId or folderId",
	});

export const revokeShareSchema = z.object({ shareId: uuid });

export const resolveShareSchema = z.object({
	token: z.string().min(1).max(128),
	password: z.string().max(256).optional(),
});
