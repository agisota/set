// Import the table from its defining module (`@rox/local-db/schema/schema`)
// rather than a barrel. Bun's ESM linker intermittently fails to resolve the
// most recently added binding (`savedPrompts`) through any `export *` barrel
// when the whole desktop test graph loads in one process, surfacing as
// `SyntaxError: Export named 'savedPrompts' not found`. Importing directly from
// the source module bypasses the star re-export entirely.
import { savedPrompts } from "@rox/local-db/schema/schema";
import { eq, isNull, like, or, sql } from "drizzle-orm";
import type { LocalDb } from "main/lib/local-db";

/**
 * One-time, idempotent migration of legacy body-embedded prompt metadata into
 * real schema columns.
 *
 * Historically, tags / favorite / usage were smuggled into the `body` column as
 * a trailing `<!--rox:meta {...} -->` HTML comment (the only way to add
 * metadata before the schema gained columns). Now those columns exist, so this
 * routine finds any row whose `body` still carries the block (or whose
 * `position` was never assigned), decodes the block into the columns, strips it
 * from `body`, and assigns a stable initial `position`. Running it repeatedly is
 * safe: rows without a block and with a position are skipped.
 */

interface LegacyMeta {
	tags: string[];
	favorite: boolean;
	useCount: number;
	lastUsedAt: number | null;
}

/** Matches the trailing metadata block (and the blank lines before it). */
const BLOCK_RE = /\n*<!--rox:meta\s*([\s\S]*?)-->\s*$/;

const EMPTY_META: LegacyMeta = {
	tags: [],
	favorite: false,
	useCount: 0,
	lastUsedAt: null,
};

function normalizeTags(tags: readonly unknown[]): string[] {
	const seen = new Set<string>();
	const out: string[] = [];
	for (const raw of tags) {
		if (typeof raw !== "string") continue;
		const tag = raw.trim().replace(/\s+/g, " ");
		if (tag.length === 0) continue;
		const key = tag.toLowerCase();
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(tag);
	}
	return out;
}

function coerce(value: unknown): LegacyMeta {
	if (typeof value !== "object" || value === null) return { ...EMPTY_META };
	const record = value as Record<string, unknown>;
	const useCount =
		typeof record.useCount === "number" && Number.isFinite(record.useCount)
			? Math.max(0, Math.floor(record.useCount))
			: 0;
	const lastUsedAt =
		typeof record.lastUsedAt === "number" && Number.isFinite(record.lastUsedAt)
			? record.lastUsedAt
			: null;
	return {
		tags: Array.isArray(record.tags) ? normalizeTags(record.tags) : [],
		favorite: record.favorite === true,
		useCount,
		lastUsedAt,
	};
}

/** Split a stored body into its clean text and decoded legacy metadata. */
export function decodeLegacyBody(stored: string): {
	body: string;
	meta: LegacyMeta;
} {
	const match = stored.match(BLOCK_RE);
	if (!match) return { body: stored, meta: { ...EMPTY_META } };
	const body = stored.slice(0, match.index ?? 0);
	try {
		return { body, meta: coerce(JSON.parse(match[1] ?? "{}")) };
	} catch {
		// Corrupt block → still strip it, but treat metadata as empty.
		return { body, meta: { ...EMPTY_META } };
	}
}

let didRun = false;

/**
 * Reset the in-process guard. Tests only — production calls this once per
 * process and relies on the idempotent SQL to no-op thereafter.
 */
export function __resetBackfillGuardForTests(): void {
	didRun = false;
}

/**
 * Migrate any surviving `rox:meta` blocks into real columns and assign initial
 * `position` to rows that lack one. Cheap and idempotent; guarded so it runs at
 * most once per process.
 */
export function backfillSavedPromptMetadata(db: LocalDb): void {
	if (didRun) return;
	didRun = true;

	const candidates = db
		.select()
		.from(savedPrompts)
		.where(
			or(
				like(savedPrompts.body, "%<!--rox:meta%"),
				isNull(savedPrompts.position),
			),
		)
		.all();

	if (candidates.length === 0) return;

	// Stable initial order for position assignment: favorites first, then most
	// recently updated — mirrors the historical default sort.
	const needsPosition = candidates
		.filter((row) => row.position === null)
		.sort((a, b) => {
			const favA = a.isFavorite ? 1 : 0;
			const favB = b.isFavorite ? 1 : 0;
			if (favA !== favB) return favB - favA;
			return b.updatedAt - a.updatedAt;
		});

	const [maxRow] = db
		.select({ max: sql<number | null>`max(${savedPrompts.position})` })
		.from(savedPrompts)
		.all();
	let nextPos = (maxRow?.max ?? -1) + 1;
	const positionById = new Map<string, number>();
	for (const row of needsPosition) {
		positionById.set(row.id, nextPos);
		nextPos += 1;
	}

	db.transaction((tx) => {
		for (const row of candidates) {
			const hasBlock = BLOCK_RE.test(row.body);
			const patch: Record<string, unknown> = {};

			if (hasBlock) {
				const { body, meta } = decodeLegacyBody(row.body);
				patch.body = body;
				// Only adopt decoded metadata when the column is still at its
				// default — never clobber values the user already set in a column.
				if ((row.tags ?? []).length === 0 && meta.tags.length > 0) {
					patch.tags = meta.tags;
				}
				if (!row.isFavorite && meta.favorite) patch.isFavorite = true;
				if ((row.copyCount ?? 0) === 0 && meta.useCount > 0) {
					patch.copyCount = meta.useCount;
				}
				if (row.lastUsedAt === null && meta.lastUsedAt !== null) {
					patch.lastUsedAt = meta.lastUsedAt;
				}
			}

			const assignedPosition = positionById.get(row.id);
			if (assignedPosition !== undefined) patch.position = assignedPosition;

			if (Object.keys(patch).length === 0) continue;

			tx.update(savedPrompts)
				.set(patch)
				.where(eq(savedPrompts.id, row.id))
				.run();
		}
	});
}
