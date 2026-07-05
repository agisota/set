/**
 * Global test setup for Bun tests
 *
 * This file mocks EXTERNAL dependencies only:
 * - Electron APIs (app, dialog, BrowserWindow, ipcMain)
 * - Browser globals (document, window)
 * - trpc-electron renderer requirements
 *
 * DO NOT mock internal code here - tests should use real implementations
 * or mock at the individual test level when necessary.
 */
import { afterAll, afterEach, mock } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

process.env.NODE_ENV = "test";
process.env.SKIP_ENV_VALIDATION = "1";

const testTmpDir = join(tmpdir(), "rox-test");

// =============================================================================
// Global Snapshot / Teardown
// =============================================================================
//
// This file installs several mutable globals (`document`, `window`,
// `localStorage`, `electronTRPC`) and keeps in-memory state maps that
// accumulate across tests (`mockStyleMap`, `mockClassList`, the localStorage
// store). Bun runs all test files in a single worker process and shares
// `globalThis`, so without explicit teardown this state leaks across files and
// makes test outcomes order-dependent (a classic flake source).
//
// Strategy:
//   - Snapshot any pre-existing global we are about to overwrite, and restore
//     the original (or delete our shim) in afterAll.
//   - Reset the mutable accumulating state in afterEach so each test starts
//     from a clean slate regardless of what ran before it.
const GLOBAL_KEYS = [
	"document",
	"window",
	"localStorage",
	"electronTRPC",
] as const;

const globalSnapshot = new Map<string, { existed: boolean; value: unknown }>();
for (const key of GLOBAL_KEYS) {
	const existed = key in globalThis;
	globalSnapshot.set(key, {
		existed,
		value: existed ? (globalThis as Record<string, unknown>)[key] : undefined,
	});
}

// Hooks that reset / restore mutable global state. Definitions installed below
// push their reset callbacks here so a single afterEach/afterAll drives them.
const resetCallbacks: Array<() => void> = [];

afterEach(() => {
	for (const reset of resetCallbacks) reset();
});

afterAll(() => {
	for (const key of GLOBAL_KEYS) {
		const snap = globalSnapshot.get(key);
		if (!snap) continue;
		if (snap.existed) {
			(globalThis as Record<string, unknown>)[key] = snap.value;
		} else {
			delete (globalThis as Record<string, unknown>)[key];
		}
	}
});

// =============================================================================
// Browser Global Mocks (required for renderer code that touches DOM)
// =============================================================================

const mockStyleMap = new Map<string, string>();
const mockClassList = new Set<string>();

// Reset DOM-style accumulating state between tests so CSS variables / classes
// set by one test do not bleed into the next.
resetCallbacks.push(() => {
	mockStyleMap.clear();
	mockClassList.clear();
});

const mockHead = {
	appendChild: mock(() => {}),
	removeChild: mock(() => {}),
};

// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
(globalThis as any).document = {
	addEventListener: mock(() => {}),
	removeEventListener: mock(() => {}),
	documentElement: {
		style: {
			setProperty: (key: string, value: string) => mockStyleMap.set(key, value),
			getPropertyValue: (key: string) => mockStyleMap.get(key) || "",
		},
		classList: {
			add: (className: string) => mockClassList.add(className),
			remove: (className: string) => mockClassList.delete(className),
			toggle: (className: string) => {
				mockClassList.has(className)
					? mockClassList.delete(className)
					: mockClassList.add(className);
			},
			contains: (className: string) => mockClassList.has(className),
		},
	},
	head: mockHead,
	getElementsByTagName: mock((tag: string) => {
		if (tag === "head") return [mockHead];
		return [];
	}),
	createElement: mock((_tag: string) => ({
		setAttribute: mock(() => {}),
		appendChild: mock(() => {}),
		textContent: "",
		type: "",
	})),
	createTextNode: mock((text: string) => ({
		textContent: text,
	})),
};

// Ensure window has addEventListener/removeEventListener for react-hotkeys-hook's IIFE
if (typeof globalThis.window !== "undefined") {
	const win = globalThis.window as Record<string, unknown>;
	if (!win.addEventListener) win.addEventListener = mock(() => {});
	if (!win.removeEventListener) win.removeEventListener = mock(() => {});
} else {
	// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
	(globalThis as any).window = {
		addEventListener: mock(() => {}),
		removeEventListener: mock(() => {}),
	};
}

// =============================================================================
// localStorage Shim (zustand `persist` defaults to window.localStorage)
// =============================================================================

// Bun's test runtime has no DOM Storage, so persisted zustand stores throw
// `undefined is not an object (evaluating 'storage.setItem')` at module load.
// Provide a minimal in-memory implementation matching the Web Storage API.
if (typeof globalThis.localStorage === "undefined") {
	const store = new Map<string, string>();
	const localStorageShim: Storage = {
		get length() {
			return store.size;
		},
		clear: () => store.clear(),
		getItem: (key: string) => store.get(key) ?? null,
		key: (index: number) => Array.from(store.keys())[index] ?? null,
		removeItem: (key: string) => {
			store.delete(key);
		},
		setItem: (key: string, value: string) => {
			store.set(key, String(value));
		},
	};
	// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
	(globalThis as any).localStorage = localStorageShim;

	// Clear persisted entries between tests so zustand-persisted stores don't
	// carry state from one test file into the next.
	resetCallbacks.push(() => store.clear());
}

// =============================================================================
// Electron Preload Mocks (exposed via contextBridge in real app)
// =============================================================================

// trpc-electron expects this global for renderer-side communication
// biome-ignore lint/suspicious/noExplicitAny: Test setup requires extending globalThis
(globalThis as any).electronTRPC = {
	sendMessage: () => {},
	onMessage: (_callback: (msg: unknown) => void) => {},
};

// =============================================================================
// Electron Module Mock (the actual electron package)
// =============================================================================

mock.module("electron", () => ({
	app: {
		getPath: mock(() => testTmpDir),
		getName: mock(() => "test-app"),
		getVersion: mock(() => "1.0.0"),
		getAppPath: mock(() => testTmpDir),
		isPackaged: false,
	},
	dialog: {
		showOpenDialog: mock(() =>
			Promise.resolve({ canceled: false, filePaths: [] }),
		),
		showSaveDialog: mock(() =>
			Promise.resolve({ canceled: false, filePath: "" }),
		),
		showMessageBox: mock(() => Promise.resolve({ response: 0 })),
	},
	BrowserWindow: mock(() => ({
		webContents: { send: mock() },
		loadURL: mock(),
		on: mock(),
	})),
	ipcMain: {
		handle: mock(),
		on: mock(),
	},
	shell: {
		openExternal: mock(() => Promise.resolve()),
		openPath: mock(() => Promise.resolve("")),
	},
	clipboard: {
		writeText: mock(),
		readText: mock(() => ""),
	},
	screen: {
		getPrimaryDisplay: mock(() => ({
			workAreaSize: { width: 1920, height: 1080 },
			bounds: { x: 0, y: 0, width: 1920, height: 1080 },
		})),
		getAllDisplays: mock(() => [
			{
				bounds: { x: 0, y: 0, width: 1920, height: 1080 },
				workAreaSize: { width: 1920, height: 1080 },
			},
		]),
	},
	Notification: mock(() => ({
		show: mock(),
		on: mock(),
	})),
	Menu: {
		buildFromTemplate: mock(() => ({})),
		setApplicationMenu: mock(),
	},
}));

// =============================================================================
// Analytics Mock (has Electron/API dependencies)
// =============================================================================

mock.module("main/lib/analytics", () => ({
	track: mock(() => {}),
	clearUserCache: mock(() => {}),
	shutdown: mock(() => Promise.resolve()),
	getPosthogClient: mock(() => null),
	getUserId: mock(() => null),
	setUserId: mock(() => {}),
}));

// =============================================================================
// @rox/local-db Schema Mock (drizzle-orm/sqlite-core not available in Bun tests)
// =============================================================================

const mockTable = (name: string) => ({ id: `${name}_id` });

const agentPresetOverrideSchema = z.object({
	id: z.string(),
	enabled: z.boolean().optional(),
	label: z.string().optional(),
	description: z.string().nullable().optional(),
	command: z.string().optional(),
	promptCommand: z.string().optional(),
	promptCommandSuffix: z.string().nullable().optional(),
	taskPromptTemplate: z.string().optional(),
	contextPromptTemplateSystem: z.string().optional(),
	contextPromptTemplateUser: z.string().optional(),
	model: z.string().optional(),
});

const agentPresetOverrideEnvelopeSchema = z.object({
	version: z.literal(1),
	presets: z.array(agentPresetOverrideSchema),
});

const agentCustomDefinitionSchema = z.object({
	id: z.string().regex(/^custom:/),
	kind: z.literal("terminal"),
	label: z.string(),
	description: z.string().optional(),
	command: z.string(),
	promptCommand: z.string().optional(),
	promptCommandSuffix: z.string().optional(),
	promptTransport: z.enum(["argv", "stdin"]).optional(),
	taskPromptTemplate: z.string(),
	contextPromptTemplateSystem: z.string().optional(),
	contextPromptTemplateUser: z.string().optional(),
	enabled: z.boolean().optional(),
});

const localDbMock = () => ({
	DEFAULT_SETTINGS_BRANCH_PREFIX_CUSTOM: "rox",
	DEFAULT_SETTINGS_BRANCH_PREFIX_MODE: "custom",
	DEFAULT_SETTINGS_EDITOR_FONT_FAMILY: "SF UI Display Pro",
	DEFAULT_SETTINGS_EDITOR_FONT_SIZE: 12,
	DEFAULT_SETTINGS_TERMINAL_FONT_FAMILY: "Geist Mono",
	DEFAULT_SETTINGS_TERMINAL_FONT_SIZE: 12,
	DEFAULT_SETTINGS_UI_FONT_FAMILY: "SF UI Display Pro",
	DEFAULT_SETTINGS_UI_FONT_SIZE: 12,
	projects: mockTable("projects"),
	workspaces: mockTable("workspaces"),
	worktrees: mockTable("worktrees"),
	settings: mockTable("settings"),
	users: mockTable("users"),
	organizations: mockTable("organizations"),
	organizationMembers: mockTable("organization_members"),
	tasks: mockTable("tasks"),
	workspaceSections: mockTable("workspace_sections"),
	agentPresetOverrideSchema,
	agentPresetOverrideEnvelopeSchema,
	agentCustomDefinitionSchema,
	PROMPT_TRANSPORTS: ["argv", "stdin"],
	EXTERNAL_APPS: [],
	EXECUTION_MODES: [
		"split-pane",
		"new-tab",
		"new-tab-split-pane",
		"sequential",
	],
	BRANCH_PREFIX_MODES: ["none", "github", "author", "custom"],
	TERMINAL_LINK_BEHAVIORS: ["external-editor", "file-viewer"],
	FILE_OPEN_MODES: ["split-pane", "new-tab"],
});

// Mock both the package name and the resolved source path to handle
// bun's workspace package resolution in different versions.
mock.module("@rox/local-db", localDbMock);
mock.module("@rox/local-db/schema", localDbMock);

// =============================================================================
// Local DB Mock (better-sqlite3 not supported in Bun tests)
// =============================================================================

mock.module("main/lib/local-db", () => ({
	localDb: {
		select: mock(() => ({
			from: mock(() => ({
				where: mock(() => ({
					get: mock(() => null),
					all: mock(() => []),
				})),
				get: mock(() => null),
				all: mock(() => []),
			})),
		})),
		insert: mock(() => ({
			values: mock(() => ({
				returning: mock(() => ({
					get: mock(() => ({ id: "test-id" })),
				})),
				onConflictDoUpdate: mock(() => ({
					run: mock(),
				})),
				run: mock(),
			})),
		})),
		update: mock(() => ({
			set: mock(() => ({
				where: mock(() => ({
					run: mock(),
					returning: mock(() => ({
						get: mock(() => ({ id: "test-id" })),
					})),
				})),
			})),
		})),
		delete: mock(() => ({
			where: mock(() => ({
				run: mock(),
			})),
		})),
	},
}));
