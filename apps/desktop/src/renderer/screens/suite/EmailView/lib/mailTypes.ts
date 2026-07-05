import type { RouterOutputs } from "@rox/trpc";

/**
 * Shared mail types for the desktop EmailView surface.
 *
 * Re-derived from the cloud `mail.*` router outputs so the renderer components
 * never drift from the wire contract. `listThreads` returns flat thread rows
 * (subject/last-activity/count — per-message sender + unread live on the
 * messages); `getThread` returns the thread plus its chronological messages.
 */

/** One row of the mailbox thread list (`mail.listThreads`). */
export type MailThreadSummary = RouterOutputs["mail"]["listThreads"][number] & {
	unreadCount: number;
	hasAttachments: boolean;
};

/** The thread row returned by `mail.getThread`. */
export type MailThread = RouterOutputs["mail"]["getThread"]["thread"];

/** A single message inside an opened thread (`mail.getThread`). */
export type MailThreadMessage =
	RouterOutputs["mail"]["getThread"]["messages"][number];

/**
 * The system folders + smart filters of the left rail.
 *
 * SERVER-BACKED (FN-135/139, #697/#699): `listThreads` now carries per-thread
 * `folder` + `isFlagged` + `unreadCount` + `hasAttachments`, so inbox / archive /
 * spam / trash / unread / flagged / attachments all resolve to real server state;
 * drafts come from `mail.listDrafts`. `sent` is the only id still awaiting a
 * dedicated server feed (an outbound-direction thread list).
 */
export type MailFolderId =
	| "inbox"
	| "sent"
	| "drafts"
	| "archive"
	| "spam"
	| "trash"
	| "unread"
	| "attachments"
	| "flagged";

export interface MailFolderDef {
	id: MailFolderId;
	label: string;
	/** Lucide icon component. */
	kind: "folder" | "filter";
	/**
	 * Whether this folder resolves to real data in P0. Only `inbox` does today;
	 * the rest depend on server folder/flag columns.
	 */
	serverBacked: boolean;
}
