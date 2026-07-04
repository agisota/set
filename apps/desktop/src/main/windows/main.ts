import { join } from "node:path";
import { workspaces, worktrees } from "@rox/local-db";
import { eq } from "drizzle-orm";
import type { BrowserWindow } from "electron";
import { app, Notification, nativeTheme } from "electron";
import log from "electron-log/main";
import { createWindow } from "lib/electron-app/factories/windows/create";
import { createAppRouter } from "lib/trpc/routers";
import { localDb } from "main/lib/local-db";
import { logger } from "main/lib/logger";
import { NOTIFICATION_EVENTS, PLATFORM } from "shared/constants";
import {
	env,
	getWorkspaceName as getEnvWorkspaceName,
} from "shared/env.shared";
import type { AgentLifecycleEvent } from "shared/notification-types";
import { createIPCHandler } from "trpc-electron/main";
import { productName } from "~/package.json";
import { appState } from "../lib/app-state";
import { browserManager } from "../lib/browser/browser-manager";
import { getGlassWindowOptions } from "../lib/glass-window";
import { createApplicationMenu } from "../lib/menu";
import { playNotificationSound } from "../lib/notification-sound";
import { NotificationManager } from "../lib/notifications/notification-manager";
import {
	notificationsApp,
	notificationsEmitter,
} from "../lib/notifications/server";
import {
	extractWorkspaceIdFromUrl,
	getNotificationTitle,
	getWorkspaceName,
} from "../lib/notifications/utils";
import {
	getInitialWindowBounds,
	loadWindowState,
	saveWindowState,
} from "../lib/window-state";
import { getWorkspaceRuntimeRegistry } from "../lib/workspace-runtime";

// Singleton IPC handler to prevent duplicate handlers on window reopen (macOS)
let ipcHandler: ReturnType<typeof createIPCHandler> | null = null;

/**
 * Attach a secondary window (e.g. a tear-off popout, F52) to the singleton
 * trpc-electron handler so its renderer can call the same router as the main
 * window — making the popout a live view onto the one core-state. No-op until
 * the main window has constructed the handler.
 */
export function attachWindowToIpc(win: BrowserWindow): void {
	ipcHandler?.attachWindow(win);
}

/** Detach a secondary window from the singleton handler on close. */
export function detachWindowFromIpc(win: BrowserWindow): void {
	ipcHandler?.detachWindow(win);
}

function getWorkspaceNameFromDb(workspaceId: string | undefined): string {
	if (!workspaceId) return "Workspace";
	try {
		const workspace = localDb
			.select()
			.from(workspaces)
			.where(eq(workspaces.id, workspaceId))
			.get();
		const worktree = workspace?.worktreeId
			? localDb
					.select()
					.from(worktrees)
					.where(eq(worktrees.id, workspace.worktreeId))
					.get()
			: undefined;
		return getWorkspaceName({ workspace, worktree });
	} catch (error) {
		logger.error("[notifications] Failed to get workspace name:", error);
		return "Workspace";
	}
}

let currentWindow: BrowserWindow | null = null;

// Routers receive this getter so they always see the current window, not a stale reference
const getWindow = () => currentWindow;

// invalidate() alone may not rebuild corrupted GPU layers — a tiny resize
// forces Chromium to reconstruct the compositor layer tree.
const forceRepaint = (win: BrowserWindow) => {
	if (win.isDestroyed()) return;
	win.webContents.invalidate();
	if (win.isMaximized() || win.isFullScreen()) return;
	const [width, height] = win.getSize();
	win.setSize(width + 1, height);
	setTimeout(() => {
		if (!win.isDestroyed()) win.setSize(width, height);
	}, 32);
};

const focusAppWindow = (win: BrowserWindow) => {
	if (win.isDestroyed()) return;
	win.show();
	win.moveTop();
	if (PLATFORM.IS_MAC) {
		app.focus({ steal: true });
	} else {
		app.focus();
	}
	win.focus();
};

// GPU process restarts don't repaint existing compositor layers automatically.
app.on("child-process-gone", (_event, details) => {
	if (details.type === "GPU") {
		logger.warn("[main-window] GPU process gone:", details.reason);
		const win = getWindow();
		if (win) forceRepaint(win);
	}
});

export async function MainWindow() {
	const savedWindowState = loadWindowState();
	const initialBounds = getInitialWindowBounds(savedWindowState);
	let persistedZoomLevel = savedWindowState?.zoomLevel;

	const isDev = env.NODE_ENV === "development";
	const workspaceName = isDev ? getEnvWorkspaceName() : undefined;
	const windowTitle = workspaceName
		? `${productName} — ${workspaceName}`
		: productName;

	// Glass / vibrancy (themes-fonts epic). macOS-only, gated on the persisted
	// toggle (default on). When disabled or off-mac, an opaque backgroundColor
	// is used as before.
	const fallbackBackgroundColor = nativeTheme.shouldUseDarkColors
		? "#252525"
		: "#ffffff";
	const glassOptions = getGlassWindowOptions(
		appState.data.appearanceState,
		fallbackBackgroundColor,
	);

	const window = createWindow({
		id: "main",
		title: windowTitle,
		width: initialBounds.width,
		height: initialBounds.height,
		x: initialBounds.x,
		y: initialBounds.y,
		minWidth: 400,
		minHeight: 400,
		show: isDev,
		...glassOptions,
		center: initialBounds.center,
		movable: true,
		resizable: true,
		alwaysOnTop: false,
		autoHideMenuBar: true,
		frame: false,
		titleBarStyle: "hidden",
		trafficLightPosition: { x: 16, y: 16 },
		webPreferences: {
			preload: join(__dirname, "../preload/index.js"),
			webviewTag: true,
			// Isolate Electron session from system browser cookies
			// This ensures desktop uses bearer token auth, not web cookies
			partition: "persist:rox",
		},
	});

	createApplicationMenu();

	currentWindow = window;

	// macOS Sequoia+: background throttling can corrupt GPU compositor layers
	if (PLATFORM.IS_MAC) {
		window.webContents.setBackgroundThrottling(false);
	}

	if (isDev) {
		window.webContents.on(
			"console-message",
			(_event, level, message, line, sourceId) => {
				const shouldForward =
					level >= 2 ||
					message.includes("[stress]") ||
					message.includes("[main]");
				if (!shouldForward) return;

				const details = sourceId ? ` (${sourceId}:${line})` : "";
				const formatted = `[renderer-console] ${message}${details}`;
				if (level >= 3) {
					log.error(formatted);
				} else if (level >= 2) {
					log.warn(formatted);
				} else {
					log.info(formatted);
				}
			},
		);

		window.on("unresponsive", () => {
			log.warn("[main-window] Renderer became unresponsive", {
				url: window.webContents.getURL(),
			});
		});
		window.on("responsive", () => {
			log.info("[main-window] Renderer became responsive", {
				url: window.webContents.getURL(),
			});
		});
	}

	if (ipcHandler) {
		ipcHandler.attachWindow(window);
	} else {
		ipcHandler = createIPCHandler({
			router: createAppRouter(getWindow),
			windows: [window],
		});
	}

	const server = notificationsApp.listen(
		env.DESKTOP_NOTIFICATIONS_PORT,
		"127.0.0.1",
		() => {
			logger.info(
				`[notifications] Listening on http://127.0.0.1:${env.DESKTOP_NOTIFICATIONS_PORT}`,
			);
		},
	);

	const notificationManager = new NotificationManager({
		isSupported: () => Notification.isSupported(),
		createNotification: (opts) => new Notification(opts),
		playSound: playNotificationSound,
		onNotificationClick: (ids) => {
			window.show();
			window.focus();
			if (ids.workspaceId && ids.terminalId) {
				notificationsEmitter.emit(
					NOTIFICATION_EVENTS.FOCUS_V2_NOTIFICATION_SOURCE,
					{
						workspaceId: ids.workspaceId,
						source: { type: "terminal", id: ids.terminalId },
					},
				);
				return;
			}
			notificationsEmitter.emit(NOTIFICATION_EVENTS.FOCUS_TAB, ids);
		},
		getVisibilityContext: () => ({
			isFocused: window.isFocused(),
			currentWorkspaceId: extractWorkspaceIdFromUrl(
				window.webContents.getURL(),
			),
			tabsState: appState.data?.tabsState,
		}),
		getWorkspaceName: getWorkspaceNameFromDb,
		getNotificationTitle: (event) =>
			getNotificationTitle({
				tabId: event.tabId,
				paneId: event.paneId,
				tabs: appState.data?.tabsState?.tabs,
				panes: appState.data?.tabsState?.panes,
			}),
	});
	notificationManager.start();

	notificationsEmitter.on(
		NOTIFICATION_EVENTS.AGENT_LIFECYCLE,
		(event: AgentLifecycleEvent) => {
			notificationManager.handleAgentLifecycle(event);
		},
	);

	// Forward low-volume terminal lifecycle events to the renderer via the existing
	// notifications subscription. This is used only for correctness (e.g. clearing
	// stuck agent lifecycle statuses when terminal panes aren't mounted).
	getWorkspaceRuntimeRegistry()
		.getDefault()
		.terminal.on(
			"terminalExit",
			(event: {
				paneId: string;
				exitCode: number;
				signal?: number;
				reason?: "killed" | "exited" | "error";
			}) => {
				notificationsEmitter.emit(NOTIFICATION_EVENTS.TERMINAL_EXIT, {
					paneId: event.paneId,
					exitCode: event.exitCode,
					signal: event.signal,
					reason: event.reason,
				});
			},
		);

	// macOS Sequoia+: occluded/minimized windows can lose compositor layers
	if (PLATFORM.IS_MAC) {
		window.on("restore", () => {
			window.webContents.invalidate();
		});
		window.on("show", () => {
			window.webContents.invalidate();
		});
	}

	// Persist window bounds on move/resize so state survives app.exit(0)
	// (which skips the close handler — e.g. electron-vite SIGTERM during dev).
	// Gated by `initialized` so the initial maximize() doesn't immediately
	// write isMaximized: true back to disk before the user touches the window.
	let initialized = false;
	let hasCompletedFirstLoad = false;
	let saveTimeout: ReturnType<typeof setTimeout> | null = null;
	let initialShowTimeout: ReturnType<typeof setTimeout> | null = null;
	const showInitialWindow = (reason: string) => {
		if ((hasCompletedFirstLoad && window.isVisible()) || window.isDestroyed()) {
			return;
		}
		if (initialShowTimeout) {
			clearTimeout(initialShowTimeout);
			initialShowTimeout = null;
		}
		if (initialBounds.isMaximized && !window.isMaximized()) {
			window.maximize();
		}
		focusAppWindow(window);
		log.info("[main-window] Initial window shown", {
			reason,
			visible: window.isVisible(),
			url: window.webContents.getURL(),
		});
		initialized = true;
		hasCompletedFirstLoad = true;
	};
	const debouncedSave = () => {
		if (!initialized || window.isDestroyed()) return;
		if (saveTimeout) clearTimeout(saveTimeout);
		saveTimeout = setTimeout(() => {
			if (window.isDestroyed()) return;
			const isMaximized = window.isMaximized();
			const bounds = isMaximized
				? window.getNormalBounds()
				: window.getBounds();
			const zoomLevel = window.webContents.getZoomLevel();
			saveWindowState({
				x: bounds.x,
				y: bounds.y,
				width: bounds.width,
				height: bounds.height,
				isMaximized,
				zoomLevel,
			});
			persistedZoomLevel = zoomLevel;
		}, 500);
	};
	window.on("move", debouncedSave);
	window.on("resize", debouncedSave);
	window.webContents.on("zoom-changed", () => {
		setTimeout(() => {
			if (window.isDestroyed()) return;
			persistedZoomLevel = window.webContents.getZoomLevel();
			debouncedSave();
		}, 0);
	});

	window.webContents.on("did-finish-load", () => {
		logger.info("[main-window] Renderer loaded successfully");

		if (persistedZoomLevel !== undefined) {
			window.webContents.setZoomLevel(persistedZoomLevel);
		}

		showInitialWindow("did-finish-load");
	});

	window.webContents.on("dom-ready", () => {
		logger.info("[main-window] Renderer DOM ready");
		if (persistedZoomLevel !== undefined) {
			window.webContents.setZoomLevel(persistedZoomLevel);
		}
		showInitialWindow("dom-ready");
	});

	window.once("ready-to-show", () => {
		showInitialWindow("ready-to-show");
	});

	if (!isDev) {
		setTimeout(() => {
			if (window.isDestroyed() || window.webContents.isLoading()) return;
			if (persistedZoomLevel !== undefined) {
				window.webContents.setZoomLevel(persistedZoomLevel);
			}
			showInitialWindow("production-startup-guard");
		}, 500);
	}

	initialShowTimeout = setTimeout(() => {
		if (hasCompletedFirstLoad || window.isDestroyed()) return;
		logger.warn("[main-window] Showing window before renderer load completion");
		if (persistedZoomLevel !== undefined) {
			window.webContents.setZoomLevel(persistedZoomLevel);
		}
		showInitialWindow("load-timeout");
	}, 4000);

	if (!window.webContents.isLoading()) {
		logger.info(
			"[main-window] Renderer load completed before show handler setup",
		);
		if (persistedZoomLevel !== undefined) {
			window.webContents.setZoomLevel(persistedZoomLevel);
		}
		showInitialWindow("already-loaded");
	}

	window.webContents.on(
		"did-fail-load",
		(_event, errorCode, errorDescription, validatedURL) => {
			logger.error("[main-window] Failed to load renderer:");
			logger.error(`  Error code: ${errorCode}`);
			logger.error(`  Description: ${errorDescription}`);
			logger.error(`  URL: ${validatedURL}`);
			// Show the window anyway so user can see something is wrong
			window.show();
		},
	);

	window.webContents.on("render-process-gone", (_event, details) => {
		logger.error("[main-window] Renderer process gone:", details);
		log.error("[main-window] Renderer process gone", details);
	});

	window.webContents.on("preload-error", (_event, preloadPath, error) => {
		logger.error("[main-window] Preload script error:");
		logger.error(`  Path: ${preloadPath}`);
		logger.error(`  Error:`, error);
	});

	window.on("close", () => {
		// Save window state first, before any cleanup
		const isMaximized = window.isMaximized();
		const bounds = isMaximized ? window.getNormalBounds() : window.getBounds();
		const zoomLevel = window.webContents.getZoomLevel();
		saveWindowState({
			x: bounds.x,
			y: bounds.y,
			width: bounds.width,
			height: bounds.height,
			isMaximized,
			zoomLevel,
		});
		persistedZoomLevel = zoomLevel;

		browserManager.unregisterAll();
		server.close();
		notificationManager.dispose();
		notificationsEmitter.removeAllListeners();
		getWorkspaceRuntimeRegistry().getDefault().terminal.detachAllListeners();
		ipcHandler?.detachWindow(window);
		currentWindow = null;
	});

	return window;
}
