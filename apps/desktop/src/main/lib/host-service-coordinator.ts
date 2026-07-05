import * as childProcess from "node:child_process";
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import path from "node:path";
import { settings } from "@rox/local-db";
import { getHostId, getHostName } from "@rox/shared/host-info";
import { app } from "electron";
import log from "electron-log/main";
import { env as sharedEnv } from "shared/env.shared";
import { getProcessEnvWithShellPath } from "../../lib/trpc/routers/workspaces/utils/shell-env";
import { ROX_HOME_DIR } from "./app-environment";
import {
	isProcessAlive,
	killProcess,
	manifestDir,
	readManifest,
	removeManifest,
} from "./host-service-manifest";
import {
	findFreePort,
	HEALTH_POLL_TIMEOUT_MS,
	MAX_HOST_LOG_BYTES,
	openRotatingLogFd,
	pollHealthCheck,
} from "./host-service-utils";
import { localDb } from "./local-db";
import { getRelayUrl } from "./relay-url";
import { HOOK_PROTOCOL_VERSION } from "./terminal/env";

export type HostServiceStatus = "starting" | "running" | "stopped";

export interface Connection {
	port: number;
	secret: string;
	machineId: string;
}

export interface HostServiceStatusEvent {
	organizationId: string;
	status: HostServiceStatus;
	previousStatus: HostServiceStatus | null;
}

export interface SpawnConfig {
	authToken: string;
	cloudApiUrl: string;
}

interface HostServiceProcess {
	pid: number;
	port: number;
	secret: string;
	status: HostServiceStatus;
}

type HostServiceSettingsRow = typeof settings.$inferSelect | undefined;

// High, uncommon user-space range: above usual web/dev server ports and below
// macOS's default ephemeral range, while still falling back if occupied.
const STABLE_PORT_BASE = 48_000;
const STABLE_PORT_COUNT = 1_000;
const STARTUP_OUTPUT_TAIL_BYTES = 8 * 1024;

// Auto-respawn watchdog: when a running host-service child exits unexpectedly
// (crash / self-exit — NOT an explicit stop()), the coordinator restarts it
// with exponential backoff so a transient failure (e.g. the post-upgrade
// clean-exit that left the org wedged in "stopped") can't strand the user until
// they manually restart from the tray. Gives up after MAX_RESPAWN_ATTEMPTS so a
// permanently-broken binary surfaces as "stopped" instead of looping forever.
const MAX_RESPAWN_ATTEMPTS = 5;
const RESPAWN_BASE_DELAY_MS = 1_000;
const RESPAWN_MAX_DELAY_MS = 30_000;

type StartupResult =
	| { kind: "healthy" }
	| { kind: "timeout" }
	| { kind: "exit"; code: number | null; signal: NodeJS.Signals | null }
	| { kind: "error"; error: Error };

function getStablePortForOrganization(organizationId: string): number {
	let hash = 2_166_136_261;
	for (let index = 0; index < organizationId.length; index++) {
		hash ^= organizationId.charCodeAt(index);
		hash = Math.imul(hash, 16_777_619);
	}
	return STABLE_PORT_BASE + ((hash >>> 0) % STABLE_PORT_COUNT);
}

function isValidPort(port: number | null | undefined): port is number {
	return (
		typeof port === "number" &&
		Number.isInteger(port) &&
		port > 0 &&
		port <= 65_535
	);
}

/**
 * True when an error from `process.kill` means the target process no longer
 * exists (`ESRCH`). For a stop operation that is the desired end state, so it
 * should not be reported as a failure.
 */
function isNoSuchProcessError(error: unknown): boolean {
	return (
		error instanceof Error && (error as NodeJS.ErrnoException).code === "ESRCH"
	);
}

/**
 * Coupled to Electron: each child is spawned attached and SIGTERMed on
 * before-quit. PTYs survive across Electron restarts via the pty-daemon
 * layer host-service supervises, not via host-service itself. Manifests
 * are still written by the child for the CLI's benefit.
 */
export class HostServiceCoordinator extends EventEmitter {
	private instances = new Map<string, HostServiceProcess>();
	private pendingStarts = new Map<string, Promise<Connection>>();
	private lastKnownPorts = new Map<string, number>();
	private scriptPath = path.join(__dirname, "host-service.js");
	private machineId = getHostId();
	private devReloadWatcher: fs.FSWatcher | null = null;
	// Watchdog state for auto-respawn on unexpected child exit.
	private lastConfigs = new Map<string, SpawnConfig>();
	private respawnAttempts = new Map<string, number>();
	private respawnTimers = new Map<string, ReturnType<typeof setTimeout>>();
	private readonly resolveChildEnv: typeof getProcessEnvWithShellPath;

	constructor(options?: {
		resolveChildEnv?: typeof getProcessEnvWithShellPath;
	}) {
		super();
		this.resolveChildEnv =
			options?.resolveChildEnv ?? getProcessEnvWithShellPath;
	}

	async start(
		organizationId: string,
		config: SpawnConfig,
	): Promise<Connection> {
		return this.startWithPreferredPorts(organizationId, config);
	}

	private async startWithPreferredPorts(
		organizationId: string,
		config: SpawnConfig,
		preferredPorts?: Iterable<number>,
	): Promise<Connection> {
		const existing = this.instances.get(organizationId);
		if (existing?.status === "running") {
			return {
				port: existing.port,
				secret: existing.secret,
				machineId: this.machineId,
			};
		}

		const pending = this.pendingStarts.get(organizationId);
		if (pending) return pending;

		const startPromise = this.spawn(
			organizationId,
			config,
			preferredPorts ?? this.getPreferredPorts(organizationId),
		);
		this.pendingStarts.set(organizationId, startPromise);

		try {
			return await startPromise;
		} finally {
			this.pendingStarts.delete(organizationId);
		}
	}

	private getPreferredPorts(organizationId: string): number[] {
		const ports = [
			this.instances.get(organizationId)?.port,
			this.lastKnownPorts.get(organizationId),
			getStablePortForOrganization(organizationId),
		];
		const uniquePorts: number[] = [];
		const seen = new Set<number>();

		for (const port of ports) {
			if (!isValidPort(port) || seen.has(port)) continue;
			seen.add(port);
			uniquePorts.push(port);
		}

		return uniquePorts;
	}

	private rememberPort(organizationId: string, port: number): void {
		if (!isValidPort(port)) return;
		this.lastKnownPorts.set(organizationId, port);
	}

	private clearRespawnTimer(organizationId: string): void {
		const timer = this.respawnTimers.get(organizationId);
		if (timer) {
			clearTimeout(timer);
			this.respawnTimers.delete(organizationId);
		}
	}

	/**
	 * Auto-restart a host-service that died unexpectedly (crash / self-exit).
	 * Explicit stop()/stopAll() never reaches here — they cancel pending timers
	 * and reset attempts first. Uses exponential backoff and gives up after
	 * MAX_RESPAWN_ATTEMPTS so a permanently-broken child surfaces as "stopped"
	 * (the UI host-readiness gate then shows "host not ready") rather than
	 * looping forever.
	 */
	private scheduleRespawn(
		organizationId: string,
		previousStatus: HostServiceStatus,
	): void {
		// Only an unexpected death of a service that was up (or coming up).
		if (previousStatus === "stopped") return;
		const config = this.lastConfigs.get(organizationId);
		if (!config) return;
		// A newer start may already be in flight (e.g. manual restart) — don't pile on.
		if (this.pendingStarts.has(organizationId)) return;

		const attempts = this.respawnAttempts.get(organizationId) ?? 0;
		if (attempts >= MAX_RESPAWN_ATTEMPTS) {
			log.error(
				`[host-service:${organizationId}] exited ${attempts} times; giving up auto-respawn`,
			);
			return;
		}

		const delay = Math.min(
			RESPAWN_BASE_DELAY_MS * 2 ** attempts,
			RESPAWN_MAX_DELAY_MS,
		);
		this.respawnAttempts.set(organizationId, attempts + 1);
		log.info(
			`[host-service:${organizationId}] scheduling auto-respawn #${attempts + 1} in ${delay}ms`,
		);

		this.clearRespawnTimer(organizationId);
		const timer = setTimeout(() => {
			this.respawnTimers.delete(organizationId);
			// Bail if it was stopped or already restarted while we waited.
			if (this.pendingStarts.has(organizationId)) return;
			if (this.instances.get(organizationId)?.status === "running") return;
			const latestConfig = this.lastConfigs.get(organizationId);
			if (!latestConfig) return;
			log.info(`[host-service:${organizationId}] auto-respawning now`);
			this.start(organizationId, latestConfig).catch((error) => {
				log.error(
					`[host-service:${organizationId}] auto-respawn failed:`,
					error,
				);
			});
		}, delay);
		// Don't keep the event loop alive solely for a respawn.
		timer.unref?.();
		this.respawnTimers.set(organizationId, timer);
	}

	stop(organizationId: string): void {
		// An explicit stop cancels any pending auto-respawn — even if the instance
		// was already removed by an unexpected exit that scheduled a restart.
		this.clearRespawnTimer(organizationId);
		this.respawnAttempts.delete(organizationId);

		const instance = this.instances.get(organizationId);
		if (!instance) return;

		const previousStatus = instance.status;
		instance.status = "stopped";
		this.rememberPort(organizationId, instance.port);

		try {
			killProcess(instance.pid, "SIGTERM");
		} catch (error) {
			// ESRCH ("no such process") means the process is already gone, which
			// is the desired post-state — treat it as a successful stop. Any
			// other failure (e.g. EPERM) means we may have left a live process
			// behind, so surface it instead of silently asserting "stopped".
			if (!isNoSuchProcessError(error)) {
				log.error(
					`[host-service] Failed to stop host-service (org=${organizationId}, pid=${instance.pid})`,
					error,
				);
			}
		}

		this.instances.delete(organizationId);
		removeManifest(organizationId);
		this.emitStatus(organizationId, "stopped", previousStatus);
	}

	stopAll(): void {
		for (const timer of this.respawnTimers.values()) clearTimeout(timer);
		this.respawnTimers.clear();
		this.respawnAttempts.clear();
		for (const [id] of this.instances) {
			this.stop(id);
		}
	}

	async restart(
		organizationId: string,
		config: SpawnConfig,
	): Promise<Connection> {
		const preferredPorts = this.getPreferredPorts(organizationId);
		this.stop(organizationId);
		return this.startWithPreferredPorts(organizationId, config, preferredPorts);
	}

	/**
	 * Forcefully reset host-service state for an org. Unlike `restart`, this
	 * SIGKILLs whatever pid the manifest names — even when no instance is
	 * tracked in this process (e.g. a stale manifest left by a CLI-spawned
	 * host-service) — then removes the manifest so callers can't pick up the
	 * stale entry, and respawns. Used by the recovery path for
	 * agisota/rox#4299 where a wedged host-service keeps serving
	 * stale state.
	 */
	async reset(
		organizationId: string,
		config: SpawnConfig,
	): Promise<Connection> {
		// Capture the manifest pid *before* stop() — stop() removes the manifest
		// for tracked instances and only sends SIGTERM, which a wedged process
		// can ignore. We escalate to SIGKILL on whatever pid the manifest named.
		const preferredPorts = this.getPreferredPorts(organizationId);
		const manifestPid = readManifest(organizationId)?.pid;

		this.stop(organizationId);

		if (manifestPid != null && isProcessAlive(manifestPid)) {
			try {
				killProcess(manifestPid, "SIGKILL");
			} catch (error) {
				log.warn(
					`[host-service:${organizationId}] reset: SIGKILL of pid=${manifestPid} failed`,
					error,
				);
			}
		}

		removeManifest(organizationId);

		return this.startWithPreferredPorts(organizationId, config, preferredPorts);
	}

	getConnection(organizationId: string): Connection | null {
		const instance = this.instances.get(organizationId);
		if (!instance || instance.status !== "running") return null;
		return {
			port: instance.port,
			secret: instance.secret,
			machineId: this.machineId,
		};
	}

	getProcessStatus(organizationId: string): HostServiceStatus {
		if (this.pendingStarts.has(organizationId)) return "starting";
		return this.instances.get(organizationId)?.status ?? "stopped";
	}

	getActiveOrganizationIds(): string[] {
		return [...this.instances.entries()]
			.filter(([, i]) => i.status !== "stopped")
			.map(([id]) => id);
	}

	async restartAll(config: SpawnConfig): Promise<void> {
		await Promise.all(
			this.getActiveOrganizationIds().map((orgId) =>
				this.restart(orgId, config),
			),
		);
	}

	/**
	 * Dev-only: watch the built host-service bundle and restart running
	 * instances when it changes. Gives a fast edit→reload loop for code
	 * under packages/host-service and src/main/host-service without
	 * restarting Electron. In-memory host-service state (PTYs, watchers,
	 * chat streams) is torn down on each reload — this is not true HMR.
	 */
	enableDevReload(
		configProvider: () => Promise<SpawnConfig | null>,
	): () => void {
		if (this.devReloadWatcher) return () => {};

		const scriptDir = path.dirname(this.scriptPath);
		const scriptFile = path.basename(this.scriptPath);
		let debounce: ReturnType<typeof setTimeout> | null = null;
		let reloading = false;

		const waitForStableBundle = async (): Promise<boolean> => {
			const deadline = Date.now() + 5_000;
			let lastSize = -1;
			let stableSince = 0;
			while (Date.now() < deadline) {
				try {
					const stat = fs.statSync(this.scriptPath);
					if (stat.size > 0 && stat.size === lastSize) {
						if (Date.now() - stableSince >= 150) return true;
					} else {
						lastSize = stat.size;
						stableSince = Date.now();
					}
				} catch {
					lastSize = -1;
					stableSince = 0;
				}
				await new Promise((r) => setTimeout(r, 50));
			}
			return false;
		};

		const trigger = () => {
			if (debounce) clearTimeout(debounce);
			debounce = setTimeout(() => {
				void (async () => {
					if (reloading) return;
					if (this.getActiveOrganizationIds().length === 0) return;
					reloading = true;
					try {
						const ready = await waitForStableBundle();
						if (!ready) {
							log.warn(
								"[host-service] bundle did not stabilize, skipping reload",
							);
							return;
						}
						const config = await configProvider();
						if (!config) return;
						log.info(
							"[host-service] bundle changed, restarting running instances",
						);
						await this.restartAll(config);
					} catch (error) {
						log.error("[host-service] dev reload failed:", error);
					} finally {
						reloading = false;
					}
				})();
			}, 250);
		};

		try {
			this.devReloadWatcher = fs.watch(scriptDir, (_event, filename) => {
				if (filename && filename !== scriptFile) return;
				trigger();
			});
		} catch (error) {
			log.error("[host-service] failed to enable dev reload:", error);
			return () => {};
		}

		return () => {
			if (debounce) clearTimeout(debounce);
			this.devReloadWatcher?.close();
			this.devReloadWatcher = null;
		};
	}

	// ── Spawn ─────────────────────────────────────────────────────────

	private async spawn(
		organizationId: string,
		config: SpawnConfig,
		preferredPorts: Iterable<number> = this.getPreferredPorts(organizationId),
	): Promise<Connection> {
		const port = await findFreePort(preferredPorts);
		this.rememberPort(organizationId, port);
		const secret = randomBytes(32).toString("hex");

		const instance: HostServiceProcess = {
			pid: 0,
			port,
			secret,
			status: "starting",
		};
		this.clearRespawnTimer(organizationId);
		this.lastConfigs.set(organizationId, config);
		this.instances.set(organizationId, instance);
		this.emitStatus(organizationId, "starting", null);

		const childEnv = await this.buildEnv(organizationId, port, secret, config);
		const logPath = path.join(ROX_HOME_DIR, "host-service.log");
		// Pipe stdout/stderr in all modes so startup crashes are visible in a
		// stable user-facing log, not only in a dev terminal or per-org folder.
		const isDev = !app.isPackaged;
		const stdio: childProcess.StdioOptions = ["ignore", "pipe", "pipe"];

		let child: ReturnType<typeof childProcess.spawn>;
		child = childProcess.spawn(process.execPath, [this.scriptPath], {
			detached: false,
			stdio,
			env: childEnv,
			// Avoid a flashing CMD window on Windows.
			windowsHide: true,
		});

		const outputCapture = attachHostServiceOutput({
			organizationId,
			stdout: child.stdout,
			stderr: child.stderr,
			logPath,
			orgLogPath: path.join(manifestDir(organizationId), "host-service.log"),
			forwardToConsole: isDev,
		});

		const childPid = child.pid;
		if (!childPid) {
			outputCapture.close();
			this.instances.delete(organizationId);
			throw new Error("Failed to spawn host service process");
		}

		instance.pid = childPid;
		const exitPromise = new Promise<StartupResult>((resolve) => {
			child.once("exit", (code, signal) => {
				resolve({ kind: "exit", code, signal });
			});
			child.once("error", (error) => {
				resolve({
					kind: "error",
					error: error instanceof Error ? error : new Error(String(error)),
				});
			});
		});
		child.on("exit", (code) => {
			outputCapture.close();
			log.info(`[host-service:${organizationId}] exited with code ${code}`);
			const current = this.instances.get(organizationId);
			if (!current || current.pid !== childPid || current.status === "stopped")
				return;

			const previousStatus = current.status;
			this.rememberPort(organizationId, current.port);
			this.instances.delete(organizationId);
			removeManifest(organizationId);
			this.emitStatus(organizationId, "stopped", previousStatus);
			this.scheduleRespawn(organizationId, previousStatus);
		});
		// Don't let the child block Electron's exit — stopAll() handles teardown.
		child.unref();

		const endpoint = `http://127.0.0.1:${port}`;
		const startupResult = await Promise.race([
			pollHealthCheck(endpoint, secret).then<StartupResult>((healthy) =>
				healthy ? { kind: "healthy" } : { kind: "timeout" },
			),
			exitPromise,
		]);
		if (startupResult.kind !== "healthy") {
			child.kill("SIGTERM");
			this.instances.delete(organizationId);
			const message = formatStartupFailure(
				startupResult,
				logPath,
				outputCapture.getTail(),
			);
			throw new Error(message);
		}

		instance.status = "running";
		this.respawnAttempts.delete(organizationId);

		log.info(`[host-service:${organizationId}] listening on port ${port}`);
		this.emitStatus(organizationId, "running", "starting");
		return { port, secret, machineId: this.machineId };
	}

	private async buildEnv(
		organizationId: string,
		port: number,
		secret: string,
		config: SpawnConfig,
	): Promise<Record<string, string>> {
		const organizationDir = manifestDir(organizationId);
		const row = this.readSettingsForHostService();
		const exposeViaRelay = row?.exposeHostServiceViaRelay ?? false;

		const childEnv = await this.resolveChildEnv({
			...(process.env as Record<string, string>),
			ELECTRON_RUN_AS_NODE: "1",
			NODE_ENV: app.isPackaged
				? "production"
				: (process.env.NODE_ENV ?? "development"),
			// Disable mastra's gateway type-generation sync in the spawned
			// host-service. That sync (gated on MASTRA_DEV=true) periodically
			// calls fetchProviders() on registered gateways and writes
			// TypeScript model-registry files into @mastra/core's dist/ — fine
			// in a source checkout, but in a packaged .app that path lives inside
			// the read-only app.asar, so every sync throws "ENOTDIR: not a
			// directory, mkdir '/Applications/Rox.app/Contents/Resources/
			// app.asar/node_modules/@mastra/core/dist'". The host-service is a
			// headless runtime (dev and prod) that never needs IDE autocomplete
			// types, so force the flag off regardless of any value inherited from
			// the parent Electron process or the user's shell. The editor-side
			// `mastra dev` flow that real type generation belongs to runs as a
			// separate process and is unaffected.
			MASTRA_DEV: "false",
			ORGANIZATION_ID: organizationId,
			HOST_CLIENT_ID: getHostId(),
			HOST_NAME: getHostName(),
			HOST_SERVICE_SECRET: secret,
			HOST_SERVICE_PORT: String(port),
			HOST_MANIFEST_DIR: organizationDir,
			HOST_DB_PATH: path.join(organizationDir, "host.db"),
			HOST_MIGRATIONS_FOLDER: app.isPackaged
				? path.join(process.resourcesPath, "resources/host-migrations")
				: path.join(app.getAppPath(), "../../packages/host-service/drizzle"),
			DESKTOP_VITE_PORT: String(sharedEnv.DESKTOP_VITE_PORT),
			ROX_HOME_DIR: ROX_HOME_DIR,
			ROX_LEGACY_WORKTREE_BASE_DIR: row?.worktreeBaseDir ?? "",
			ROX_AGENT_HOOK_PORT: String(sharedEnv.DESKTOP_NOTIFICATIONS_PORT),
			ROX_AGENT_HOOK_VERSION: HOOK_PROTOCOL_VERSION,
			AUTH_TOKEN: config.authToken,
			ROX_AUTH_CONFIG_PATH: path.join(ROX_HOME_DIR, "config.json"),
			ROX_API_URL: config.cloudApiUrl,
			// Read by the child's parent watchdog so it can self-exit if
			// Electron crashes without sending SIGTERM (orphan reparenting).
			HOST_PARENT_PID: String(process.pid),
		});

		// `getProcessEnvWithShellPath` merges in the user's interactive shell env,
		// which in dev has `RELAY_URL` set. Enforce the toggle *after* that merge
		// so the child definitely doesn't see a relay URL when disabled. The
		// effective URL comes from the PostHog `relay-url-override` flag with
		// `env.RELAY_URL` as fallback (see main/lib/relay-url) so we can A/B-test
		// alternate relay deployments per-user.
		const effectiveRelayUrl = await getRelayUrl();
		if (exposeViaRelay && effectiveRelayUrl) {
			childEnv.RELAY_URL = effectiveRelayUrl;
		} else {
			delete childEnv.RELAY_URL;
		}

		seedRoxModelEnv(childEnv);

		return childEnv;
	}

	private readSettingsForHostService(): HostServiceSettingsRow {
		try {
			return localDb.select().from(settings).get();
		} catch (error) {
			throw new Error(
				`Host service startup blocked: desktop settings database is not readable. ${formatErrorMessage(error)}`,
				{ cause: error },
			);
		}
	}

	// ── Events ────────────────────────────────────────────────────────

	private emitStatus(
		organizationId: string,
		status: HostServiceStatus,
		previousStatus: HostServiceStatus | null,
	): void {
		this.emit("status-changed", {
			organizationId,
			status,
			previousStatus,
		} satisfies HostServiceStatusEvent);
	}
}

interface OutputCaptureOptions {
	organizationId: string;
	stdout: NodeJS.ReadableStream | null;
	stderr: NodeJS.ReadableStream | null;
	logPath: string;
	orgLogPath: string;
	forwardToConsole: boolean;
}

interface OutputCapture {
	getTail(): string;
	close(): void;
}

function attachHostServiceOutput(options: OutputCaptureOptions): OutputCapture {
	const streams = [
		openRotatingLogStream(options.logPath),
		openRotatingLogStream(options.orgLogPath),
	].filter((stream): stream is fs.WriteStream => stream !== null);
	let tail = "";

	const append = (text: string): void => {
		for (const stream of streams) {
			stream.write(text);
		}
		tail += text;
		if (Buffer.byteLength(tail, "utf8") > STARTUP_OUTPUT_TAIL_BYTES) {
			tail = tail.slice(-STARTUP_OUTPUT_TAIL_BYTES);
		}
	};

	const tag = `[hs:${options.organizationId.slice(0, 8)}]`;
	if (options.stdout) {
		pipeHostServiceOutput({
			source: options.stdout,
			parent: options.forwardToConsole ? process.stdout : null,
			tag,
			streamName: "stdout",
			append,
		});
	}
	if (options.stderr) {
		pipeHostServiceOutput({
			source: options.stderr,
			parent: options.forwardToConsole ? process.stderr : null,
			tag,
			streamName: "stderr",
			append,
		});
	}

	return {
		getTail: () => tail.trim(),
		close: () => {
			for (const stream of streams) {
				stream.end();
			}
		},
	};
}

function openRotatingLogStream(logPath: string): fs.WriteStream | null {
	const fd = openRotatingLogFd(logPath, MAX_HOST_LOG_BYTES);
	if (fd < 0) return null;
	return fs.createWriteStream(logPath, {
		fd,
		flags: "a",
		autoClose: true,
	});
}

interface PipeHostServiceOutputOptions {
	source: NodeJS.ReadableStream;
	parent: NodeJS.WritableStream | null;
	tag: string;
	streamName: "stdout" | "stderr";
	append: (text: string) => void;
}

function pipeHostServiceOutput({
	source,
	parent,
	tag,
	streamName,
	append,
}: PipeHostServiceOutputOptions): void {
	let pending = "";
	source.on("data", (chunk: unknown) => {
		const text = pending + chunkToText(chunk);
		const lines = text.split("\n");
		// Last element is a partial line if input doesn't end with \n;
		// stash it for the next chunk.
		pending = lines.pop() ?? "";
		for (const line of lines) {
			const formatted = `${new Date().toISOString()} ${tag} [${streamName}] ${line}\n`;
			append(formatted);
			parent?.write(`${tag} ${line}\n`);
		}
	});
	source.on("end", () => {
		if (pending) {
			const formatted = `${new Date().toISOString()} ${tag} [${streamName}] ${pending}\n`;
			append(formatted);
			parent?.write(`${tag} ${pending}\n`);
		}
		pending = "";
	});
}

function chunkToText(chunk: unknown): string {
	if (Buffer.isBuffer(chunk)) return chunk.toString("utf8");
	if (typeof chunk === "string") return chunk;
	return String(chunk);
}

function formatStartupFailure(
	result: Exclude<StartupResult, { kind: "healthy" }>,
	logPath: string,
	outputTail: string,
): string {
	const reason =
		result.kind === "timeout"
			? `Host service failed to start within ${HEALTH_POLL_TIMEOUT_MS}ms`
			: result.kind === "exit"
				? `Host service exited during startup (code=${result.code ?? "null"}, signal=${result.signal ?? "null"})`
				: `Host service spawn failed: ${result.error.message}`;
	const output = outputTail ? ` Last output: ${outputTail}` : "";
	return `${reason}. Log: ${logPath}.${output}`;
}

function formatErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Build-time defaults for the Rox house model ("ROX R1"). These literal
 * `process.env.*` reads are replaced by electron.vite.config's `main.define`
 * at bundle time, so a packaged .app carries the CI-provided key/endpoint even
 * though a Finder-launched Electron main process inherits no shell env. In dev
 * (unbundled) they read the real process env.
 */
const ROX_MODEL_BUILD_DEFAULTS: Readonly<Record<string, string | undefined>> = {
	ROX_AI_API_KEY: process.env.ROX_AI_API_KEY,
	ROX_AI_BASE_URL: process.env.ROX_AI_BASE_URL,
	ROX_AI_MODEL: process.env.ROX_AI_MODEL,
	// Optional per-user key provisioning (see chat-models ROX_KEY_PROVISION_*).
	// When set (via repo secrets baked by electron.vite.config), the spawned
	// host-service mints a distinct OmniRouter key per user/install instead of
	// sharing ROX_AI_API_KEY. Absent by default → shared-key MVP path.
	ROX_KEY_PROVISION_URL: process.env.ROX_KEY_PROVISION_URL,
	ROX_KEY_PROVISION_TOKEN: process.env.ROX_KEY_PROVISION_TOKEN,
};

/**
 * Seed the spawned host-service env with the Rox house-model credentials so
 * "ROX R1" works out of the box. A value already present in `childEnv` (real
 * runtime env / user shell — dev or self-host) always wins; the build-time
 * default only fills a gap. Empty/whitespace values are treated as absent.
 */
function seedRoxModelEnv(childEnv: Record<string, string>): void {
	for (const [key, buildDefault] of Object.entries(ROX_MODEL_BUILD_DEFAULTS)) {
		const existing = childEnv[key]?.trim();
		if (existing) continue;
		const fallback = buildDefault?.trim();
		if (fallback) childEnv[key] = fallback;
	}
}

let coordinator: HostServiceCoordinator | null = null;

export function getHostServiceCoordinator(): HostServiceCoordinator {
	if (!coordinator) {
		coordinator = new HostServiceCoordinator();
	}
	return coordinator;
}
