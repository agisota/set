import {
	index,
	integer,
	primaryKey,
	sqliteTable,
	text,
	unique,
} from "drizzle-orm/sqlite-core";
import { v4 as uuidv4 } from "uuid";

import type {
	AgentCustomDefinition,
	AgentPresetOverrideEnvelope,
	BranchPrefixMode,
	ExternalApp,
	FileOpenMode,
	GitHubStatus,
	GitStatus,
	TerminalLinkBehavior,
	TerminalPreset,
	WorkspaceType,
} from "./zod";

export const DEFAULT_SETTINGS_BRANCH_PREFIX_MODE =
	"custom" satisfies BranchPrefixMode;
export const DEFAULT_SETTINGS_BRANCH_PREFIX_CUSTOM = "rox";
export const DEFAULT_SETTINGS_UI_FONT_FAMILY = "SF UI Display Pro";
export const DEFAULT_SETTINGS_UI_FONT_SIZE = 12;
export const DEFAULT_SETTINGS_EDITOR_FONT_FAMILY = "SF UI Display Pro";
export const DEFAULT_SETTINGS_EDITOR_FONT_SIZE = 12;
export const DEFAULT_SETTINGS_TERMINAL_FONT_FAMILY = "Geist Mono";
export const DEFAULT_SETTINGS_TERMINAL_FONT_SIZE = 12;

/**
 * Projects table - represents a git repository that the user has opened
 */
export const projects = sqliteTable(
	"projects",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		mainRepoPath: text("main_repo_path").notNull(),
		name: text("name").notNull(),
		color: text("color").notNull(),
		tabOrder: integer("tab_order"),
		lastOpenedAt: integer("last_opened_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		configToastDismissed: integer("config_toast_dismissed", {
			mode: "boolean",
		}),
		defaultBranch: text("default_branch"),
		workspaceBaseBranch: text("workspace_base_branch"),
		githubOwner: text("github_owner"),
		branchPrefixMode: text("branch_prefix_mode").$type<BranchPrefixMode>(),
		branchPrefixCustom: text("branch_prefix_custom"),
		worktreeBaseDir: text("worktree_base_dir"),
		hideImage: integer("hide_image", { mode: "boolean" }),
		iconUrl: text("icon_url"),
		neonProjectId: text("neon_project_id"),
		defaultApp: text("default_app").$type<ExternalApp>(),
	},
	(table) => [
		index("projects_main_repo_path_idx").on(table.mainRepoPath),
		index("projects_last_opened_at_idx").on(table.lastOpenedAt),
	],
);

export type InsertProject = typeof projects.$inferInsert;
export type SelectProject = typeof projects.$inferSelect;

/**
 * Worktrees table - represents a git worktree within a project
 */
export const worktrees = sqliteTable(
	"worktrees",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		path: text("path").notNull(),
		branch: text("branch").notNull(),
		baseBranch: text("base_branch"), // The branch this worktree was created from
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		gitStatus: text("git_status", { mode: "json" }).$type<GitStatus>(),
		githubStatus: text("github_status", { mode: "json" }).$type<GitHubStatus>(),
		// Track whether this worktree was created by Rox or imported from external source
		// Used to prevent accidental deletion of user-created worktrees
		createdByRox: integer("created_by_rox", { mode: "boolean" })
			.notNull()
			.default(true),
	},
	(table) => [
		index("worktrees_project_id_idx").on(table.projectId),
		index("worktrees_branch_idx").on(table.branch),
	],
);

export type InsertWorktree = typeof worktrees.$inferInsert;
export type SelectWorktree = typeof worktrees.$inferSelect;

/**
 * Workspaces table - represents an active workspace (worktree or branch-based)
 */
export const workspaces = sqliteTable(
	"workspaces",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		worktreeId: text("worktree_id").references(() => worktrees.id, {
			onDelete: "cascade",
		}), // Only set for type="worktree"
		type: text("type").notNull().$type<WorkspaceType>(),
		branch: text("branch").notNull(), // Branch name for both types
		name: text("name").notNull(),
		tabOrder: integer("tab_order").notNull(),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		lastOpenedAt: integer("last_opened_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		isUnread: integer("is_unread", { mode: "boolean" }).default(false),
		// Whether the workspace has an auto-generated name (branch name) that should prompt for rename
		isUnnamed: integer("is_unnamed", { mode: "boolean" }).default(false),
		// Timestamp when deletion was initiated. Non-null means deletion in progress.
		// Workspaces with deletingAt set should be filtered out from queries.
		deletingAt: integer("deleting_at"),
		// Allocated port base for multi-worktree dev instances.
		// Each workspace gets a range of 10 ports starting from this base.
		portBase: integer("port_base"),
		sectionId: text("section_id").references(() => workspaceSections.id, {
			onDelete: "set null",
		}),
	},
	(table) => [
		index("workspaces_project_id_idx").on(table.projectId),
		index("workspaces_worktree_id_idx").on(table.worktreeId),
		index("workspaces_last_opened_at_idx").on(table.lastOpenedAt),
		index("workspaces_section_id_idx").on(table.sectionId),
		// NOTE: Migration 0006 creates an additional partial unique index:
		// CREATE UNIQUE INDEX workspaces_unique_branch_per_project
		//   ON workspaces(project_id) WHERE type = 'branch'
		// This enforces one branch workspace per project. Drizzle's schema DSL
		// doesn't support partial/filtered indexes, so this constraint is only
		// applied via the migration, not schema push. See migration 0006 for details.
	],
);

export type InsertWorkspace = typeof workspaces.$inferInsert;
export type SelectWorkspace = typeof workspaces.$inferSelect;

/**
 * Workspace sections - user-created groups within a project for organizing workspaces
 */
export const workspaceSections = sqliteTable(
	"workspace_sections",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		projectId: text("project_id")
			.notNull()
			.references(() => projects.id, { onDelete: "cascade" }),
		name: text("name").notNull(),
		tabOrder: integer("tab_order").notNull(),
		isCollapsed: integer("is_collapsed", { mode: "boolean" }).default(false),
		color: text("color"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [index("workspace_sections_project_id_idx").on(table.projectId)],
);

export type InsertWorkspaceSection = typeof workspaceSections.$inferInsert;
export type SelectWorkspaceSection = typeof workspaceSections.$inferSelect;

export const settings = sqliteTable("settings", {
	id: integer("id").primaryKey().default(1),
	lastActiveWorkspaceId: text("last_active_workspace_id"),
	terminalPresets: text("terminal_presets", { mode: "json" }).$type<
		TerminalPreset[]
	>(),
	terminalPresetsInitialized: integer("terminal_presets_initialized", {
		mode: "boolean",
	}),
	agentPresetOverrides: text("agent_preset_overrides", {
		mode: "json",
	}).$type<AgentPresetOverrideEnvelope>(),
	agentCustomDefinitions: text("agent_custom_definitions", {
		mode: "json",
	}).$type<AgentCustomDefinition[]>(),
	agentPresetPermissionsMigratedAt: integer(
		"agent_preset_permissions_migrated_at",
	),
	selectedRingtoneId: text("selected_ringtone_id"),
	activeOrganizationId: text("active_organization_id"),
	confirmOnQuit: integer("confirm_on_quit", { mode: "boolean" }),
	terminalLinkBehavior: text(
		"terminal_link_behavior",
	).$type<TerminalLinkBehavior>(),
	terminalPersistence: integer("persist_terminal", { mode: "boolean" }).default(
		true,
	),
	autoApplyDefaultPreset: integer("auto_apply_default_preset", {
		mode: "boolean",
	}),
	branchPrefixMode: text("branch_prefix_mode")
		.$type<BranchPrefixMode>()
		.default(DEFAULT_SETTINGS_BRANCH_PREFIX_MODE),
	branchPrefixCustom: text("branch_prefix_custom").default(
		DEFAULT_SETTINGS_BRANCH_PREFIX_CUSTOM,
	),
	notificationSoundsMuted: integer("notification_sounds_muted", {
		mode: "boolean",
	}),
	notificationVolume: integer("notification_volume"),
	deleteLocalBranch: integer("delete_local_branch", { mode: "boolean" }),
	fileOpenMode: text("file_open_mode").$type<FileOpenMode>(),
	showPresetsBar: integer("show_presets_bar", { mode: "boolean" }),
	useCompactTerminalAddButton: integer("use_compact_terminal_add_button", {
		mode: "boolean",
	}),
	uiFontFamily: text("ui_font_family").default(DEFAULT_SETTINGS_UI_FONT_FAMILY),
	uiFontSize: integer("ui_font_size").default(DEFAULT_SETTINGS_UI_FONT_SIZE),
	terminalFontFamily: text("terminal_font_family").default(
		DEFAULT_SETTINGS_TERMINAL_FONT_FAMILY,
	),
	terminalFontSize: integer("terminal_font_size").default(
		DEFAULT_SETTINGS_TERMINAL_FONT_SIZE,
	),
	editorFontFamily: text("editor_font_family").default(
		DEFAULT_SETTINGS_EDITOR_FONT_FAMILY,
	),
	editorFontSize: integer("editor_font_size").default(
		DEFAULT_SETTINGS_EDITOR_FONT_SIZE,
	),
	showResourceMonitor: integer("show_resource_monitor", {
		mode: "boolean",
	}).default(true),
	worktreeBaseDir: text("worktree_base_dir"),
	openLinksInApp: integer("open_links_in_app", { mode: "boolean" }),
	defaultEditor: text("default_editor").$type<ExternalApp>(),
	exposeHostServiceViaRelay: integer("expose_host_service_via_relay", {
		mode: "boolean",
	}),
	// Voice / ambient settings (Phase 4a). Plain dictation defaults ON; the
	// always-on ambient capture is opt-in (defaults OFF) and shows a recording
	// indicator. `voiceAgentContext` is free-text the user supplies in advance so
	// the agent has context — threaded into the dictation post-process today and
	// consumed by the future ambient runtime.
	dictationEnabled: integer("dictation_enabled", { mode: "boolean" }).default(
		true,
	),
	ambientCaptureEnabled: integer("ambient_capture_enabled", {
		mode: "boolean",
	}).default(false),
	voiceAgentContext: text("voice_agent_context").default(""),
	// Push-to-talk (live.pushToTalkDesktop): the global TOGGLE-to-talk shortcut,
	// stored as a native Electron `globalShortcut` accelerator string (e.g.
	// "CommandOrControl+Shift+M") so the main process can register it directly.
	// Null = fall back to DEFAULT_PUSH_TO_TALK_ACCELERATOR.
	pushToTalkAccelerator: text("push_to_talk_accelerator"),
	ttsVoice: text("tts_voice"),
});

export type InsertSettings = typeof settings.$inferInsert;
export type SelectSettings = typeof settings.$inferSelect;

export type ExperimentalFeatureOverrideSource = "migration" | "reset" | "user";

export const experimentalFeatureOverrides = sqliteTable(
	"experimental_feature_overrides",
	{
		featureId: text("feature_id").primaryKey(),
		enabled: integer("enabled", { mode: "boolean" }).notNull(),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		source: text("source").$type<ExperimentalFeatureOverrideSource>(),
	},
);

export type InsertExperimentalFeatureOverride =
	typeof experimentalFeatureOverrides.$inferInsert;
export type SelectExperimentalFeatureOverride =
	typeof experimentalFeatureOverrides.$inferSelect;

export type V1MigrationKind = "project" | "workspace" | "preset";
export type V1MigrationStatus = "success" | "linked" | "error" | "skipped";

export const v1MigrationState = sqliteTable(
	"v1_migration_state",
	{
		v1Id: text("v1_id").notNull(),
		kind: text("kind").notNull().$type<V1MigrationKind>(),
		v2Id: text("v2_id"),
		organizationId: text("organization_id").notNull(),
		status: text("status").notNull().$type<V1MigrationStatus>(),
		reason: text("reason"),
		migratedAt: integer("migrated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		primaryKey({
			columns: [table.organizationId, table.v1Id, table.kind],
		}),
		index("v1_migration_state_v2_id_idx").on(table.v2Id),
	],
);

export type InsertV1MigrationState = typeof v1MigrationState.$inferInsert;
export type SelectV1MigrationState = typeof v1MigrationState.$inferSelect;

// =============================================================================
// Synced tables - mirrored from cloud Postgres via Electric SQL
// Column names match Postgres exactly (snake_case) so Electric data writes directly
// =============================================================================

export type TaskPriority = "urgent" | "high" | "medium" | "low" | "none";
export type IntegrationProvider = "linear";

/**
 * Users table - synced from cloud
 */
export const users = sqliteTable(
	"users",
	{
		id: text("id").primaryKey(),
		clerk_id: text("clerk_id").notNull().unique(),
		name: text("name").notNull(),
		email: text("email").notNull().unique(),
		avatar_url: text("avatar_url"),
		deleted_at: text("deleted_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("users_email_idx").on(table.email),
		index("users_clerk_id_idx").on(table.clerk_id),
	],
);

export type InsertUser = typeof users.$inferInsert;
export type SelectUser = typeof users.$inferSelect;

/**
 * Organizations table - synced from cloud
 */
export const organizations = sqliteTable(
	"organizations",
	{
		id: text("id").primaryKey(),
		clerk_org_id: text("clerk_org_id").unique(),
		name: text("name").notNull(),
		slug: text("slug").notNull().unique(),
		github_org: text("github_org"),
		avatar_url: text("avatar_url"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("organizations_slug_idx").on(table.slug),
		index("organizations_clerk_org_id_idx").on(table.clerk_org_id),
	],
);

export type InsertOrganization = typeof organizations.$inferInsert;
export type SelectOrganization = typeof organizations.$inferSelect;

/**
 * Organization members table - synced from cloud
 */
export const organizationMembers = sqliteTable(
	"organization_members",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		user_id: text("user_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		role: text("role").notNull(),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("organization_members_organization_id_idx").on(table.organization_id),
		index("organization_members_user_id_idx").on(table.user_id),
	],
);

export type InsertOrganizationMember = typeof organizationMembers.$inferInsert;
export type SelectOrganizationMember = typeof organizationMembers.$inferSelect;

/**
 * Tasks table - synced from cloud
 */
export const tasks = sqliteTable(
	"tasks",
	{
		id: text("id").primaryKey(),
		slug: text("slug").notNull().unique(),
		title: text("title").notNull(),
		description: text("description"),
		status: text("status").notNull(),
		status_color: text("status_color"),
		status_type: text("status_type"),
		status_position: integer("status_position"),
		priority: text("priority").notNull().$type<TaskPriority>(),
		organization_id: text("organization_id")
			.notNull()
			.references(() => organizations.id, { onDelete: "cascade" }),
		repository_id: text("repository_id"),
		assignee_id: text("assignee_id").references(() => users.id, {
			onDelete: "set null",
		}),
		creator_id: text("creator_id")
			.notNull()
			.references(() => users.id, { onDelete: "cascade" }),
		estimate: integer("estimate"),
		due_date: text("due_date"),
		labels: text("labels", { mode: "json" }).$type<string[]>(),
		branch: text("branch"),
		pr_url: text("pr_url"),
		external_provider: text("external_provider").$type<IntegrationProvider>(),
		external_id: text("external_id"),
		external_key: text("external_key"),
		external_url: text("external_url"),
		last_synced_at: text("last_synced_at"),
		sync_error: text("sync_error"),
		started_at: text("started_at"),
		completed_at: text("completed_at"),
		deleted_at: text("deleted_at"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("tasks_slug_idx").on(table.slug),
		index("tasks_organization_id_idx").on(table.organization_id),
		index("tasks_assignee_id_idx").on(table.assignee_id),
		index("tasks_status_idx").on(table.status),
		index("tasks_created_at_idx").on(table.created_at),
	],
);

export type InsertTask = typeof tasks.$inferInsert;
export type SelectTask = typeof tasks.$inferSelect;

/**
 * Browser history table - persists browsing history for URL autocomplete
 */
export const browserHistory = sqliteTable(
	"browser_history",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		url: text("url").notNull().unique(),
		title: text("title").notNull().default(""),
		faviconUrl: text("favicon_url"),
		lastVisitedAt: integer("last_visited_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		visitCount: integer("visit_count").notNull().default(1),
	},
	(table) => [
		index("browser_history_url_idx").on(table.url),
		index("browser_history_last_visited_at_idx").on(table.lastVisitedAt),
	],
);

export type InsertBrowserHistory = typeof browserHistory.$inferInsert;
export type SelectBrowserHistory = typeof browserHistory.$inferSelect;

// ===========================================================================
// Browser-data pipeline (WS-N / D4) — per-workspace history + consent.
//
// The legacy global `browser_history` table above stays for autocomplete
// back-compat. These NEW tables back the D4 pipeline: import real OS-browser
// history + capture in-app visits PER WORKSPACE (branch), keep a trailing
// ~7-day local window, upload to our server every 3–7 days, then purge locally.
// Nothing here is captured/imported/uploaded until the user opts in via
// `browser_data_consent`. Local SQLite only (NOT the Neon `packages/db` rule).
// ===========================================================================

/**
 * Per-workspace browser history (WS-N / D4).
 *
 * Unlike the global `browser_history` table (one `url` unique row), this is
 * scoped per workspace/branch and distinguishes in-app `native` visits from
 * imported `import` rows. The dedup key is a COMPOSITE
 * `(workspace_id, url, visited_at)` unique — the same URL can legitimately
 * recur across branches and across distinct visits, so a bare `url` unique
 * would collapse cross-branch history onto one row. `uploaded_at` is the
 * server-upload watermark: null = not yet uploaded; set after the server ACK,
 * after which the row is eligible for local purge.
 */
export const browserHistoryEntries = sqliteTable(
	"browser_history_entries",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		/** Workspace (git worktree/branch) this visit belongs to. */
		workspaceId: text("workspace_id").notNull(),
		url: text("url").notNull(),
		title: text("title").notNull().default(""),
		faviconUrl: text("favicon_url"),
		/** "native" = in-app webview visit; "import" = read from an OS browser. */
		source: text("source").notNull().default("native"),
		/** Visit timestamp (epoch ms). */
		visitedAt: integer("visited_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		/** When this row was imported from an OS browser; null for native rows. */
		importedAt: integer("imported_at"),
		/** Server-upload watermark; null until the server ACKs the upload. */
		uploadedAt: integer("uploaded_at"),
	},
	(table) => [
		unique("browser_history_entries_workspace_url_visited_unq").on(
			table.workspaceId,
			table.url,
			table.visitedAt,
		),
		index("browser_history_entries_workspace_idx").on(table.workspaceId),
		index("browser_history_entries_visited_at_idx").on(table.visitedAt),
		index("browser_history_entries_uploaded_at_idx").on(table.uploadedAt),
	],
);

export type InsertBrowserHistoryEntry =
	typeof browserHistoryEntries.$inferInsert;
export type SelectBrowserHistoryEntry =
	typeof browserHistoryEntries.$inferSelect;

/**
 * Browser-data import/sync consent (WS-N / D4).
 *
 * A single-row consent record gating the whole pipeline. No import, capture, or
 * upload happens unless `accepted` is true. Consent is revocable: on revoke we
 * stop the scheduler and purge all local browser-data rows. `sources` is a JSON
 * array of the OS browsers the user allowed importing (e.g. ["chrome","arc"]).
 */
export const browserDataConsent = sqliteTable("browser_data_consent", {
	id: text("id")
		.primaryKey()
		.$defaultFn(() => uuidv4()),
	accepted: integer("accepted", { mode: "boolean" }).notNull().default(false),
	acceptedAt: integer("accepted_at"),
	revokedAt: integer("revoked_at"),
	/** Last successful upload timestamp (epoch ms); null until first upload. */
	lastUploadedAt: integer("last_uploaded_at"),
	/** JSON string array of allowed OS-browser source keys. */
	sources: text("sources", { mode: "json" })
		.$type<string[]>()
		.notNull()
		.default([]),
});

export type InsertBrowserDataConsent = typeof browserDataConsent.$inferInsert;
export type SelectBrowserDataConsent = typeof browserDataConsent.$inferSelect;

/**
 * Saved prompts table - reusable prompt snippets the user authors locally and
 * can copy back into a chat composer. Purely local (never synced); the
 * "Сохранённые промпты" sidebar view is the only writer/reader.
 */
export const savedPrompts = sqliteTable(
	"saved_prompts",
	{
		id: text("id")
			.primaryKey()
			.$defaultFn(() => uuidv4()),
		title: text("title").notNull(),
		body: text("body").notNull(),
		folder: text("folder"),
		tags: text("tags", { mode: "json" }).$type<string[]>().default([]),
		isFavorite: integer("is_favorite", { mode: "boolean" })
			.notNull()
			.default(false),
		copyCount: integer("copy_count").notNull().default(0),
		lastUsedAt: integer("last_used_at"),
		position: integer("position"),
		createdAt: integer("created_at")
			.notNull()
			.$defaultFn(() => Date.now()),
		updatedAt: integer("updated_at")
			.notNull()
			.$defaultFn(() => Date.now()),
	},
	(table) => [
		index("saved_prompts_updated_at_idx").on(table.updatedAt),
		index("saved_prompts_folder_idx").on(table.folder),
		index("saved_prompts_is_favorite_idx").on(table.isFavorite),
		index("saved_prompts_copy_count_idx").on(table.copyCount),
		index("saved_prompts_position_idx").on(table.position),
	],
);

export type InsertSavedPrompt = typeof savedPrompts.$inferInsert;
export type SelectSavedPrompt = typeof savedPrompts.$inferSelect;

// ===========================================================================
// Automation Fabric — Electric-synced read models
//
// Local SQLite mirrors of the server workflow/skill/run tables. Columns use
// snake_case to match the synced shape; timestamps are ISO strings (text) and
// jsonb columns are `text({ mode: "json" })`. Enum columns are plain text.
//
// Sync shapes (electric-proxy) are wired up alongside the desktop Automations
// UI; these tables only carry data once their shapes are subscribed. Per
// AGENTS.md, render persisted rows cache-first and never blank them on
// `!isReady`.
// ===========================================================================

/** Mirror of server `workflow_definitions`. */
export const workflowDefinitions = sqliteTable(
	"workflow_definitions",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		v2_project_id: text("v2_project_id"),
		owner_user_id: text("owner_user_id").notNull(),
		name: text("name").notNull(),
		slug: text("slug").notNull(),
		description: text("description"),
		engine: text("engine").notNull(),
		draft_state: text("draft_state", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		status: text("status").notNull(),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("workflow_definitions_org_idx").on(table.organization_id),
		index("workflow_definitions_project_idx").on(table.v2_project_id),
	],
);

export type InsertWorkflowDefinition = typeof workflowDefinitions.$inferInsert;
export type SelectWorkflowDefinition = typeof workflowDefinitions.$inferSelect;

/** Mirror of server `skills`. */
export const skills = sqliteTable(
	"skills",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		v2_project_id: text("v2_project_id"),
		owner_user_id: text("owner_user_id").notNull(),
		slug: text("slug").notNull(),
		name: text("name").notNull(),
		description: text("description"),
		kind: text("kind").notNull(),
		status: text("status").notNull(),
		visibility: text("visibility").notNull(),
		current_version_id: text("current_version_id"),
		icon: text("icon"),
		category: text("category"),
		created_at: text("created_at").notNull(),
		updated_at: text("updated_at").notNull(),
	},
	(table) => [
		index("skills_org_idx").on(table.organization_id),
		index("skills_kind_idx").on(table.kind),
	],
);

export type InsertSkill = typeof skills.$inferInsert;
export type SelectSkill = typeof skills.$inferSelect;

/** Mirror of server `skill_versions`. */
export const skillVersions = sqliteTable(
	"skill_versions",
	{
		id: text("id").primaryKey(),
		skill_id: text("skill_id").notNull(),
		organization_id: text("organization_id").notNull(),
		version_number: integer("version_number").notNull(),
		input_schema: text("input_schema", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		output_schema: text("output_schema", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		workflow_deployment_id: text("workflow_deployment_id"),
		legacy_automation_id: text("legacy_automation_id"),
		sim_workflow_external_id: text("sim_workflow_external_id"),
		run_modes: text("run_modes", { mode: "json" }).$type<string[]>(),
		documentation_md: text("documentation_md"),
		created_at: text("created_at").notNull(),
	},
	(table) => [index("skill_versions_skill_idx").on(table.skill_id)],
);

export type InsertSkillVersion = typeof skillVersions.$inferInsert;
export type SelectSkillVersion = typeof skillVersions.$inferSelect;

/** Mirror of server `skill_bindings`. */
export const skillBindings = sqliteTable(
	"skill_bindings",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		skill_id: text("skill_id").notNull(),
		surface: text("surface").notNull(),
		object_type: text("object_type"),
		placement: text("placement"),
		label: text("label"),
		enabled: integer("enabled", { mode: "boolean" }).notNull(),
		config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("skill_bindings_skill_idx").on(table.skill_id),
		index("skill_bindings_surface_idx").on(table.surface, table.object_type),
	],
);

export type InsertSkillBinding = typeof skillBindings.$inferInsert;
export type SelectSkillBinding = typeof skillBindings.$inferSelect;

/** Mirror of server `workflow_runs`. */
export const workflowRuns = sqliteTable(
	"workflow_runs",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		v2_project_id: text("v2_project_id"),
		workflow_id: text("workflow_id"),
		workflow_version_id: text("workflow_version_id"),
		skill_id: text("skill_id"),
		skill_version_id: text("skill_version_id"),
		parent_run_id: text("parent_run_id"),
		trigger_kind: text("trigger_kind").notNull(),
		trigger_ref: text("trigger_ref", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		status: text("status").notNull(),
		input: text("input", { mode: "json" }).$type<Record<string, unknown>>(),
		output: text("output", { mode: "json" }).$type<Record<string, unknown>>(),
		error: text("error", { mode: "json" }).$type<Record<string, unknown>>(),
		context_pack_id: text("context_pack_id"),
		cost: text("cost", { mode: "json" }).$type<Record<string, unknown>>(),
		started_at: text("started_at"),
		ended_at: text("ended_at"),
		created_by_user_id: text("created_by_user_id"),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("workflow_runs_org_idx").on(table.organization_id),
		index("workflow_runs_workflow_idx").on(table.workflow_id),
		index("workflow_runs_skill_idx").on(table.skill_id),
		index("workflow_runs_parent_idx").on(table.parent_run_id),
		index("workflow_runs_status_idx").on(table.status),
	],
);

export type InsertWorkflowRun = typeof workflowRuns.$inferInsert;
export type SelectWorkflowRun = typeof workflowRuns.$inferSelect;

/** Mirror of server `workflow_run_steps`. */
export const workflowRunSteps = sqliteTable(
	"workflow_run_steps",
	{
		id: text("id").primaryKey(),
		run_id: text("run_id").notNull(),
		parent_step_id: text("parent_step_id"),
		block_id: text("block_id").notNull(),
		block_type: text("block_type").notNull(),
		block_name: text("block_name"),
		status: text("status").notNull(),
		input: text("input", { mode: "json" }).$type<Record<string, unknown>>(),
		output: text("output", { mode: "json" }).$type<Record<string, unknown>>(),
		error: text("error", { mode: "json" }).$type<Record<string, unknown>>(),
		started_at: text("started_at"),
		ended_at: text("ended_at"),
		duration_ms: integer("duration_ms"),
		cost: text("cost", { mode: "json" }).$type<Record<string, unknown>>(),
	},
	(table) => [
		index("workflow_run_steps_run_idx").on(table.run_id),
		index("workflow_run_steps_parent_idx").on(table.parent_step_id),
	],
);

export type InsertWorkflowRunStep = typeof workflowRunSteps.$inferInsert;
export type SelectWorkflowRunStep = typeof workflowRunSteps.$inferSelect;

/** Mirror of server `artifacts`. */
export const artifacts = sqliteTable(
	"artifacts",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		v2_project_id: text("v2_project_id"),
		run_id: text("run_id"),
		kind: text("kind").notNull(),
		title: text("title"),
		body: text("body", { mode: "json" }).$type<Record<string, unknown>>(),
		markdown: text("markdown"),
		blob_pathname: text("blob_pathname"),
		media_type: text("media_type"),
		created_by_user_id: text("created_by_user_id"),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("artifacts_org_idx").on(table.organization_id),
		index("artifacts_run_idx").on(table.run_id),
	],
);

export type InsertArtifact = typeof artifacts.$inferInsert;
export type SelectArtifact = typeof artifacts.$inferSelect;

/** Mirror of server `approval_requests`. */
export const approvalRequests = sqliteTable(
	"approval_requests",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		run_id: text("run_id"),
		step_id: text("step_id"),
		status: text("status").notNull(),
		title: text("title"),
		payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
		reason: text("reason"),
		requested_by_user_id: text("requested_by_user_id"),
		resolved_by_user_id: text("resolved_by_user_id"),
		resolved_at: text("resolved_at"),
		expires_at: text("expires_at"),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("approval_requests_org_idx").on(table.organization_id),
		index("approval_requests_run_idx").on(table.run_id),
		index("approval_requests_status_idx").on(table.status),
	],
);

export type InsertApprovalRequest = typeof approvalRequests.$inferInsert;
export type SelectApprovalRequest = typeof approvalRequests.$inferSelect;

/** Mirror of server `object_relations`. */
export const objectRelations = sqliteTable(
	"object_relations",
	{
		id: text("id").primaryKey(),
		organization_id: text("organization_id").notNull(),
		source_type: text("source_type").notNull(),
		source_id: text("source_id").notNull(),
		relation_type: text("relation_type").notNull(),
		target_type: text("target_type").notNull(),
		target_id: text("target_id").notNull(),
		metadata: text("metadata", { mode: "json" }).$type<
			Record<string, unknown>
		>(),
		created_at: text("created_at").notNull(),
	},
	(table) => [
		index("object_relations_source_idx").on(table.source_type, table.source_id),
		index("object_relations_target_idx").on(table.target_type, table.target_id),
	],
);

export type InsertObjectRelation = typeof objectRelations.$inferInsert;
export type SelectObjectRelation = typeof objectRelations.$inferSelect;
