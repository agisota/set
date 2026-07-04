// Import first: computing ROX_HOME_DIR runs the one-time ~/.rox -> ~/rox
// migration as a module-load side effect, before any other module reads it.
import { logger } from "main/lib/logger";
import "./lib/app-environment";
import { once } from "node:events";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { settings } from "@rox/local-db";
import {
	app,
	BrowserWindow,
	dialog,
	globalShortcut,
	Notification,
	net,
	protocol,
	session,
} from "electron";
import { makeAppSetup } from "lib/electron-app/factories/app/setup";
import {
	handleAuthCallback,
	loadToken,
	parseAuthDeepLink,
} from "lib/trpc/routers/auth/utils/auth-functions";
import { setPopoutManager } from "lib/trpc/routers/popout";
import { setSpectreManager } from "lib/trpc/routers/spectre";
import { applyShellEnvToProcess } from "lib/trpc/routers/workspaces/utils/shell-env";
import { env as mainEnv } from "main/env.main";
import {
	DEFAULT_CONFIRM_ON_QUIT,
	PLATFORM,
	PROTOCOL_SCHEME,
} from "shared/constants";
import { setupAgentHooks } from "./lib/agent-setup";
import { initAppState } from "./lib/app-state";
import { requestAppleEventsAccess } from "./lib/apple-events-permission";
import { isUpdateReadyToInstall, setupAutoUpdater } from "./lib/auto-updater";
import { installBundledCliShim } from "./lib/bundled-cli";
import { resolveDevWorkspaceName } from "./lib/dev-workspace-name";
import { setWorkspaceDockIcon } from "./lib/dock-icon";
import { loadWebviewBrowserExtension } from "./lib/extensions";
import { getHostServiceCoordinator } from "./lib/host-service-coordinator";
import { localDb } from "./lib/local-db";
import { requestLocalNetworkAccess } from "./lib/local-network-permission";
import {
	initTanstackDbPersistence,
	shutdownTanstackDbPersistence,
} from "./lib/persistence/persistence";
import { ensureCatalogInstalled } from "./lib/preinstall-catalog";
import { ensureProjectIconsDir, getProjectIconPath } from "./lib/project-icons";
import { disposePushToTalkShortcut } from "./lib/push-to-talk";
import { initSentry } from "./lib/sentry";
import {
	registerSpectreShortcut,
	unregisterSpectreShortcut,
} from "./lib/spectre-shortcut/spectreShortcut";
import {
	prewarmTerminalRuntime,
	reconcileDaemonSessions,
} from "./lib/terminal";
import {
	disposeTerminalHostClient,
	getTerminalHostClient,
} from "./lib/terminal-host/client";
import { disposeTray, initTray } from "./lib/tray";
import { startNetworkLogger, stopNetworkLogger } from "./network-logger";
import {
	attachWindowToIpc,
	detachWindowFromIpc,
	MainWindow,
} from "./windows/main";
import {
	createPopoutWindow,
	loadPopout,
	PopoutWindowManager,
} from "./windows/popout";
import {
	createSpectreWindow,
	loadSpectre,
	SpectreWindowManager,
} from "./windows/spectre";

logger.info("[main] Local database ready:", !!localDb);
const IS_DEV = process.env.NODE_ENV === "development";

void applyShellEnvToProcess().catch((error) => {
	logger.error("[main] Failed to apply shell environment:", error);
});

// Dev mode: label the app with the workspace name so multiple worktrees are distinguishable
if (IS_DEV) {
	const workspaceName = resolveDevWorkspaceName();
	if (workspaceName) {
		app.setName(`Rox (${workspaceName})`);
	}
}

// Dev mode: register with execPath + app script so macOS launches Electron with our entry point
if (process.defaultApp) {
	if (process.argv.length >= 2) {
		app.setAsDefaultProtocolClient(PROTOCOL_SCHEME, process.execPath, [
			path.resolve(process.argv[1]),
		]);
	}
} else {
	app.setAsDefaultProtocolClient(PROTOCOL_SCHEME);
}

async function processDeepLink(url: string): Promise<void> {
	logger.info("[main] Processing deep link:", url);

	const authParams = parseAuthDeepLink(url);
	if (authParams) {
		const result = await handleAuthCallback(authParams);
		if (result.success) {
			focusMainWindow();
		} else {
			logger.error("[main] Auth deep link failed:", result.error);
		}
		return;
	}

	// Non-auth deep links: derive a safe internal path and navigate in renderer.
	// e.g. rox://tasks/my-slug -> /tasks/my-slug
	// `rox://` URLs can be triggered by any web page, so parse defensively:
	// drop any query/fragment and collapse to a single internal path so a
	// crafted link can't smuggle in a protocol-relative "//host" redirect.
	let path: string;
	try {
		const parsed = new URL(url);
		path = `/${parsed.host}${parsed.pathname}`.replace(/\/{2,}/g, "/");
		if (path.length > 1) {
			path = path.replace(/\/+$/, "");
		}
	} catch {
		logger.error("[main] Ignoring malformed deep link:", url);
		return;
	}
	const window = await resolveLoadedMainWindow();
	window?.webContents.send("deep-link-navigate", path);
}

function findDeepLinkInArgv(argv: string[]): string | undefined {
	return argv.find((arg) => arg.startsWith(`${PROTOCOL_SCHEME}://`));
}

export function focusMainWindow(): void {
	const windows = BrowserWindow.getAllWindows();
	if (windows.length > 0) {
		const mainWindow = windows[0];
		if (mainWindow.isMinimized()) {
			mainWindow.restore();
		}
		mainWindow.show();
		mainWindow.moveTop();
		if (process.platform === "darwin") {
			app.focus({ steal: true });
		} else {
			app.focus();
		}
		mainWindow.focus();
	} else {
		// Triggers window creation via makeAppSetup's activate handler
		app.emit("activate");
	}
}

/**
 * Bring up the main window (creating it if every window was closed) and resolve
 * only once its renderer has loaded — so a deep-link `webContents.send` isn't
 * dropped because the window is still being created or hasn't mounted its IPC
 * listeners yet. Bounded by timeouts so a failed creation can never hang.
 */
async function resolveLoadedMainWindow(): Promise<BrowserWindow | null> {
	focusMainWindow();
	let window = BrowserWindow.getAllWindows()[0] ?? null;
	if (!window) {
		// focusMainWindow() emitted "activate", which (re)creates the window
		// asynchronously — wait for it instead of racing getAllWindows().
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		try {
			const [, created] = (await once(app, "browser-window-created", {
				signal: controller.signal,
			})) as [unknown, BrowserWindow];
			window = created;
		} catch {
			window = BrowserWindow.getAllWindows()[0] ?? null;
		} finally {
			clearTimeout(timer);
		}
	}
	if (!window) {
		return null;
	}
	if (window.webContents.isLoading()) {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), 10_000);
		try {
			await once(window.webContents, "did-finish-load", {
				signal: controller.signal,
			});
		} catch {
			// Renderer didn't finish loading in time — send anyway; no worse than
			// the previous unconditional send and it may already be interactive.
		} finally {
			clearTimeout(timer);
		}
	}
	return window;
}

function registerWithMacOSNotificationCenter() {
	if (!PLATFORM.IS_MAC || !Notification.isSupported()) return;

	const registrationNotification = new Notification({
		title: app.name,
		body: " ",
		silent: true,
	});

	let handled = false;
	const cleanup = () => {
		if (handled) return;
		handled = true;
		registrationNotification.close();
	};

	registrationNotification.on("show", () => {
		cleanup();
		logger.info("[notifications] Registered with Notification Center");
	});

	// Fallback timeout in case macOS doesn't fire events
	setTimeout(cleanup, 1000);

	registrationNotification.show();
}

// macOS open-url can fire before the window exists (cold-start via protocol link).
// Queue the URL and process it after initialization.
let pendingDeepLinkUrl: string | null = null;
let appReady = false;

app.on("open-url", async (event, url) => {
	event.preventDefault();
	if (appReady) {
		await processDeepLink(url);
	} else {
		pendingDeepLinkUrl = url;
	}
});

let isQuitting = false;
let skipQuitConfirmation = false;
let forceFullCleanup = false;
// Spectre overlay assistant — created in whenReady, torn down on before-quit.
let spectreManager: SpectreWindowManager | null = null;
// Tear-off / popout window registry (F52) — created in whenReady, destroyed on
// before-quit so detached panes never outlive the app.
let popoutManager: PopoutWindowManager | null = null;

export function setSkipQuitConfirmation(): void {
	skipQuitConfirmation = true;
}

export function quitApp(): void {
	setSkipQuitConfirmation();
	app.quit();
}

/** Quit + also stop background services. Tray "Quit Completely". */
export function quitAppCompletely(): void {
	forceFullCleanup = true;
	setSkipQuitConfirmation();
	app.quit();
}

/** Bypasses before-quit. Host-service children self-exit via the parent watchdog. */
export function exitImmediately(): void {
	app.exit(0);
}

function getConfirmOnQuitSetting(): boolean {
	try {
		const row = localDb.select().from(settings).get();
		return row?.confirmOnQuit ?? DEFAULT_CONFIRM_ON_QUIT;
	} catch {
		return DEFAULT_CONFIRM_ON_QUIT;
	}
}

app.on("before-quit", async (event) => {
	if (isQuitting) return;

	const isDev = process.env.NODE_ENV === "development";
	if (!skipQuitConfirmation && !isDev && getConfirmOnQuitSetting()) {
		event.preventDefault();

		try {
			const { response } = await dialog.showMessageBox({
				type: "question",
				buttons: ["Quit", "Cancel"],
				defaultId: 0,
				cancelId: 1,
				title: "Quit Rox",
				message: "Are you sure you want to quit?",
			});

			if (response === 1) {
				return;
			}
		} catch (error) {
			logger.error("[main] Quit confirmation dialog failed:", error);
		}
	}

	isQuitting = true;
	try {
		getHostServiceCoordinator().stopAll();
		if (isDev || forceFullCleanup) {
			await teardownTerminalHost();
		} else if (isUpdateReadyToInstall()) {
			disposeTerminalHostClient();
		}
		shutdownTanstackDbPersistence();
		disposeTray();
		unregisterSpectreShortcut(globalShortcut);
		spectreManager?.destroy();
		popoutManager?.destroyAll();
		disposePushToTalkShortcut();
	} catch (error) {
		logger.error("[main] Cleanup during quit failed:", error);
	} finally {
		await stopNetworkLogger();
	}
	app.exit(0);
});

/**
 * Fully stop the v1 terminal-host process. Do not call this for update
 * installs: terminal-host owns the PTY subprocesses, so shutdown is
 * destructive and prevents reattach on next launch.
 */
async function teardownTerminalHost(): Promise<void> {
	try {
		await getTerminalHostClient().shutdownIfRunning({ killSessions: true });
	} catch (err) {
		logger.warn("[main] terminal-host dev shutdown failed:", err);
	}
	disposeTerminalHostClient();
}

process.on("uncaughtException", (error) => {
	if (isQuitting) return;
	logger.error("[main] Uncaught exception:", error);
});

process.on("unhandledRejection", (reason) => {
	if (isQuitting) return;
	logger.error("[main] Unhandled rejection:", reason);
});

// Without these handlers, Electron may not quit when electron-vite sends SIGTERM
if (process.env.NODE_ENV === "development") {
	let signalHandled = false;
	const handleTerminationSignal = (signal: string) => {
		if (signalHandled) return;
		signalHandled = true;
		logger.info(`[main] Received ${signal}, quitting...`);
		getHostServiceCoordinator().stopAll();
		void Promise.allSettled([
			teardownTerminalHost(),
			stopNetworkLogger(),
		]).finally(() => app.exit(0));
	};

	process.on("SIGTERM", () => handleTerminationSignal("SIGTERM"));
	process.on("SIGINT", () => handleTerminationSignal("SIGINT"));

	// Fallback: electron-vite may exit without signaling the child Electron process
	const parentPid = process.ppid;
	const isParentAlive = (): boolean => {
		try {
			process.kill(parentPid, 0);
			return true;
		} catch {
			return false;
		}
	};

	const parentCheckInterval = setInterval(() => {
		if (!isParentAlive()) {
			logger.info("[main] Parent process exited, quitting...");
			clearInterval(parentCheckInterval);
			handleTerminationSignal("parent-exit");
		}
	}, 1000);
	parentCheckInterval.unref();
}

protocol.registerSchemesAsPrivileged([
	{
		scheme: "rox-icon",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
	{
		scheme: "rox-font",
		privileges: {
			standard: true,
			secure: true,
			bypassCSP: true,
			supportFetchAPI: true,
		},
	},
]);

const gotTheLock = app.requestSingleInstanceLock();

if (!gotTheLock) {
	app.exit(0);
} else {
	// Windows/Linux: protocol URL arrives as argv on the second instance
	app.on("second-instance", async (_event, argv) => {
		focusMainWindow();
		const url = findDeepLinkInArgv(argv);
		if (url) {
			await processDeepLink(url);
		}
	});

	(async () => {
		await app.whenReady();
		registerWithMacOSNotificationCenter();
		requestAppleEventsAccess();
		requestLocalNetworkAccess();

		// Must register on both default session and the app's custom partition
		const iconProtocolHandler = (request: Request) => {
			const url = new URL(request.url);
			const projectId = url.pathname.replace(/^\//, "");
			const iconPath = getProjectIconPath(projectId);
			if (!iconPath) {
				return new Response("Not found", { status: 404 });
			}
			return net.fetch(pathToFileURL(iconPath).toString());
		};
		protocol.handle("rox-icon", iconProtocolHandler);
		session
			.fromPartition("persist:rox")
			.protocol.handle("rox-icon", iconProtocolHandler);

		// Serve system fonts (e.g. SF Mono on macOS) via custom protocol
		// so the renderer can use @font-face with font-src 'self' CSP
		if (process.platform === "darwin") {
			const SYSTEM_FONT_DIRS = [
				"/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts",
				"/System/Library/Fonts",
				"/Library/Fonts",
			];
			const fontProtocolHandler = async (request: Request) => {
				const url = new URL(request.url);
				const filename = path.basename(url.pathname);
				if (!/\.(otf|ttf|woff2?)$/i.test(filename)) {
					return new Response("Not found", { status: 404 });
				}
				for (const dir of SYSTEM_FONT_DIRS) {
					const fontPath = path.join(dir, filename);
					try {
						return await net.fetch(pathToFileURL(fontPath).toString());
					} catch {
						// Not in this directory
					}
				}
				return new Response("Not found", { status: 404 });
			};
			protocol.handle("rox-font", fontProtocolHandler);
			session
				.fromPartition("persist:rox")
				.protocol.handle("rox-font", fontProtocolHandler);
		}

		ensureProjectIconsDir();
		setWorkspaceDockIcon();
		initSentry();
		await initAppState();
		initTanstackDbPersistence();

		try {
			await startNetworkLogger();
		} catch (error) {
			logger.error("[main] Failed to start network logger:", error);
		}

		await loadWebviewBrowserExtension();

		// Must happen before renderer restore runs
		await reconcileDaemonSessions();
		prewarmTerminalRuntime();

		try {
			setupAgentHooks();
		} catch (error) {
			logger.error("[main] Failed to set up agent hooks:", error);
		}
		try {
			installBundledCliShim();
		} catch (error) {
			logger.error("[main] Failed to install bundled CLI shim:", error);
		}

		if (IS_DEV) {
			getHostServiceCoordinator().enableDevReload(async () => {
				const { token } = await loadToken();
				if (!token) return null;
				return { authToken: token, cloudApiUrl: mainEnv.NEXT_PUBLIC_API_URL };
			});
		}

		await makeAppSetup(() => MainWindow());
		setupAutoUpdater();
		initTray();

		// Spectre overlay assistant (Pluely-class). Created lazily on first summon;
		// the global shortcut (Cmd/Ctrl+\) works app-wide. Stealth (content
		// protection) is applied inside the manager.
		spectreManager = new SpectreWindowManager({
			createWindow: createSpectreWindow,
			isMac: PLATFORM.IS_MAC,
			loadSpectre,
		});
		// Hand the manager to the spectre tRPC router so the renderer can drive
		// stealth/hide and stream grok-4.3 answers.
		setSpectreManager(spectreManager);

		// Tear-off / popout window registry (F52). Each popout is attached to the
		// singleton trpc IPC handler so it is a live view onto the one core-state,
		// and persists its own bounds independently of the main window.
		popoutManager = new PopoutWindowManager({
			createWindow: createPopoutWindow,
			loadPopout,
			attachIpc: attachWindowToIpc,
			detachIpc: detachWindowFromIpc,
		});
		setPopoutManager(popoutManager);

		const spectreShortcutOk = registerSpectreShortcut({
			globalShortcut,
			onToggle: () => {
				void spectreManager?.toggle();
			},
		});
		if (!spectreShortcutOk) {
			logger.warn(
				"[spectre] summon shortcut already in use; configure an alternative in Settings",
			);
		}

		// Preinstall the bundled skill + subagent catalog into ~/.claude so every
		// workspace's agents have the full set out-of-the-box. Fire-and-forget,
		// versioned + idempotent — must never block startup.
		void ensureCatalogInstalled({
			resourcesDir: app.isPackaged
				? path.join(process.resourcesPath, "resources/preinstall")
				: path.join(app.getAppPath(), "resources/preinstall"),
		})
			.then((result) => {
				if (result.status === "installed") {
					logger.info(
						`[main] preinstalled catalog ${result.version}: ${result.skills} skills, ${result.agents} subagents`,
					);
				} else if (result.status === "error") {
					logger.error("[main] catalog preinstall failed:", result.error);
				}
			})
			.catch((error) => {
				logger.error("[main] catalog preinstall error:", error);
			});

		const coldStartUrl = findDeepLinkInArgv(process.argv);
		if (coldStartUrl) {
			await processDeepLink(coldStartUrl);
		}
		if (pendingDeepLinkUrl) {
			await processDeepLink(pendingDeepLinkUrl);
			pendingDeepLinkUrl = null;
		}

		appReady = true;
	})();
}
