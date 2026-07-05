import {
	createHistory,
	type HistoryLocation,
	type RouterHistory,
} from "@tanstack/react-router";
// Type-only: erased at compile time (isolatedModules), so the route tree is NOT
// pulled into this import-time singleton. Used purely to derive — and keep in
// sync — the set of static (non-id-scoped) routes that are safe to cold-restore.
import type { FileRouteTypes } from "../../routeTree.gen";

const STORAGE_KEY = "router-history";
const MAX_ENTRIES = 100;

// Define the concrete history-state shape locally instead of deriving it from
// `HistoryLocation["state"]`. That derived type depends on the
// `declare module "@tanstack/history" { interface HistoryState }` augmentation,
// which is re-declared by several bundled @tanstack/* copies (react-router,
// router-core, router-plugin, router-generator, router-cli). Under some
// dependency-graph resolutions tsc merges those augmentations into a shape where
// a property collapses to `never`, surfacing as
// `TS2322: Type 'true' is not assignable to type 'never'` in this file. Pinning
// the state shape to exactly the keys we read/write keeps full type safety while
// making the module immune to that augmentation-ordering fragility.
type LocationState = {
	key?: string;
	__TSR_key?: string;
	__TSR_index: number;
} & Record<string, unknown>;

interface PersistedState {
	entries: string[];
	index: number;
}

export interface HistoryEntry {
	path: string;
	timestamp: number;
}

/**
 * The route a fresh launch should land on when the restored location is not
 * safely resolvable. `/` renders the index route, which redirects to the
 * authenticated home (`/workspace`).
 */
const HOME_PATH = "/";

/**
 * Every navigable route whose `to` path has no dynamic (`$`) segment.
 *
 * The persisted history can point at an id-scoped resource route (e.g.
 * `/project/<id>`, `/tasks/<id>`) captured in a previous session. On a fresh
 * launch that resource may not exist, so the route's loader `throw notFound()`s
 * and the app dead-ends on "404 — Страница не найдена" before any data loads.
 * Rather than deny-list the (open, ever-growing) set of id-scoped routes, we
 * *allow-list* the closed, statically-known safe set: any restored location not
 * in this set — every dynamic route, plus any stale/typo path — collapses to
 * {@link HOME_PATH}. A FUTURE id-scoped route is excluded automatically by the
 * `$` filter below (zero maintenance); a future *static* route trips the
 * compile-time exhaustiveness check and must be registered here.
 */
// `/spectre` is the standalone Spectre overlay-assistant surface. `/popout` is a
// tear-off pane window (F52). Both are rendered only in dedicated secondary
// windows (loaded at `#/spectre` / `#/popout`), opened on demand with their own
// payload, and are never navigated to or cold-restored in the main window — so
// they must NOT participate in the main-window cold-restore allow-list /
// exhaustiveness guard below.
type RestorableRouteCandidate = Exclude<
	FileRouteTypes["to"],
	"/spectre" | "/popout"
>;
type StaticRoutePath = {
	[K in RestorableRouteCandidate]: K extends `${string}$${string}` ? never : K;
}[RestorableRouteCandidate];

const RESTORABLE_STATIC_ROUTES = [
	"/",
	"/create-organization",
	"/sign-in",
	"/onboarding",
	"/onboarding/first-agent-action",
	"/onboarding/project",
	"/onboarding/workspace",
	"/settings",
	"/automations",
	"/calendar",
	"/canvas",
	"/cli",
	"/drive",
	"/email",
	"/inbox",
	"/journal",
	"/memory",
	"/notes",
	"/pipelines",
	"/quick-chat",
	"/saved-prompts",
	"/skills-library",
	"/tasks",
	"/v2-workspace",
	"/v2-workspaces",
	"/workspace",
	"/workspaces",
	"/new-project",
	"/settings/account",
	"/settings/agents",
	"/settings/agents/sources",
	"/settings/api-keys",
	"/settings/appearance",
	"/settings/behavior",
	"/settings/experimental",
	"/settings/git",
	"/settings/hosts",
	"/settings/integrations",
	"/settings/keyboard",
	"/settings/links",
	"/settings/models",
	"/settings/network-filter",
	"/settings/organization",
	"/settings/permissions",
	"/settings/presets",
	"/settings/projects",
	"/settings/ringtones",
	"/settings/security",
	"/settings/shares",
	"/settings/surfaces",
	"/settings/teams",
	"/settings/terminal",
	"/settings/voice",
] as const satisfies readonly StaticRoutePath[];

// Compile-time exhaustiveness guard (no runtime cost). `satisfies` above proves
// every listed path is a real static route (catches typos / removed routes).
// This pair proves the converse — every static route is listed: if a new static
// route is added to the generated `to` union but not registered above,
// `_MissingStaticRoute` becomes that path (not `never`), the conditional below
// resolves to `never`, and `const _exhaustive: never = true` fails typecheck.
type _MissingStaticRoute = Exclude<
	StaticRoutePath,
	(typeof RESTORABLE_STATIC_ROUTES)[number]
>;
const _exhaustive: _MissingStaticRoute extends never ? true : never = true;
void _exhaustive;

const RESTORABLE_STATIC_ROUTE_SET: ReadonlySet<string> = new Set(
	RESTORABLE_STATIC_ROUTES,
);

/**
 * Decide whether a restored history path is safe to reopen on a cold launch.
 *
 * Returns `true` only for paths in {@link RESTORABLE_STATIC_ROUTE_SET}; every
 * id-scoped route (e.g. `/project/<id>`) and any unknown/stale path returns
 * `false` so the caller can fall back to {@link HOME_PATH}. Pure and
 * layout-independent (operates on the normalized pathname only): the
 * generated-tree dependency is a compile-time *type*, so this stays unit
 * testable without the runtime route tree.
 */
export function isRestorableLocation(path: string): boolean {
	if (typeof path !== "string" || path.length === 0) return false;
	// Strip query/hash before inspecting the pathname.
	const pathname = path.split(/[?#]/, 1)[0] ?? path;
	if (!pathname.startsWith("/")) return false;
	// Normalize a trailing slash (except root) so `/settings/` matches the
	// slash-free `to` entry `/settings`; the router uses slash-free `to` paths.
	const normalized =
		pathname.length > 1 && pathname.endsWith("/")
			? pathname.slice(0, -1)
			: pathname;
	return RESTORABLE_STATIC_ROUTE_SET.has(normalized);
}

function loadPersistedState(): PersistedState {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (raw) {
			const parsed = JSON.parse(raw) as PersistedState;
			if (
				Array.isArray(parsed.entries) &&
				parsed.entries.length > 0 &&
				parsed.entries.every((e) => typeof e === "string" && e.length > 0) &&
				typeof parsed.index === "number"
			) {
				const index = Math.min(
					Math.max(parsed.index, 0),
					parsed.entries.length - 1,
				);
				// Guard the *restored current location* against cold-launch 404s: if
				// the entry we'd reopen points at an id-scoped resource route that may
				// not resolve this session, collapse the whole stack back to home so a
				// fresh launch lands on the index instead of "404 — Страница не
				// найдена". Static routes (incl. section indexes) restore unchanged.
				if (!isRestorableLocation(parsed.entries[index] ?? "")) {
					return { entries: [HOME_PATH], index: 0 };
				}
				return { entries: parsed.entries, index };
			}
		}
	} catch {}
	return { entries: [HOME_PATH], index: 0 };
}

function persistState(entries: string[], index: number) {
	try {
		const capped =
			entries.length > MAX_ENTRIES
				? entries.slice(entries.length - MAX_ENTRIES)
				: entries;
		const cappedIndex =
			entries.length > MAX_ENTRIES
				? Math.max(0, index - (entries.length - MAX_ENTRIES))
				: index;
		localStorage.setItem(
			STORAGE_KEY,
			JSON.stringify({ entries: capped, index: cappedIndex }),
		);
	} catch {}
}

function syncHash(path: string) {
	window.history.replaceState(window.history.state, "", `#${path}`);
}

function createRandomKey(): string {
	return (Math.random() + 1).toString(36).substring(7);
}

function assignKeyAndIndex(
	index: number,
	state?: LocationState,
): LocationState {
	const key = createRandomKey();
	return {
		...(state ?? {}),
		key,
		__TSR_key: key,
		__TSR_index: index,
	};
}

function parseHref(href: string, state: LocationState): HistoryLocation {
	const searchIndex = href.indexOf("?");
	const hashIndex = href.indexOf("#");
	return {
		href,
		pathname: href.substring(
			0,
			hashIndex > 0
				? searchIndex > 0
					? Math.min(hashIndex, searchIndex)
					: hashIndex
				: searchIndex > 0
					? searchIndex
					: href.length,
		),
		hash: hashIndex > -1 ? href.substring(hashIndex) : "",
		search:
			searchIndex > -1
				? href.slice(searchIndex, hashIndex === -1 ? undefined : hashIndex)
				: "",
		state,
	};
}

export interface PersistentHashHistory extends RouterHistory {
	getEntries: () => HistoryEntry[];
}

export function createPersistentHashHistory(): PersistentHashHistory {
	const persisted = loadPersistedState();

	const entries: string[] = [...persisted.entries];
	const timestamps: number[] = entries.map(() => Date.now());
	const states: LocationState[] = entries.map((_entry, i) =>
		assignKeyAndIndex(i),
	);
	let index = persisted.index;

	const getLocation = () =>
		parseHref(entries[index] ?? "/", states[index] ?? assignKeyAndIndex(index));

	let blockers: Parameters<
		NonNullable<Parameters<typeof createHistory>[0]["setBlockers"]>
	>[0] = [];

	syncHash(entries[index] ?? "/");

	const history = createHistory({
		getLocation,
		getLength: () => entries.length,
		pushState: (path, state) => {
			if (index < entries.length - 1) {
				entries.splice(index + 1);
				timestamps.splice(index + 1);
				states.splice(index + 1);
			}
			entries.push(path);
			timestamps.push(Date.now());
			states.push(state as LocationState);
			index = entries.length - 1;
			syncHash(path);
			persistState(entries, index);
		},
		replaceState: (path, state) => {
			entries[index] = path;
			timestamps[index] = Date.now();
			states[index] = state as LocationState;
			syncHash(path);
			persistState(entries, index);
		},
		back: () => {
			index = Math.max(index - 1, 0);
			syncHash(entries[index] ?? "/");
			persistState(entries, index);
		},
		forward: () => {
			index = Math.min(index + 1, entries.length - 1);
			syncHash(entries[index] ?? "/");
			persistState(entries, index);
		},
		go: (n) => {
			index = Math.min(Math.max(index + n, 0), entries.length - 1);
			syncHash(entries[index] ?? "/");
			persistState(entries, index);
		},
		createHref: (path) =>
			`${window.location.pathname}${window.location.search}#${path}`,
		getBlockers: () => blockers,
		setBlockers: (newBlockers) => {
			blockers = newBlockers;
		},
	});

	return Object.assign(history, {
		getEntries: (): HistoryEntry[] =>
			entries.map((path, i) => ({
				path,
				timestamp: timestamps[i] ?? 0,
			})),
	});
}

export const persistentHistory = createPersistentHashHistory();
