export const EXPERIMENTAL_FEATURE_CATEGORIES = [
	"agent-native",
	"templates",
	"collaboration",
	"live",
	"project-os",
	"rooms",
] as const;

export type ExperimentalFeatureCategory =
	(typeof EXPERIMENTAL_FEATURE_CATEGORIES)[number];

export const EXPERIMENTAL_FEATURE_CATEGORY_LABELS: Record<
	ExperimentalFeatureCategory,
	string
> = {
	"agent-native": "Agent-Native",
	templates: "Шаблоны",
	collaboration: "Совместная работа",
	live: "Live-комнаты",
	"project-os": "Project OS",
	rooms: "Объединённые процессы",
};

export const EXPERIMENTAL_FEATURE_AVAILABILITIES = [
	"available",
	"needs_configuration",
	"not_implemented",
	"blocked",
] as const;

export type ExperimentalFeatureAvailability =
	(typeof EXPERIMENTAL_FEATURE_AVAILABILITIES)[number];

export type ExperimentalFeatureMaturity = "alpha" | "beta" | "preview";
export type ExperimentalFeatureType =
	| "experiment"
	| "operational"
	| "permission"
	| "release";
export type ExperimentalFeatureImplementationStatus =
	| "ready"
	| "stubbed"
	| "planned";
export type ExperimentalFeatureDependencyKind =
	| "module"
	| "provider"
	| "runtime";
export type ExperimentalFeatureDependencyStatus =
	| "configured"
	| "missing"
	| "unavailable";

export interface ExperimentalFeatureDependency {
	id: string;
	label: string;
	kind: ExperimentalFeatureDependencyKind;
	required: boolean;
	configurationHint?: string;
}

export interface ExperimentalFeatureDefinition {
	id: string;
	title: string;
	shortDescription: string;
	longDescription: string;
	category: ExperimentalFeatureCategory;
	defaultEnabled: true;
	maturity: ExperimentalFeatureMaturity;
	type: ExperimentalFeatureType;
	owner: string;
	implementationStatus: ExperimentalFeatureImplementationStatus;
	dependencies: readonly ExperimentalFeatureDependency[];
	affectedSurfaces: readonly string[];
	killSwitch: string;
	telemetryEvent: string;
	docsAnchor: string;
	cleanupTrigger: string;
}

export interface ExperimentalFeatureState {
	id: ExperimentalFeatureId;
	enabled: boolean;
	defaultEnabled: boolean;
	userOverride: boolean | null;
	availability: ExperimentalFeatureAvailability;
	reason?: string;
	dependencies: readonly ExperimentalFeatureDependency[];
	missingDependencies?: readonly ExperimentalFeatureDependency[];
}

export interface ResolveExperimentalFeatureStateOptions {
	dependencies?: Readonly<Record<string, ExperimentalFeatureDependencyStatus>>;
	killSwitches?: Readonly<Record<string, boolean | undefined>>;
	overrides?: Readonly<Record<string, boolean | undefined>>;
}

const AGENT_NATIVE_PROVIDER: ExperimentalFeatureDependency = {
	id: "agent-native",
	label: "Провайдер Agent-Native",
	kind: "provider",
	required: true,
	configurationHint:
		"Настройте ключи доступа Agent-Native или локальный адрес сервиса.",
};

const AGENT_NATIVE_TEMPLATES_PROVIDER: ExperimentalFeatureDependency = {
	id: "agent-native-templates",
	label: "Источник шаблонов Agent-Native",
	kind: "provider",
	required: true,
	configurationHint: "Настройте адрес каталога шаблонов Agent-Native.",
};

const LIVEBLOCKS_PROVIDER: ExperimentalFeatureDependency = {
	id: "liveblocks",
	label: "Liveblocks",
	kind: "provider",
	required: true,
	configurationHint: "Настройте публичный и секретный ключи Liveblocks.",
};

// `collaboration.threadsAsObjects` is durable on the native Rox object graph
// (comment_threads/comments in Postgres, synced via electric-proxy), NOT on
// Liveblocks — so Liveblocks is an OPTIONAL realtime accelerator here, never a
// gate. `required: false` keeps the feature resolvable (`available` once its own
// surface is `ready`) without any Liveblocks env. Same demote pattern as
// HULY_PROVIDER for project-os (canonical store is Rox; the provider is additive).
const LIVEBLOCKS_PROVIDER_OPTIONAL: ExperimentalFeatureDependency = {
	id: "liveblocks",
	label: "Liveblocks",
	kind: "provider",
	required: false,
	configurationHint:
		"Опционально: настройте ключи Liveblocks, чтобы добавить realtime-присутствие в обсуждения.",
};

const LIVEKIT_PROVIDER: ExperimentalFeatureDependency = {
	id: "livekit",
	label: "LiveKit",
	kind: "provider",
	required: true,
	configurationHint: "Настройте URL LiveKit, ключ API и серверный секрет API.",
};

// Project OS is native on the Rox object graph (entities/edges), so Huly is an
// OPTIONAL import connector — never a gate. `required: false` keeps project-os.*
// features resolvable (`available` once their own surface is `ready`) without
// any Huly env. See plans/agent-native-team-os-integrations-design.md ("the
// object graph is canonical; do not replace Rox with Huly").
const HULY_PROVIDER: ExperimentalFeatureDependency = {
	id: "huly",
	label: "Huly",
	kind: "provider",
	required: false,
	configurationHint:
		"Опционально: настройте URL рабочего пространства Huly и API-токен, чтобы включить импорт.",
};

const GITHUB_PROVIDER: ExperimentalFeatureDependency = {
	id: "github",
	label: "GitHub",
	kind: "provider",
	required: false,
	configurationHint:
		"Подключите GitHub CLI или токен для процессов, связанных с PR.",
};

const LOCAL_DESKTOP_RUNTIME: ExperimentalFeatureDependency = {
	id: "desktop-runtime",
	label: "Десктопный runtime Rox",
	kind: "runtime",
	required: true,
};

function formatMissingProviderReason(
	dependencies: readonly ExperimentalFeatureDependency[],
): string {
	const dependencyNames = dependencies
		.map((dependency) => dependency.label)
		.join(", ");
	const setupHints = dependencies
		.map((dependency) => dependency.configurationHint)
		.filter((hint): hint is string => Boolean(hint?.trim()));

	return [
		`Требуется настройка: ${dependencyNames}.`,
		...setupHints,
		"Откройте настройки соответствующего провайдера или интеграции и добавьте недостающую конфигурацию. Значения секретов здесь не показываются.",
	].join(" ");
}

type FeatureSeed = Omit<
	ExperimentalFeatureDefinition,
	| "category"
	| "cleanupTrigger"
	| "defaultEnabled"
	| "docsAnchor"
	| "killSwitch"
	| "owner"
	| "telemetryEvent"
	| "type"
>;

type CategoryFeature<TFeature extends FeatureSeed> = TFeature & {
	category: ExperimentalFeatureCategory;
	defaultEnabled: true;
	owner: string;
	type: "experiment";
	killSwitch: string;
	telemetryEvent: string;
	docsAnchor: string;
	cleanupTrigger: string;
};

function defineCategory<const TFeatures extends readonly FeatureSeed[]>(
	category: ExperimentalFeatureCategory,
	owner: string,
	features: TFeatures,
): {
	readonly [TIndex in keyof TFeatures]: CategoryFeature<TFeatures[TIndex]>;
} {
	return features.map((feature) => ({
		...feature,
		category,
		defaultEnabled: true,
		owner,
		type: "experiment" as const,
		killSwitch: `Settings > Experiments > ${feature.title}`,
		telemetryEvent: `experimental_feature_${feature.id.replaceAll(".", "_")}_toggled`,
		docsAnchor: feature.id.toLowerCase().replaceAll(".", "-"),
		cleanupTrigger:
			"Promote to stable once the backed surface is generally available, then remove the experiment toggle.",
	})) as {
		readonly [TIndex in keyof TFeatures]: CategoryFeature<TFeatures[TIndex]>;
	};
}

export const EXPERIMENTAL_FEATURES = [
	...defineCategory("agent-native", "product-platform", [
		{
			id: "agentNative.sourceMarketplace",
			title: "Source Marketplace",
			shortDescription: "Browse and attach Agent-Native sources to agent runs.",
			longDescription:
				"Adds a controlled marketplace entry point for source packs, connectors, and reusable agent inputs.",
			maturity: "preview",
			// "ready" is justified by the MANAGEMENT surface, which is real and
			// usable today: org-admin-gated create/edit + a management list
			// (setStatus lifecycle) over the `agentSource` CRUD, with HTTPS-only
			// endpoints and a credential-free projection (`encryptedConfig` never
			// leaves the server). The org context is the agent-native provider's
			// configured signal (see `resolveSourcesGate`); `desktop-runtime` is a
			// `runtime` dep and never gates this web surface.
			//
			// Run-attach is WIRED AT THE RUNTIME but not yet driven by a live
			// caller: the cloud proxy (`createProxyMcpServer`) consumes a per-run
			// `sourceId` via `AgentSourcePool.connectSelected` to attach exactly the
			// selected source instead of the org-wide set — consumed only WHEN a
			// caller supplies `sourceId` on the agent's MCP request. The web prompt
			// composer that owns `selectedSource` is preview-only and the seeded MCP
			// URL is static, so no production run emits `sourceId` yet. This flag does
			// NOT claim live per-run source scoping; it claims a live management
			// surface plus runtime-ready attach.
			implementationStatus: "ready",
			dependencies: [AGENT_NATIVE_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Agent launcher", "Prompt composer", "Source picker"],
		},
		{
			id: "agentNative.screenContextBus",
			title: "Screen Context Bus",
			shortDescription:
				"Share active screen and workspace context with agents.",
			longDescription:
				"Normalizes visible workspace, task, file, and app state into a context bus that agent tools can consume.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Workspace shell", "Agent context", "Command palette"],
		},
		{
			id: "agentNative.uiCommandRouter",
			title: "UI Command Router",
			shortDescription: "Route agent intents to safe desktop UI commands.",
			longDescription:
				"Introduces a typed command boundary for agent-triggered UI actions with auditability and local kill switch control.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Command palette", "Workspace actions", "Agent tools"],
		},
		{
			id: "agentNative.embeddedSurfaces",
			title: "Embedded Agent Surfaces",
			shortDescription: "Expose Agent-Native panels inside Rox workflows.",
			longDescription:
				"Creates gated locations for embedded agent cards, previews, and tool-specific panels in Rox desktop.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Workspace sidebar", "Agent details", "Settings"],
		},
		{
			id: "agentNative.runReplay",
			title: "Run Replay",
			shortDescription: "Replay agent runs with preserved context and outputs.",
			longDescription:
				"Prepares a replay surface for agent decisions, tool calls, inputs, outputs, and review checkpoints.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Agent run history", "Review panel", "Audit trail"],
		},
		{
			id: "agentNative.permissions",
			title: "Agent Permissions",
			shortDescription: "Manage per-agent tool and surface permissions.",
			longDescription:
				"Adds a user-facing control plane for deciding which agent sources, commands, and UI actions are available.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Agent settings", "Permissions", "Run guardrails"],
		},
		{
			id: "agentNative.memoryBinding",
			title: "Memory Binding",
			shortDescription: "Bind agent memory to projects, workspaces, and tasks.",
			longDescription:
				"Controls a scoped memory binding layer so agents can reuse durable context without leaking across workspaces.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Project settings", "Agent context", "Knowledge"],
		},
		{
			id: "agentNative.a2aDelegation",
			title: "A2A Delegation",
			shortDescription: "Let agents delegate bounded subtasks to other agents.",
			longDescription:
				"Introduces safe agent-to-agent delegation controls for multi-agent execution and review flows.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: [
				"Agent orchestration",
				"Task execution",
				"Run history",
			],
		},
		{
			id: "agentNative.commandPalette",
			title: "Agent Command Palette",
			shortDescription: "Expose Agent-Native actions in the command palette.",
			longDescription:
				"Adds discoverable command palette entries for source attachment, run replay, delegation, and permission review.",
			maturity: "preview",
			// "ready" is justified by a REAL gated surface: the desktop command
			// palette's `agentNativeProvider`
			// (renderer/commandPalette/modules/agentNative/commands.tsx) contributes
			// reachable entries ONLY when this feature is enabled+available — the
			// gate state is resolved in CommandContextProvider via
			// `useExperimentalFeature` and carried on
			// `CommandContext.experimentalAgentCommandPalette`. Two commands route
			// to surfaces that ship today ("Проверить разрешения агента" ->
			// /settings/agents; "Повторить запуск агента" -> /automations); the two
			// not-yet-backed actions ("Подключить источник агента",
			// "Делегировать задачу агенту") are contributed DISABLED with a clear
			// `disabledReason` instead of a faked run, per the experimental
			// anti-slop rule. Its only dependency is the desktop runtime (a
			// `runtime` dep, always "configured"), so the resolver returns
			// `available` with no external provider — same clean-flip precedent as
			// `templates.marketplace` / `projectOs.workspaceShell`; no provider
			// demotion is required (unlike `agentNative.sourceMarketplace`).
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: [
				"Command palette",
				"Global search",
				"Workspace actions",
			],
		},
		{
			id: "agentNative.sharedActionModel",
			title: "Shared Action Model",
			shortDescription: "Normalize user, agent, and workflow actions.",
			longDescription:
				"Provides a typed action model that can be reused across Agent-Native commands, live collaboration, and project objects.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Command router", "Telemetry", "Audit trail"],
		},
	]),
	...defineCategory("templates", "product-platform", [
		{
			id: "templates.marketplace",
			title: "Template Marketplace",
			shortDescription:
				"Browse and apply Rox project templates from inside Rox.",
			longDescription:
				"Adds a gated template marketplace that lists Rox's built-in project templates and creates a project from the chosen template using the local project-creation engine.",
			maturity: "preview",
			// Backed by the local project-creation engine (PROJECT_TEMPLATES +
			// host-service/clone) surfaced through TemplateGalleryModal. The only
			// required dependency is the desktop runtime, so the gate opens locally
			// without an external Agent-Native templates endpoint.
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Template gallery", "New workspace", "Onboarding"],
		},
		{
			id: "templates.previewSandbox",
			title: "Template Preview Sandbox",
			shortDescription:
				"Preview template behavior before creating a workspace.",
			longDescription:
				"Adds a dry-run preview step to the Template Gallery: before a template is applied, it shows exactly what the local project-creation engine would create — the derived project name, whether it clones a repo or initializes an empty git workspace, the starter presets it bundles, and the files and setup commands those presets scaffold — computed purely from the template spec without creating the project.",
			maturity: "preview",
			// Backed by a REAL gated surface: the Template Gallery renders a
			// TemplatePreviewSandboxPanel (a pure dry-run derived by
			// `deriveTemplatePreview` from the PROJECT_TEMPLATES spec + the
			// workspace starter-preset catalog) BEFORE the existing apply path runs
			// `client.project.create`. Like `templates.marketplace`, the preview is
			// computed locally from the in-app template definitions, so the only
			// required dependency is the desktop runtime — no external Agent-Native
			// templates endpoint. The non-required AGENT_NATIVE_TEMPLATES_PROVIDER is
			// intentionally dropped here so the gate opens locally; importing
			// external template definitions is a separate feature
			// (`templates.importWizard`).
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: [
				"Template gallery",
				"Workspace setup",
				"Preview panel",
			],
		},
		{
			id: "templates.importWizard",
			title: "Template Import Wizard",
			shortDescription: "Import external templates into Rox projects.",
			longDescription:
				"Guides users through importing Agent-Native template definitions and mapping them to Rox project settings.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER],
			affectedSurfaces: ["Template gallery", "Project settings", "Onboarding"],
		},
		{
			id: "templates.forkVersioning",
			title: "Template Fork Versioning",
			shortDescription: "Fork and version team templates.",
			longDescription:
				"Adds a metadata model for tracking local template forks, upstream revisions, and project adoption status.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER],
			affectedSurfaces: [
				"Template details",
				"Project settings",
				"Upgrade flow",
			],
		},
		{
			id: "templates.permissionsManifest",
			title: "Permissions Manifest",
			shortDescription: "Review template-required permissions before install.",
			longDescription:
				"Inserts a pre-install confirm step into the Template Gallery create flow: before a project is created, it shows a permissions manifest listing exactly what the selected template will apply — the repository scope (clone a remote vs initialise an empty git workspace), the starter presets it bundles (resolved to their names/descriptions), the files it will write, and the setup commands it will run — and requires an explicit Confirm to proceed (Cancel returns to the gallery).",
			maturity: "preview",
			// Backed by a REAL gated surface: the Template Gallery renders a
			// TemplatePermissionsManifestPanel (a pure manifest derived by
			// `deriveTemplatePermissionsManifest` from the PROJECT_TEMPLATES spec +
			// the workspace starter-preset catalog) as the FINAL confirm gate BEFORE
			// the existing apply path runs `client.project.create`. Like
			// `templates.previewSandbox`, the manifest is computed locally from the
			// in-app template definitions, so the only required dependency is the
			// desktop runtime — no external Agent-Native templates endpoint. The
			// non-required AGENT_NATIVE_TEMPLATES_PROVIDER is intentionally dropped
			// here so the gate opens locally (the presets are local; same demote
			// precedent as `templates.previewSandbox`); importing external template
			// definitions remains a separate feature (`templates.importWizard`).
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: [
				"Template install",
				"Permissions",
				"Security settings",
			],
		},
		{
			id: "templates.agentOnboarding",
			title: "Шаблоны онбординга агентов",
			shortDescription: "Создать проект с готовыми ролями агентов.",
			longDescription:
				"Добавляет онбординг из шаблонов для пресетов агентов, промптов, команд и стандартных проектных процессов.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Onboarding", "Agent settings", "New project"],
		},
		{
			id: "templates.dbMapper",
			title: "Маппинг данных из шаблона",
			shortDescription: "Создать проектные маппинги данных из шаблонов.",
			longDescription:
				"Добавляет шаблонный путь для маппинга внешних объектов в локальные и облачные модели данных Rox перед импортом.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER],
			affectedSurfaces: ["Project setup", "Imports", "Data mapping"],
		},
		{
			id: "templates.evals",
			title: "Template Evals",
			shortDescription: "Run quality checks against templates before adoption.",
			longDescription:
				"Introduces template evaluation metadata for smoke tests, required integrations, and expected outputs.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER],
			affectedSurfaces: ["Template gallery", "Quality checks", "CI hints"],
		},
		{
			id: "templates.seedGenerator",
			title: "Seed Generator",
			shortDescription:
				"Generate initial tasks, agents, and docs from a template.",
			longDescription:
				"Controls template-generated starter data for projects, including tasks, docs, prompts, and workflow rooms.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER],
			affectedSurfaces: ["New project", "Workspace setup", "Task seeding"],
		},
		{
			id: "templates.skillCompiler",
			title: "Skill Compiler",
			shortDescription: "Compile templates into reusable Rox skills.",
			longDescription:
				"Prepares a pipeline for converting template metadata into agent skills, commands, and reusable prompts.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: [
				"Skills library",
				"Template gallery",
				"Agent settings",
			],
		},
	]),
	...defineCategory("collaboration", "collaboration-platform", [
		{
			id: "collaboration.presence",
			title: "Presence",
			shortDescription: "Show who is active in a workspace or room.",
			longDescription:
				"Uses Liveblocks-ready state to expose collaborators, cursor presence, and active agent participants.",
			maturity: "preview",
			implementationStatus: "ready",
			dependencies: [LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Workspace header", "Rooms", "Editor surfaces"],
		},
		{
			id: "collaboration.editor",
			title: "Collaborative Editor",
			shortDescription: "Enable real-time collaborative editing surfaces.",
			longDescription:
				"Binds the markdown note editor to a shared Yjs document over the existing Liveblocks room (@liveblocks/yjs LiveblocksYjsProvider), so two people editing the same note converge in real time. Rides the SAME room id and token path as collaboration.presence — the note-room ACL already grants editors storage-write — so no extra secret or deploy is required beyond the Liveblocks keys presence already uses. When the gate is off the editor stays single-player.",
			maturity: "alpha",
			implementationStatus: "ready",
			dependencies: [LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Markdown editor", "Docs", "Prompt editor"],
		},
		{
			id: "collaboration.threadsAsObjects",
			title: "Threads as Objects",
			shortDescription: "Persist collaboration threads as first-class objects.",
			longDescription:
				"Durable comment threads anchored to Project-OS objects: comments live in Postgres (comment_threads/comments), sync to clients via Electric, and surface in the object-details panel. Liveblocks is an optional realtime accelerator, not a dependency.",
			maturity: "preview",
			implementationStatus: "ready",
			dependencies: [LIVEBLOCKS_PROVIDER_OPTIONAL, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Comments", "Tasks", "Object details"],
		},
		{
			id: "collaboration.inlineComments",
			title: "Inline Comments",
			shortDescription: "Attach discussion to text, code, and task fields.",
			longDescription:
				"Prepares inline comment affordances that can resolve into tasks, agent prompts, or room discussion.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Editor", "Diff viewer", "Task details"],
		},
		{
			id: "collaboration.taskBoard",
			title: "Collaborative Task Board",
			shortDescription: "Coordinate task state with shared presence.",
			longDescription:
				"Adds real-time-ready task board updates, participant indicators, and object-linked discussion controls.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Task board", "Workspace dashboard", "Rooms"],
		},
		{
			id: "collaboration.canvas",
			title: "Shared Canvas",
			shortDescription:
				"Brainstorm and map project objects in a shared canvas.",
			longDescription:
				"Creates the gated foundation for Liveblocks-backed diagrams, maps, and planning canvases.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Planning board", "Rooms", "Project docs"],
		},
		{
			id: "collaboration.aiToolbar",
			title: "AI Toolbar",
			shortDescription:
				"Offer shared AI actions inside collaborative surfaces.",
			longDescription:
				"Adds a toolbar contract for summarizing, rewriting, linking, and dispatching work from shared context.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LIVEBLOCKS_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Editor", "Canvas", "Threads"],
		},
		{
			id: "collaboration.mentionsNotifications",
			title: "Mentions and Notifications",
			shortDescription: "Notify users and agents from collaborative threads.",
			longDescription:
				"Controls mention parsing, notification routing, and agent-targeted assignments from shared comments.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Notifications", "Threads", "Agent inbox"],
		},
		{
			id: "collaboration.durableSnapshots",
			title: "Durable Snapshots",
			shortDescription: "Capture shared room state as reviewable snapshots.",
			longDescription:
				"Prepares room and document snapshotting for handoff, audit, replay, and public share workflows.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [LIVEBLOCKS_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Public shares", "Rooms", "Review history"],
		},
		{
			id: "collaboration.agentParticipant",
			title: "Agent Participant",
			shortDescription:
				"Let agents join collaborative work as named participants.",
			longDescription:
				"Adds state and UI contracts for agent avatars, comments, edits, and room participation.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Rooms", "Threads", "Agent activity"],
		},
	]),
	...defineCategory("live", "live-operations", [
		{
			id: "live.voiceRooms",
			title: "Voice Rooms",
			shortDescription: "Create LiveKit-backed voice rooms for workspaces.",
			longDescription:
				"Adds the user-facing control for real-time voice rooms attached to workspaces, tasks, and projects.",
			maturity: "alpha",
			implementationStatus: "ready",
			dependencies: [LIVEKIT_PROVIDER],
			affectedSurfaces: ["Rooms", "Workspace header", "Meeting notes"],
		},
		{
			id: "live.agentParticipant",
			title: "Live Agent Participant",
			shortDescription: "Invite voice agents into live rooms.",
			longDescription:
				"Controls LiveKit Agents participation for summarization, action capture, and live task dispatch.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Voice rooms", "Agent console", "Meeting notes"],
		},
		{
			id: "live.transcript",
			title: "Live Transcript",
			shortDescription: "Capture transcripts from live voice sessions.",
			longDescription:
				"Live Room Activity shell: a presence + speaking-activity panel for an active voice room (roster, who is speaking now, and a timestamped join/leave/speak log). No STT yet — transcript capture, chunking, and room-object linking land on top of this surface.",
			maturity: "alpha",
			implementationStatus: "ready",
			dependencies: [LIVEKIT_PROVIDER],
			affectedSurfaces: ["Voice rooms", "Meeting notes", "Search"],
		},
		{
			id: "live.meetingSummary",
			title: "Meeting Summary",
			shortDescription:
				"Summarize calls into decisions, tasks, and follow-ups.",
			longDescription:
				"Adds a gated summary pipeline for converting transcripts into project artifacts and task changes.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Meeting notes", "Tasks", "Project OS"],
		},
		{
			id: "live.contextualDispatch",
			title: "Contextual Dispatch",
			shortDescription: "Dispatch agents from live conversation context.",
			longDescription:
				"Controls a workflow that turns live room context into bounded agent tasks with source links.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Voice rooms", "Agent launcher", "Task creation"],
		},
		{
			id: "live.voiceCommands",
			title: "Voice Commands",
			shortDescription: "Trigger Rox commands by voice in live rooms.",
			longDescription:
				"Adds voice-command affordances for creating tasks, opening rooms, assigning agents, and capturing notes.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Command palette", "Voice rooms", "Workspace actions"],
		},
		{
			id: "live.pushToTalkDesktop",
			title: "Push-to-Talk Desktop",
			shortDescription: "Use desktop push-to-talk controls for live rooms.",
			longDescription:
				"Registers a configurable desktop global shortcut that toggles the active voice room's microphone (toggle-to-talk; Electron global accelerators are press-only). The shortcut is armed only while a room is connected and is rebindable in Settings → Keyboard.",
			maturity: "alpha",
			implementationStatus: "ready",
			dependencies: [LIVEKIT_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Global shortcuts", "Voice rooms", "Settings"],
		},
		{
			id: "live.customerCallCapture",
			title: "Customer Call Capture",
			shortDescription: "Capture customer calls into linked product evidence.",
			longDescription:
				"Adds a call capture workflow that turns voice sessions into transcripts, insights, tasks, and roadmap links.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, HULY_PROVIDER],
			affectedSurfaces: ["Voice rooms", "Project OS", "Customer evidence"],
		},
		{
			id: "live.multiAgentStandup",
			title: "Multi-Agent Standup",
			shortDescription: "Run live standups with agents and team members.",
			longDescription:
				"Controls a live standup room where agents report state, capture blockers, and update project objects.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Rooms", "Agent console", "Project OS"],
		},
		{
			id: "live.agentConsole",
			title: "Live Agent Console",
			shortDescription: "Monitor live agent participation and actions.",
			longDescription:
				"Prepares a console for live room agents, including status, transcript context, and dispatched actions.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Agent console", "Voice rooms", "Run history"],
		},
	]),
	...defineCategory("project-os", "project-platform", [
		{
			id: "projectOs.hulyImport",
			title: "Huly Import",
			shortDescription:
				"Optionally import Huly objects into the Rox object graph.",
			longDescription:
				"Optional import connector that maps issues, projects, customers, documents, and relationships from Huly into the native Rox entities/edges graph. Huly is not required for Project OS; this connector only activates when Huly is configured.",
			maturity: "preview",
			implementationStatus: "planned",
			dependencies: [HULY_PROVIDER],
			affectedSurfaces: ["Project settings", "Import wizard", "Object graph"],
		},
		{
			id: "projectOs.workspaceShell",
			title: "Workspace Shell",
			shortDescription:
				"Operate a project's native object graph (objects, links, search).",
			longDescription:
				"A unified project operating shell over the native Rox object graph (entities/edges): lists the project's objects, opens an object-details panel with its incoming/outgoing linked objects, links any two objects, and runs an edge-walking search scoped to the project. Backed by the cloud graph router (graph.projectGraph / graph.link / graph.search) and surfaced on the desktop via ProjectObjectGraphLaunchpad behind this gate — no Huly required.",
			maturity: "preview",
			// Backed by a REAL gated surface: ProjectObjectGraphLaunchpad renders the
			// project object graph (graph.projectGraph), an ObjectDetailsPanel with
			// linked objects, a LinkPicker (graph.link), and project-scoped search
			// (graph.search). Depends only on the desktop runtime (always
			// "configured"), so it resolves `available` with no external provider.
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Workspace shell", "Project dashboard", "Navigation"],
		},
		{
			id: "projectOs.issueBoard",
			title: "Issue Board",
			shortDescription: "Group a project's tasks into a status board.",
			longDescription:
				"A native, org-wide issue/task board over the shipped Rox tasks: columns are the org's task statuses (task.statuses.list, position-ordered) and cards are the org's real tasks (task.list), grouped by status. Read-first. Project scoping is a documented follow-up: tasks are org-scoped (no v2_project_id) and are not mirrored into the entities graph, so there is no real task→project link to filter on yet — that linkage must land first. Huly objects and agent-generated work fold in later as their kinds land.",
			maturity: "preview",
			// Backed by a REAL gated surface: the `(agents)` web shell renders an
			// IssueBoardPanel (behind `resolveIssueBoardGate`) that groups the org's
			// real tasks into status columns using two SHIPPED queries —
			// `task.statuses.list` (columns) × `task.list` (cards) — via the pure
			// `groupTasksByStatus`. This is an ORG-WIDE status board; project scoping
			// is intentionally absent because `tasks` are org-scoped (no
			// `v2_project_id`) and are not mirrored into the entities graph, so there
			// is no real task→project link to filter on (a project-scoped board is a
			// documented follow-up that needs that linkage first).
			// The active org is the provider-configured signal; the only declared
			// dependency (`desktop-runtime`) is a `runtime` dep, so the resolver never
			// gates this web surface (same clean-flip precedent as
			// `projectOs.unifiedSearch` / `projectOs.objectLinkedChat`). HULY_PROVIDER is
			// dropped here — Project OS is native on the Rox object graph and Huly is an
			// optional import connector, never a gate (same demote as
			// `projectOs.workspaceShell`). No new query and no migration — tasks stay
			// org-scoped and statuses already exist; combining Huly-imported issues and
			// real project scoping are later additive steps. implementationStatus stays
			// `ready`: the org-wide board is real and works end-to-end today.
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Task board", "Project OS", "Search"],
		},
		{
			id: "projectOs.roadmapObjects",
			title: "Roadmap Objects",
			shortDescription: "Represent roadmap initiatives as linkable objects.",
			longDescription:
				"Adds a model for roadmap objects that can connect customer evidence, rooms, tasks, docs, and agent runs.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [HULY_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Roadmap", "Object details", "Customer evidence"],
		},
		{
			id: "projectOs.objectLinkedChat",
			title: "Object-Linked Chat",
			shortDescription:
				"Attach chat sessions to tasks, issues, and roadmap items.",
			longDescription:
				"Links a chat session to Project-OS objects over the native Rox object graph. The session's `agent_session` graph node is ensured on demand via `graph.create` (idempotent on a deterministic key → true get-or-create, no migration), then related to a picked object with `graph.link` (relation `about`/`references`); the session's existing links read back through `graph.neighbors`. Surfaced on the web agents session-detail page behind this gate. Backed entirely by the shipped graph router — no Huly, no new procedure.",
			maturity: "preview",
			// Backed by a REAL gated surface: the `(agents)` session-detail page
			// renders a SessionObjectLinkPanel (behind `resolveObjectLinkedChatGate`)
			// that ensures the session's `agent_session` node (`graph.create`,
			// deterministic idempotency key → get-or-create), finds a target with the
			// shipped `graph.search`, links session→object via `graph.link`
			// (`about`/`references`), and lists the session's outgoing links via
			// `graph.neighbors` (`mapSessionLinks`). The active org is the
			// provider-configured signal; the only declared dependency
			// (`desktop-runtime`) is a `runtime` dep, so the resolver never gates this
			// web surface (same clean-flip precedent as `projectOs.workspaceShell` /
			// `projectOs.unifiedSearch`). No new query and no migration — the graph
			// link/search/neighbors procedures already exist end-to-end.
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Chat", "Object details", "Task sidebar"],
		},
		{
			id: "projectOs.unifiedSearch",
			title: "Unified Search",
			shortDescription:
				"Search across objects, rooms, transcripts, and agents.",
			longDescription:
				"A unified entity-search entry point over the native Rox object graph: a debounced query runs the cloud `graph.search` (semantic with keyword auto-degrade) across the addressable object kinds (note/task/project/contact/feed/file) and renders the hits (title, kind badge, snippet), deep-linking each to its object. Backed by the shipped graph search router; Huly imports and live transcripts fold in later as their kinds land.",
			maturity: "preview",
			// Backed by a REAL gated surface: the `(agents)` web shell renders a
			// UnifiedSearchPanel (behind `resolveUnifiedSearchGate`) that calls the
			// shipped `graph.search` over the addressable object kinds and opens each
			// hit via its `rox://` deep link. The active org is the provider-configured
			// signal; the only declared dependency (`desktop-runtime`) is a `runtime`
			// dep, so the resolver never gates this web surface (same pattern as
			// `projectOs.workspaceShell`). No new query and no migration — `graph.search`
			// already exists end-to-end.
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Search", "Command palette", "Project OS"],
		},
		{
			id: "projectOs.meetingNotes",
			title: "Meeting Notes",
			shortDescription: "Link meeting notes to project objects.",
			longDescription:
				"Adds a meeting notes object type that can link transcripts, decisions, tasks, and roadmap items.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Meeting notes", "Project OS", "Search"],
		},
		{
			id: "projectOs.crmContacts",
			title: "CRM Contacts",
			shortDescription: "Track customer and stakeholder contacts as objects.",
			longDescription:
				"A CRM contacts surface over the native Rox object graph: the org's `kind=contact` nodes joined to their 1:1 `contacts` detail (display name, primary email, avatar, structured fields) are listed via `graph.listContacts`, and selecting a contact shows the objects it links to (calls, notes, tasks, projects) read back through `graph.neighbors`. Surfaced on the web agents app behind this gate. Backed entirely by the shipped graph router + `contacts` table — no Huly, no migration.",
			maturity: "preview",
			// Backed by a REAL gated surface: the `(agents)` web app renders a
			// CrmContactsPanel (behind `resolveCrmContactsGate`) that lists the org's
			// contact objects with the new read-only `graph.listContacts`
			// (`entities` kind=contact LEFT JOIN the shipped `contacts` detail table,
			// keyset-paginated like `graph.listByKind`) and opens a contact detail
			// that reads its linked objects via the shipped `graph.neighbors`
			// (`mapContactLinks`). The active org is the provider-configured signal;
			// the only declared dependency (`desktop-runtime`) is a `runtime` dep, so
			// the resolver never gates this web surface (same clean-flip precedent as
			// `projectOs.unifiedSearch` / `projectOs.objectLinkedChat`). Huly is
			// demoted to an optional import connector (never a gate) — the contact
			// objects are canonical on the Rox graph. No new entity_kind and no
			// migration: the `contact` kind + `contacts` table already ship.
			implementationStatus: "ready",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Customer evidence", "Project OS", "Search"],
		},
		{
			id: "projectOs.selfHostBridge",
			title: "Self-Host Bridge",
			shortDescription:
				"Optionally connect Rox project workflows to self-hosted Huly.",
			longDescription:
				"Optional connector for self-hosted Huly instances (endpoint configuration and object sync status). Project OS runs natively on the Rox object graph without it; this bridge only engages when self-hosted Huly is configured.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [HULY_PROVIDER],
			affectedSurfaces: ["Integrations", "Project settings", "Sync status"],
		},
		{
			id: "projectOs.futureModules",
			title: "Future Modules",
			shortDescription: "Reserve Project OS slots for future modules.",
			longDescription:
				"Adds a feature-gated extension area for upcoming Project OS modules without exposing unfinished UI by default.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Project OS", "Navigation", "Settings"],
		},
	]),
	...defineCategory("rooms", "workflow-platform", [
		{
			id: "rooms.templateLaunchpad",
			title: "Template Launchpad",
			shortDescription: "Start rooms and workspaces from templates.",
			longDescription:
				"Combines templates, agents, and project setup into a launchpad for repeatable team workflows.",
			maturity: "preview",
			implementationStatus: "stubbed",
			dependencies: [AGENT_NATIVE_TEMPLATES_PROVIDER, LOCAL_DESKTOP_RUNTIME],
			affectedSurfaces: ["Template gallery", "Rooms", "New project"],
		},
		{
			id: "rooms.agentWarRoom",
			title: "Agent War Room",
			shortDescription:
				"Coordinate multiple agents in a shared execution room.",
			longDescription:
				"Creates a room concept for planning, dispatching, observing, and reviewing multi-agent execution.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [AGENT_NATIVE_PROVIDER, LIVEBLOCKS_PROVIDER],
			affectedSurfaces: ["Rooms", "Agent console", "Run history"],
		},
		{
			id: "rooms.productStudio",
			title: "Product Studio",
			shortDescription: "Turn ideas into specs, tasks, and agent work.",
			longDescription:
				"Combines shared canvas, Project OS objects, templates, and agent actions into a product planning studio.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER, HULY_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Planning board", "Roadmap", "Agent launcher"],
		},
		{
			id: "rooms.incidentRoom",
			title: "Incident Room",
			shortDescription: "Run incident response with live voice and agents.",
			longDescription:
				"Combines LiveKit rooms, transcripts, task updates, and agent dispatch for incident coordination.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [
				LIVEKIT_PROVIDER,
				LIVEBLOCKS_PROVIDER,
				AGENT_NATIVE_PROVIDER,
			],
			affectedSurfaces: ["Rooms", "Live operations", "Task board"],
		},
		{
			id: "rooms.customerCallToRoadmap",
			title: "Customer Call to Roadmap",
			shortDescription: "Convert customer calls into roadmap evidence.",
			longDescription:
				"Links LiveKit call capture, Huly-style objects, transcripts, summaries, and roadmap updates.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, HULY_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Voice rooms", "Roadmap", "Customer evidence"],
		},
		{
			id: "rooms.multiAgentPlanningBoard",
			title: "Multi-Agent Planning Board",
			shortDescription: "Plan work with agent participants and shared boards.",
			longDescription:
				"Combines collaborative boards, Project OS objects, and agent delegation into a planning room.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Planning board", "Rooms", "Agent delegation"],
		},
		{
			id: "rooms.knowledgeCaptureLoop",
			title: "Knowledge Capture Loop",
			shortDescription:
				"Capture room outcomes into reusable project knowledge.",
			longDescription:
				"Turns live discussions, threads, and agent outputs into linked knowledge objects and memory bindings.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEBLOCKS_PROVIDER, AGENT_NATIVE_PROVIDER],
			affectedSurfaces: ["Knowledge", "Rooms", "Agent memory"],
		},
		{
			id: "rooms.codeReviewRoom",
			title: "Code Review Room",
			shortDescription:
				"Review code with shared context, comments, and agents.",
			longDescription:
				"Combines diff context, inline comments, voice discussion, and agent reviewers into one review room.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [
				LIVEBLOCKS_PROVIDER,
				LIVEKIT_PROVIDER,
				AGENT_NATIVE_PROVIDER,
				GITHUB_PROVIDER,
			],
			affectedSurfaces: ["Diff viewer", "Rooms", "Pull request workflow"],
		},
		{
			id: "rooms.voiceToPr",
			title: "Voice to PR",
			shortDescription: "Turn spoken intent into tasks, branches, and PRs.",
			longDescription:
				"Combines LiveKit voice capture, agent dispatch, and GitHub-linked execution for voice-driven pull requests.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [LIVEKIT_PROVIDER, AGENT_NATIVE_PROVIDER, GITHUB_PROVIDER],
			affectedSurfaces: [
				"Voice rooms",
				"Agent launcher",
				"Pull request workflow",
			],
		},
		{
			id: "rooms.operationsCommandCenter",
			title: "Operations Command Center",
			shortDescription:
				"Operate projects through rooms, agents, and live status.",
			longDescription:
				"Creates a combined operations surface for live status, agents, objects, incidents, and collaboration.",
			maturity: "alpha",
			implementationStatus: "planned",
			dependencies: [
				LIVEBLOCKS_PROVIDER,
				LIVEKIT_PROVIDER,
				AGENT_NATIVE_PROVIDER,
				HULY_PROVIDER,
			],
			affectedSurfaces: ["Operations dashboard", "Rooms", "Project OS"],
		},
	]),
] as const satisfies readonly ExperimentalFeatureDefinition[];

export type ExperimentalFeatureId =
	(typeof EXPERIMENTAL_FEATURES)[number]["id"];

const EXPERIMENTAL_FEATURE_LOOKUP = new Map<
	ExperimentalFeatureId,
	(typeof EXPERIMENTAL_FEATURES)[number]
>(
	EXPERIMENTAL_FEATURES.map((feature) => [
		feature.id as ExperimentalFeatureId,
		feature,
	]),
);

export const EXPERIMENTAL_FEATURE_IDS = EXPERIMENTAL_FEATURES.map(
	(feature) => feature.id,
) as ExperimentalFeatureId[];

export interface ExperimentalFeatureDisplayCopy {
	title: string;
	shortDescription: string;
	longDescription: string;
}

const EXPERIMENTAL_FEATURE_TITLE_RU: Readonly<
	Record<ExperimentalFeatureId, string>
> = {
	"agentNative.sourceMarketplace": "Маркетплейс источников",
	"agentNative.screenContextBus": "Шина контекста экрана",
	"agentNative.uiCommandRouter": "Маршрутизатор UI-команд",
	"agentNative.embeddedSurfaces": "Встроенные поверхности агентов",
	"agentNative.runReplay": "Повтор запуска",
	"agentNative.permissions": "Разрешения агентов",
	"agentNative.memoryBinding": "Привязка памяти",
	"agentNative.a2aDelegation": "Делегирование агенту",
	"agentNative.commandPalette": "Команды агентов в палитре",
	"agentNative.sharedActionModel": "Единая модель действий",
	"templates.marketplace": "Маркетплейс шаблонов",
	"templates.previewSandbox": "Предпросмотр шаблона",
	"templates.importWizard": "Импорт шаблонов",
	"templates.forkVersioning": "Форки и версии шаблонов",
	"templates.permissionsManifest": "Манифест разрешений",
	"templates.agentOnboarding": "Шаблоны онбординга агентов",
	"templates.dbMapper": "Маппинг данных из шаблона",
	"templates.evals": "Проверки качества шаблонов",
	"templates.seedGenerator": "Генератор стартовых данных",
	"templates.skillCompiler": "Компилятор навыков",
	"collaboration.presence": "Присутствие",
	"collaboration.editor": "Совместный редактор",
	"collaboration.threadsAsObjects": "Обсуждения как объекты",
	"collaboration.inlineComments": "Inline-комментарии",
	"collaboration.taskBoard": "Совместная доска задач",
	"collaboration.canvas": "Совместный canvas",
	"collaboration.aiToolbar": "AI-панель",
	"collaboration.mentionsNotifications": "Упоминания и уведомления",
	"collaboration.durableSnapshots": "Долговечные снимки",
	"collaboration.agentParticipant": "Агент как участник",
	"live.voiceRooms": "Голосовые комнаты",
	"live.agentParticipant": "Live-агент в комнате",
	"live.transcript": "Live-транскрипт",
	"live.meetingSummary": "Итоги встречи",
	"live.contextualDispatch": "Запуск из live-контекста",
	"live.voiceCommands": "Голосовые команды",
	"live.pushToTalkDesktop": "Кнопка разговора на desktop",
	"live.customerCallCapture": "Захват клиентских звонков",
	"live.multiAgentStandup": "Стендап с несколькими агентами",
	"live.agentConsole": "Live-консоль агента",
	"projectOs.hulyImport": "Импорт из Huly",
	"projectOs.workspaceShell": "Оболочка Project OS",
	"projectOs.issueBoard": "Доска задач",
	"projectOs.roadmapObjects": "Объекты roadmap",
	"projectOs.objectLinkedChat": "Чат, привязанный к объектам",
	"projectOs.unifiedSearch": "Единый поиск",
	"projectOs.meetingNotes": "Заметки встреч",
	"projectOs.crmContacts": "CRM-контакты",
	"projectOs.selfHostBridge": "Мост для self-host",
	"projectOs.futureModules": "Будущие модули",
	"rooms.templateLaunchpad": "Запуск комнаты из шаблона",
	"rooms.agentWarRoom": "Комната агентов",
	"rooms.productStudio": "Продуктовая студия",
	"rooms.incidentRoom": "Комната инцидента",
	"rooms.customerCallToRoadmap": "Звонок клиента в roadmap",
	"rooms.multiAgentPlanningBoard": "Доска планирования с агентами",
	"rooms.knowledgeCaptureLoop": "Цикл захвата знаний",
	"rooms.codeReviewRoom": "Комната ревью кода",
	"rooms.voiceToPr": "Голос в PR",
	"rooms.operationsCommandCenter": "Операционный центр",
};

const CATEGORY_FEATURE_COPY_RU: Readonly<
	Record<ExperimentalFeatureCategory, ExperimentalFeatureDisplayCopy>
> = {
	"agent-native": {
		title: "Agent-Native",
		shortDescription:
			"Включает возможности Agent-Native для источников, команд, разрешений и памяти.",
		longDescription:
			"Экспериментальная поверхность Agent-Native. Она доступна только там, где есть реальный runtime или безопасная панель управления; если требуется провайдер, страница показывает, что именно нужно настроить, без значений секретов.",
	},
	templates: {
		title: "Шаблоны",
		shortDescription:
			"Управляет созданием проектов, предпросмотром, манифестами разрешений и импортом шаблонов.",
		longDescription:
			"Экспериментальная поверхность шаблонов. Локальные шаблоны работают через desktop runtime, внешние каталоги требуют отдельной настройки источника шаблонов.",
	},
	collaboration: {
		title: "Совместная работа",
		shortDescription:
			"Управляет присутствием, совместным редактированием, обсуждениями и общим canvas.",
		longDescription:
			"Экспериментальная поверхность совместной работы. Готовые нативные сценарии открываются без внешнего провайдера, сценарии realtime требуют Liveblocks.",
	},
	live: {
		title: "Live-комнаты",
		shortDescription:
			"Управляет голосовыми комнатами, транскриптами, live-агентами и кнопкой разговора.",
		longDescription:
			"Экспериментальная live-поверхность. Голосовые сценарии требуют корректной настройки LiveKit; пока настройки нет, функции остаются видимыми здесь как диагностика, но не запускаются в продукте.",
	},
	"project-os": {
		title: "Project OS",
		shortDescription:
			"Управляет графом объектов проекта, досками задач, поиском, контактами и roadmap.",
		longDescription:
			"Экспериментальная поверхность Project OS. Нативный граф Rox является основным источником данных; внешние системы вроде Huly подключаются только как опциональный импорт.",
	},
	rooms: {
		title: "Объединённые процессы",
		shortDescription:
			"Управляет комнатами для шаблонов, планирования, incident response, ревью и live-операций.",
		longDescription:
			"Экспериментальная поверхность операционных комнат. Она объединяет шаблоны, агентов, live-контекст и объекты Project OS, но незавершённые сценарии остаются закрытыми вне этой панели.",
	},
};

const EXPERIMENTAL_FEATURE_SURFACE_LABELS_RU: Readonly<Record<string, string>> =
	{
		"Agent activity": "Активность агента",
		"Agent console": "Консоль агента",
		"Agent context": "Контекст агента",
		"Agent delegation": "Делегирование агентам",
		"Agent details": "Карточка агента",
		"Agent inbox": "Входящие агента",
		"Agent launcher": "Запуск агента",
		"Agent orchestration": "Оркестрация агентов",
		"Agent run history": "История запусков агента",
		"Agent settings": "Настройки агента",
		"Agent tools": "Инструменты агента",
		"Audit trail": "Аудит",
		Canvas: "Canvas",
		Chat: "Чат",
		"CI hints": "Подсказки CI",
		Comments: "Комментарии",
		"Command palette": "Палитра команд",
		"Command router": "Маршрутизатор команд",
		"Customer evidence": "Клиентские доказательства",
		"Data mapping": "Маппинг данных",
		"Diff viewer": "Просмотр diff",
		Docs: "Документы",
		Editor: "Редактор",
		"Editor surfaces": "Поверхности редактора",
		"Global search": "Глобальный поиск",
		"Global shortcuts": "Глобальные сочетания клавиш",
		"Import wizard": "Мастер импорта",
		Imports: "Импорты",
		Integrations: "Интеграции",
		Knowledge: "Знания",
		"Live operations": "Live-операции",
		"Markdown editor": "Markdown-редактор",
		"Meeting notes": "Заметки встреч",
		Navigation: "Навигация",
		"New project": "Новый проект",
		"New workspace": "Новое рабочее пространство",
		Notifications: "Уведомления",
		"Object details": "Детали объекта",
		"Object graph": "Граф объектов",
		Onboarding: "Онбординг",
		"Operations dashboard": "Операционная панель",
		Permissions: "Разрешения",
		"Planning board": "Доска планирования",
		"Preview panel": "Панель предпросмотра",
		"Project dashboard": "Панель проекта",
		"Project docs": "Документы проекта",
		"Project OS": "Project OS",
		"Project settings": "Настройки проекта",
		"Project setup": "Настройка проекта",
		"Prompt composer": "Поле промпта",
		"Prompt editor": "Редактор промпта",
		"Public shares": "Публичные ссылки",
		"Pull request workflow": "Процесс pull request",
		"Quality checks": "Проверки качества",
		Roadmap: "Roadmap",
		Rooms: "Комнаты",
		"Review history": "История ревью",
		"Review panel": "Панель ревью",
		"Run guardrails": "Ограничения запуска",
		"Run history": "История запусков",
		Search: "Поиск",
		"Security settings": "Настройки безопасности",
		Settings: "Настройки",
		"Skills library": "Библиотека навыков",
		"Source picker": "Выбор источника",
		"Sync status": "Статус синхронизации",
		"Task board": "Доска задач",
		"Task creation": "Создание задач",
		"Task details": "Детали задачи",
		"Task execution": "Исполнение задач",
		"Task seeding": "Стартовые задачи",
		"Task sidebar": "Сайдбар задачи",
		Tasks: "Задачи",
		Telemetry: "Телеметрия",
		"Template details": "Детали шаблона",
		"Template gallery": "Галерея шаблонов",
		"Template install": "Установка шаблона",
		Threads: "Обсуждения",
		"Upgrade flow": "Обновление",
		"Voice rooms": "Голосовые комнаты",
		"Workspace actions": "Действия рабочего пространства",
		"Workspace dashboard": "Панель рабочего пространства",
		"Workspace header": "Шапка рабочего пространства",
		"Workspace setup": "Настройка рабочего пространства",
		"Workspace shell": "Оболочка рабочего пространства",
		"Workspace sidebar": "Боковая панель рабочего пространства",
	};

export function getExperimentalFeatureDisplayCopy(
	feature: ExperimentalFeatureDefinition,
): ExperimentalFeatureDisplayCopy {
	const categoryCopy = CATEGORY_FEATURE_COPY_RU[feature.category];
	const title =
		EXPERIMENTAL_FEATURE_TITLE_RU[feature.id as ExperimentalFeatureId] ??
		feature.title;
	return {
		title,
		shortDescription: `${title}: ${categoryCopy.shortDescription}`,
		longDescription: `${title}. ${categoryCopy.longDescription}`,
	};
}

export function formatExperimentalFeatureSurfaceLabel(surface: string): string {
	return EXPERIMENTAL_FEATURE_SURFACE_LABELS_RU[surface] ?? surface;
}

export function isExperimentalFeatureId(
	id: string,
): id is ExperimentalFeatureId {
	return EXPERIMENTAL_FEATURE_LOOKUP.has(id as ExperimentalFeatureId);
}

export function getExperimentalFeatureDefinition(id: string) {
	return EXPERIMENTAL_FEATURE_LOOKUP.get(id as ExperimentalFeatureId);
}

export function listExperimentalFeatures(
	category?: ExperimentalFeatureCategory,
) {
	if (!category) return EXPERIMENTAL_FEATURES;
	return EXPERIMENTAL_FEATURES.filter(
		(feature) => feature.category === category,
	);
}

export function resolveExperimentalFeatureState(
	feature: ExperimentalFeatureDefinition | ExperimentalFeatureId,
	options: ResolveExperimentalFeatureStateOptions = {},
): ExperimentalFeatureState {
	const definition =
		typeof feature === "string"
			? getExperimentalFeatureDefinition(feature)
			: feature;

	if (!definition) {
		throw new Error(`Unknown experimental feature: ${feature}`);
	}

	const userOverride = options.overrides?.[definition.id] ?? null;
	const preferredEnabled = userOverride ?? definition.defaultEnabled;
	const blocked = options.killSwitches?.[definition.id] === true;
	const missingRequiredProviders = definition.dependencies.filter(
		(dependency) =>
			dependency.kind === "provider" &&
			dependency.required &&
			options.dependencies?.[dependency.id] !== "configured",
	);

	let availability: ExperimentalFeatureAvailability = "available";
	let reason: string | undefined;

	if (blocked) {
		availability = "blocked";
		reason = "Отключено глобальным переключателем безопасности.";
	} else if (missingRequiredProviders.length > 0) {
		availability = "needs_configuration";
		reason = formatMissingProviderReason(missingRequiredProviders);
	} else if (definition.implementationStatus !== "ready") {
		availability = "not_implemented";
		reason =
			definition.implementationStatus === "stubbed"
				? "Панель управления уже доступна; продуктовая поверхность ещё подключается."
				: "Функция запланирована и безопасно скрыта вне панели экспериментов.";
	}

	if (!preferredEnabled && !reason) {
		reason = "Отключено в Настройки > Эксперименты.";
	}

	return {
		id: definition.id as ExperimentalFeatureId,
		enabled: blocked ? false : preferredEnabled,
		defaultEnabled: definition.defaultEnabled,
		userOverride,
		availability,
		reason,
		dependencies: definition.dependencies,
		missingDependencies: missingRequiredProviders,
	};
}
