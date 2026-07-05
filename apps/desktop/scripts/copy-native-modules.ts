/**
 * Prepare native modules for electron-builder.
 *
 * With Bun 1.3+ isolated installs, node_modules contains symlinks to packages
 * stored in node_modules/.bun/. electron-builder cannot follow these symlinks
 * when creating asar archives.
 *
 * This script:
 * 1. Detects if native modules are symlinks
 * 2. Replaces symlinks with actual file copies
 * 3. electron-builder can then properly package and unpack them
 *
 * This is safe because bun install will recreate the symlinks on next install.
 */

import { execSync } from "node:child_process";
import {
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	readlinkSync,
	realpathSync,
	rmSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { satisfies } from "semver";
import { requiredMaterializedNodeModules } from "../runtime-dependencies";

// Target architecture for cross-compilation. When set, platform-specific
// packages for this arch are fetched from npm if not already present.
// Set via TARGET_ARCH env var (e.g., TARGET_ARCH=x64).
const TARGET_ARCH = process.env.TARGET_ARCH || process.arch;
const TARGET_PLATFORM = process.env.TARGET_PLATFORM || process.platform;

function getWorkspaceRootNodeModulesDir(nodeModulesDir: string): string {
	return join(nodeModulesDir, "..", "..", "..", "node_modules");
}

function getBunFlatNodeModulesDir(nodeModulesDir: string): string {
	return join(
		getWorkspaceRootNodeModulesDir(nodeModulesDir),
		".bun",
		"node_modules",
	);
}

function getBunStoreDir(nodeModulesDir: string): string {
	return join(getWorkspaceRootNodeModulesDir(nodeModulesDir), ".bun");
}

/**
 * Resolve bun's global package cache directory. `bun pm cache` prints the
 * absolute path; honor BUN_INSTALL_CACHE_DIR when present for hermetic CI.
 */
let cachedBunCacheDir: string | null | undefined;
function getBunCacheDir(): string | null {
	if (cachedBunCacheDir !== undefined) return cachedBunCacheDir;
	if (process.env.BUN_INSTALL_CACHE_DIR) {
		cachedBunCacheDir = process.env.BUN_INSTALL_CACHE_DIR;
		return cachedBunCacheDir;
	}
	try {
		const out = execSync("bun pm cache", {
			stdio: ["ignore", "pipe", "ignore"],
		})
			.toString()
			.trim();
		cachedBunCacheDir = out.length > 0 ? out : null;
	} catch {
		cachedBunCacheDir = null;
	}
	return cachedBunCacheDir;
}

/**
 * Find the extracted-package folder for a module in bun's cache. Cache entries
 * are named `<name>@<version>@@@<n>` (scoped packages live under `@scope/`).
 * Prefer an exact version match, otherwise fall back to any cached version.
 */
function findBunCacheFolder(
	moduleName: string,
	version: string,
): string | null {
	const cacheDir = getBunCacheDir();
	if (!cacheDir || !existsSync(cacheDir)) return null;

	const isScoped = moduleName.startsWith("@");
	const searchDir = isScoped
		? join(cacheDir, moduleName.split("/")[0])
		: cacheDir;
	if (!existsSync(searchDir)) return null;

	const bareName = isScoped ? moduleName.split("/")[1] : moduleName;
	const entries = readdirSync(searchDir);
	const exactPrefix = `${bareName}@${version}@@@`;
	const exactMatch = entries.find((entry) => entry.startsWith(exactPrefix));
	if (exactMatch) return join(searchDir, exactMatch);

	const looseMatch = entries.find((entry) => entry.startsWith(`${bareName}@`));
	return looseMatch ? join(searchDir, looseMatch) : null;
}

/**
 * Infer a module's version from the (possibly dangling) bun symlink target,
 * which encodes it as `.../.bun/<name>@<version>/node_modules/<name>`.
 */
function readVersionFromSymlinkTarget(symlinkPath: string): string | null {
	try {
		const target = readlinkSync(symlinkPath);
		const match = target.match(/\.bun\/[^/]*?@([0-9][^/]*)\//);
		return match ? match[1] : null;
	} catch {
		return null;
	}
}

/**
 * Resolve the exact installed version for a workspace dependency from the
 * desktop package.json. Used when the bun symlink is missing entirely (so the
 * version can't be inferred from a link target).
 */
let cachedDesktopPackageJson:
	| Record<string, Record<string, string>>
	| null
	| undefined;
function readVersionFromDesktopPackageJson(moduleName: string): string | null {
	if (cachedDesktopPackageJson === undefined) {
		const pkgJsonPath = join(dirname(import.meta.dirname), "package.json");
		try {
			cachedDesktopPackageJson = JSON.parse(
				readFileSync(pkgJsonPath, "utf8"),
			) as Record<string, Record<string, string>>;
		} catch {
			cachedDesktopPackageJson = null;
		}
	}
	const pkg = cachedDesktopPackageJson;
	if (!pkg) return null;
	const ranges = {
		...(pkg.dependencies ?? {}),
		...(pkg.devDependencies ?? {}),
		...(pkg.optionalDependencies ?? {}),
	};
	const range = ranges[moduleName];
	if (!range) return null;
	// Only return a clean, pinned version. Ranged specs (^, ~, etc.) can't be
	// mapped to a single cache folder reliably, so let the caller fall back.
	return /^[0-9][0-9A-Za-z.+-]*$/.test(range) ? range : null;
}

/**
 * Heal a required native module whose bun store slot was never populated
 * (dangling/missing payload) by materializing the package payload from the bun
 * cache into the store slot. Runs before `electron-builder install-app-deps`
 * so @electron/rebuild can find and compile the native binary. No-op when the
 * store slot already holds the real payload.
 */
function healBunStoreSlot(nodeModulesDir: string, moduleName: string): void {
	const modulePath = join(nodeModulesDir, moduleName);
	const bunFlatModulePath = join(
		getBunFlatNodeModulesDir(nodeModulesDir),
		moduleName,
	);

	// Already resolvable -> store slot is populated, nothing to do.
	if (existsSync(modulePath) || existsSync(bunFlatModulePath)) return;

	const version =
		readVersionFromSymlinkTarget(modulePath) ??
		readVersionFromSymlinkTarget(bunFlatModulePath) ??
		readVersionFromDesktopPackageJson(moduleName);
	if (!version) {
		console.warn(
			`  ${moduleName}: cannot determine version to heal Bun store slot`,
		);
		return;
	}

	const storeSlot = join(
		getBunStoreDir(nodeModulesDir),
		`${moduleName.replace("/", "+")}@${version}`,
		"node_modules",
		moduleName,
	);
	if (existsSync(join(storeSlot, "package.json"))) return;

	if (materializeFromBunCacheOrNpm(moduleName, version, storeSlot)) {
		console.log(`  ${moduleName}: healed Bun store slot at ${storeSlot}`);
	} else {
		console.warn(
			`  ${moduleName}: could not heal Bun store slot (cache/npm miss)`,
		);
	}
}

/**
 * Self-heal a missing native module payload. Bun occasionally creates the
 * directory-junction/symlink for a package but fails to extract the package's
 * own payload into its `.bun/<name>@<ver>/node_modules/<name>` store slot,
 * leaving a dangling link. Materialize the payload from the bun cache (which
 * holds the extracted tarball), then fall back to fetching from npm.
 *
 * Returns true when the payload was materialized at `destPath`.
 */
function materializeFromBunCacheOrNpm(
	moduleName: string,
	version: string | null,
	destPath: string,
): boolean {
	if (version) {
		const cacheFolder = findBunCacheFolder(moduleName, version);
		if (cacheFolder && existsSync(join(cacheFolder, "package.json"))) {
			console.log(`  ${moduleName}: materializing from Bun cache`);
			rmSync(destPath, { recursive: true, force: true });
			mkdirSync(dirname(destPath), { recursive: true });
			cpSync(cacheFolder, destPath, { recursive: true });
			console.log(`    Copied from cache to: ${destPath}`);
			return true;
		}
		if (fetchNpmPackage(moduleName, version, destPath)) {
			return true;
		}
	}
	return false;
}

function findBunStoreFolderName(
	bunStoreDir: string,
	moduleName: string,
	version: string,
): string | null {
	if (!existsSync(bunStoreDir)) return null;
	const entries = readdirSync(bunStoreDir);
	const modulePrefix = `${moduleName.replace("/", "+")}@`;
	const matches = entries.filter((entry) => entry.startsWith(modulePrefix));
	const exactPrefix = `${modulePrefix}${version}`;
	const exactMatch = matches.find((entry) => entry.startsWith(exactPrefix));
	if (exactMatch) return exactMatch;
	const satisfyingMatch = matches.find((entry) => {
		const installedVersion = entry.slice(modulePrefix.length).split("+")[0];
		return Boolean(installedVersion && satisfies(installedVersion, version));
	});
	return satisfyingMatch ?? matches[0] ?? null;
}

function copyModuleIfSymlink(
	nodeModulesDir: string,
	moduleName: string,
	required: boolean,
): boolean {
	const modulePath = join(nodeModulesDir, moduleName);
	const bunFlatNodeModulesDir = getBunFlatNodeModulesDir(nodeModulesDir);
	const bunFlatModulePath = join(bunFlatNodeModulesDir, moduleName);

	if (!existsSync(modulePath)) {
		if (existsSync(bunFlatModulePath)) {
			console.log(`  ${moduleName}: materializing from Bun store index`);
			rmSync(modulePath, { recursive: true, force: true });
			mkdirSync(dirname(modulePath), { recursive: true });
			cpSync(realpathSync(bunFlatModulePath), modulePath, { recursive: true });
			console.log(`    Copied to: ${modulePath}`);
			return true;
		}

		// Bun sometimes creates the workspace symlink (and the matching
		// `.bun/<name>@<ver>` store slot) but never extracts the package's own
		// payload, leaving both links dangling. `existsSync` follows the link, so
		// we land here. Recover the payload from the bun cache / npm and write it
		// straight into the store slot so the existing symlinks resolve again.
		const version =
			readVersionFromSymlinkTarget(modulePath) ??
			readVersionFromSymlinkTarget(bunFlatModulePath);
		const storeSlot =
			version &&
			join(
				getBunStoreDir(nodeModulesDir),
				`${moduleName.replace("/", "+")}@${version}`,
				"node_modules",
				moduleName,
			);
		if (
			storeSlot &&
			materializeFromBunCacheOrNpm(moduleName, version, storeSlot) &&
			existsSync(modulePath)
		) {
			console.log(
				`  ${moduleName}: recovered dangling symlink via Bun cache/npm`,
			);
			// Now that the store slot is populated, replace the symlink with real
			// files for electron-builder asar packaging.
			if (lstatSync(modulePath).isSymbolicLink()) {
				const realPath = realpathSync(modulePath);
				rmSync(modulePath, { recursive: true, force: true });
				cpSync(realPath, modulePath, { recursive: true });
				console.log(`    Copied to: ${modulePath}`);
			}
			return true;
		}

		// Last resort: materialize the payload directly at the workspace path.
		if (
			version &&
			materializeFromBunCacheOrNpm(moduleName, version, modulePath)
		) {
			console.log(`  ${moduleName}: materialized payload at ${modulePath}`);
			return true;
		}

		if (required) {
			console.error(`  [ERROR] ${moduleName} not found at ${modulePath}`);
			process.exit(1);
		}
		console.log(`  ${moduleName}: not found (skipping)`);
		return false;
	}

	const stats = lstatSync(modulePath);

	if (stats.isSymbolicLink()) {
		// Resolve symlink to get real path
		const realPath = realpathSync(modulePath);
		console.log(`  ${moduleName}: symlink -> replacing with real files`);
		console.log(`    Real path: ${realPath}`);

		// Remove the symlink. On Windows, bun creates directory junctions/symlinks
		// that rmSync rejects without `recursive` (ERR_FS_EISDIR); recursive+force
		// removes the link itself (not the target) cross-platform.
		rmSync(modulePath, { recursive: true, force: true });

		// Copy the actual files
		cpSync(realPath, modulePath, { recursive: true });

		console.log(`    Copied to: ${modulePath}`);
	} else {
		console.log(`  ${moduleName}: already real directory (not a symlink)`);
	}

	return true;
}

function readInstalledModuleVersion(modulePath: string): string | null {
	const packageJsonPath = join(modulePath, "package.json");
	if (!existsSync(packageJsonPath)) return null;
	type PackageJson = { version?: string };
	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson;
	return packageJson.version ?? null;
}

function copyExactModuleVersion(
	nodeModulesDir: string,
	moduleName: string,
	version: string,
	destPath: string,
	required: boolean,
): boolean {
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	const bunStoreFolderName = findBunStoreFolderName(
		bunStoreDir,
		moduleName,
		version,
	);
	if (bunStoreFolderName) {
		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			moduleName,
		);
		if (existsSync(sourcePath)) {
			mkdirSync(dirname(destPath), { recursive: true });
			cpSync(sourcePath, destPath, { recursive: true });
			console.log(`    Copied ${moduleName}@${version} to: ${destPath}`);
			return true;
		}
	}

	if (fetchNpmPackage(moduleName, version, destPath)) {
		return true;
	}

	if (required) {
		console.error(
			`  [ERROR] Failed to materialize ${moduleName}@${version} at ${destPath}`,
		);
		process.exit(1);
	}

	return false;
}

function copyDependencyForPackage(
	nodeModulesDir: string,
	parentModuleName: string,
	dependencyName: string,
	dependencyRange: string,
	required: boolean,
): void {
	const topLevelDependencyPath = join(nodeModulesDir, dependencyName);
	const topLevelVersion = readInstalledModuleVersion(topLevelDependencyPath);

	if (topLevelVersion && satisfies(topLevelVersion, dependencyRange)) {
		copyModuleIfSymlink(nodeModulesDir, dependencyName, required);
		return;
	}

	if (!topLevelVersion) {
		console.log(
			`  ${dependencyName}: top-level version missing; materializing ${dependencyRange} at the workspace root`,
		);
		copyExactModuleVersion(
			nodeModulesDir,
			dependencyName,
			dependencyRange,
			topLevelDependencyPath,
			required,
		);
		return;
	}

	const nestedDependencyPath = join(
		nodeModulesDir,
		parentModuleName,
		"node_modules",
		dependencyName,
	);
	const nestedVersion = readInstalledModuleVersion(nestedDependencyPath);
	if (nestedVersion && satisfies(nestedVersion, dependencyRange)) {
		const nestedStats = lstatSync(nestedDependencyPath);
		if (nestedStats.isSymbolicLink()) {
			const realPath = realpathSync(nestedDependencyPath);
			// recursive+force so Windows directory junctions/symlinks are removed too
			rmSync(nestedDependencyPath, { recursive: true, force: true });
			cpSync(realPath, nestedDependencyPath, {
				recursive: true,
			});
		}
		return;
	}

	console.log(
		`  ${dependencyName}: top-level version ${topLevelVersion ?? "missing"} does not satisfy ${dependencyRange}; materializing nested copy for ${parentModuleName}`,
	);

	copyExactModuleVersion(
		nodeModulesDir,
		dependencyName,
		dependencyRange,
		nestedDependencyPath,
		required,
	);
}

function copyRootDependencyIntoPackage(
	nodeModulesDir: string,
	parentPackagePath: string,
	parentPackageName: string,
	dependencyName: string,
	dependencyRange: string,
): string | null {
	const topLevelDependencyPath = join(nodeModulesDir, dependencyName);
	let topLevelVersion = readInstalledModuleVersion(topLevelDependencyPath);
	const nestedDependencyPath = join(
		parentPackagePath,
		"node_modules",
		dependencyName,
	);
	const nestedVersion = readInstalledModuleVersion(nestedDependencyPath);

	if (nestedVersion && satisfies(nestedVersion, dependencyRange)) {
		const nestedStats = lstatSync(nestedDependencyPath);
		if (!nestedStats.isSymbolicLink()) {
			return nestedDependencyPath;
		}
	}

	if (!topLevelVersion) {
		copyModuleIfSymlink(nodeModulesDir, dependencyName, true);
		topLevelVersion = readInstalledModuleVersion(topLevelDependencyPath);
	}

	if (topLevelVersion && satisfies(topLevelVersion, dependencyRange)) {
		const sourcePath = realpathSync(topLevelDependencyPath);
		rmSync(nestedDependencyPath, { recursive: true, force: true });
		mkdirSync(dirname(nestedDependencyPath), { recursive: true });
		cpSync(sourcePath, nestedDependencyPath, { recursive: true });
		console.log(
			`  ${parentPackageName}: copied ${dependencyName}@${topLevelVersion} into package-local node_modules`,
		);
		return nestedDependencyPath;
	}

	console.log(
		`  ${parentPackageName}: top-level ${dependencyName}@${topLevelVersion ?? "missing"} does not satisfy ${dependencyRange}; materializing nested copy`,
	);
	copyExactModuleVersion(
		nodeModulesDir,
		dependencyName,
		dependencyRange,
		nestedDependencyPath,
		true,
	);
	return existsSync(nestedDependencyPath) ? nestedDependencyPath : null;
}

function materializePackageProductionDependencies(
	nodeModulesDir: string,
	packagePath: string,
	packageNameHint?: string,
	visitedPackagePaths = new Set<string>(),
): void {
	let resolvedPackagePath: string;
	try {
		resolvedPackagePath = realpathSync(packagePath);
	} catch {
		return;
	}
	if (visitedPackagePaths.has(resolvedPackagePath)) return;
	visitedPackagePaths.add(resolvedPackagePath);

	const packageJsonPath = join(resolvedPackagePath, "package.json");
	if (!existsSync(packageJsonPath)) return;

	type PackageJson = {
		dependencies?: Record<string, string>;
		name?: string;
	};
	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson | null;
	if (!packageJson) return;

	const packageName =
		packageJson.name ?? packageNameHint ?? resolvedPackagePath;
	for (const [dependencyName, dependencyRange] of Object.entries(
		packageJson.dependencies ?? {},
	)) {
		const nestedDependencyPath = copyRootDependencyIntoPackage(
			nodeModulesDir,
			resolvedPackagePath,
			packageName,
			dependencyName,
			dependencyRange,
		);
		if (nestedDependencyPath) {
			materializePackageProductionDependencies(
				nodeModulesDir,
				nestedDependencyPath,
				dependencyName,
				visitedPackagePaths,
			);
		}
	}
}

function materializeNativeDependenciesForPackage(
	nodeModulesDir: string,
	packagePath: string,
	packageNameHint?: string,
): void {
	let resolvedPackagePath: string;
	try {
		resolvedPackagePath = realpathSync(packagePath);
	} catch {
		return;
	}

	const packageJsonPath = join(resolvedPackagePath, "package.json");
	if (!existsSync(packageJsonPath)) return;

	type PackageJson = {
		dependencies?: Record<string, string>;
		name?: string;
	};
	const packageJson = JSON.parse(
		readFileSync(packageJsonPath, "utf8"),
	) as PackageJson;
	const packageName =
		packageJson.name ?? packageNameHint ?? resolvedPackagePath;
	const nativeDependencies = Object.entries(
		packageJson.dependencies ?? {},
	).filter(([dependencyName]) =>
		requiredMaterializedNodeModules.includes(dependencyName),
	);

	for (const [dependencyName, dependencyRange] of nativeDependencies) {
		const nestedDependencyPath = copyRootDependencyIntoPackage(
			nodeModulesDir,
			resolvedPackagePath,
			packageName,
			dependencyName,
			dependencyRange,
		);
		if (nestedDependencyPath) {
			materializePackageProductionDependencies(
				nodeModulesDir,
				nestedDependencyPath,
				dependencyName,
			);
		}
	}
}

function materializeDesktopDependencyNativeDependencies(
	nodeModulesDir: string,
): void {
	const desktopPackageJsonPath = join(
		dirname(import.meta.dirname),
		"package.json",
	);
	if (!existsSync(desktopPackageJsonPath)) return;

	type DesktopPackageJson = {
		dependencies?: Record<string, string>;
	};
	const desktopPackageJson = JSON.parse(
		readFileSync(desktopPackageJsonPath, "utf8"),
	) as DesktopPackageJson;
	const dependencyNames = Object.keys(desktopPackageJson.dependencies ?? {});
	if (dependencyNames.length === 0) return;

	console.log(
		"\nMaterializing native dependencies declared by desktop dependencies...",
	);
	for (const dependencyName of dependencyNames) {
		materializeNativeDependenciesForPackage(
			nodeModulesDir,
			join(nodeModulesDir, dependencyName),
			dependencyName,
		);
	}
}

function materializeWorkspacePackageNativeDependencies(
	nodeModulesDir: string,
): void {
	const roxScopeDir = join(nodeModulesDir, "@rox");
	if (!existsSync(roxScopeDir)) return;

	console.log(
		"\nMaterializing native dependencies declared by workspace packages...",
	);
	for (const entry of readdirSync(roxScopeDir)) {
		const modulePath = join(roxScopeDir, entry);
		let workspacePackagePath: string;
		try {
			workspacePackagePath = realpathSync(modulePath);
		} catch {
			continue;
		}

		const packageJsonPath = join(workspacePackagePath, "package.json");
		if (!existsSync(packageJsonPath)) continue;

		type WorkspacePackageJson = {
			dependencies?: Record<string, string>;
			name?: string;
		};
		const workspacePackageJson = JSON.parse(
			readFileSync(packageJsonPath, "utf8"),
		) as WorkspacePackageJson;
		const workspacePackageName = workspacePackageJson.name ?? `@rox/${entry}`;
		materializeNativeDependenciesForPackage(
			nodeModulesDir,
			workspacePackagePath,
			workspacePackageName,
		);
	}
}

function materializeRuntimePackageProductionDependencies(
	nodeModulesDir: string,
): void {
	console.log(
		"\nMaterializing production dependencies declared by runtime modules...",
	);
	for (const moduleName of requiredMaterializedNodeModules) {
		const modulePath = join(nodeModulesDir, moduleName);
		materializePackageProductionDependencies(
			nodeModulesDir,
			modulePath,
			moduleName,
		);
	}
}

/**
 * Fetch an npm package tarball and extract it to destPath.
 * Used when cross-compiling and the target platform package isn't in the Bun store.
 */
function fetchNpmPackage(
	packageName: string,
	version: string,
	destPath: string,
): boolean {
	// npm tarball URL: @scope/pkg/-/pkg-version.tgz (filename uses pkg name without scope)
	const barePackageName = packageName.includes("/")
		? packageName.split("/")[1]
		: packageName;
	const url = `https://registry.npmjs.org/${packageName}/-/${barePackageName}-${version}.tgz`;
	console.log(`  ${packageName}: fetching from npm (${version})`);
	try {
		mkdirSync(destPath, { recursive: true });
		execSync(
			`curl -sL "${url}" | tar xz -C "${destPath}" --strip-components=1`,
			{
				stdio: "pipe",
			},
		);
		console.log(`    Extracted to: ${destPath}`);
		return true;
	} catch (err) {
		console.error(
			`  [ERROR] Failed to fetch ${packageName}@${version}: ${err}`,
		);
		return false;
	}
}

function copyAstGrepPlatformPackages(nodeModulesDir: string): void {
	const astGrepNapiPath = join(nodeModulesDir, "@ast-grep", "napi");
	if (!existsSync(astGrepNapiPath)) return;

	const astGrepPkgJsonPath = join(astGrepNapiPath, "package.json");
	if (!existsSync(astGrepPkgJsonPath)) return;

	type AstGrepPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const astGrepPkg = JSON.parse(
		readFileSync(astGrepPkgJsonPath, "utf8"),
	) as AstGrepPackageJson;
	const optionalDeps = astGrepPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@ast-grep/napi-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	// Determine which platform package we need for the target arch
	const targetPlatformSuffix = `${TARGET_PLATFORM === "darwin" ? "darwin" : TARGET_PLATFORM === "win32" ? "win32" : "linux"}-${TARGET_ARCH}`;
	const targetPkg = platformPackages.find((pkg) =>
		pkg.name.includes(targetPlatformSuffix),
	);

	// Bun isolated installs keep package payloads in workspaceRoot/node_modules/.bun
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedTargetPackage = false;

	for (const platformPkg of platformPackages) {
		const isTargetPkg = targetPkg && platformPkg.name === targetPkg.name;
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			const copied = copyModuleIfSymlink(
				nodeModulesDir,
				platformPkg.name,
				false,
			);
			if (isTargetPkg && copied) resolvedTargetPackage = true;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (bunStoreFolderName) {
			const sourcePath = join(
				bunStoreDir,
				bunStoreFolderName,
				"node_modules",
				platformPkg.name,
			);
			if (existsSync(sourcePath)) {
				console.log(`  ${platformPkg.name}: copying from Bun store`);
				mkdirSync(dirname(destPath), { recursive: true });
				cpSync(sourcePath, destPath, { recursive: true });
				if (isTargetPkg) resolvedTargetPackage = true;
				continue;
			}
		}

		// If this is the target platform package and it's not in the Bun store,
		// fetch it from npm (cross-compilation scenario)
		if (isTargetPkg) {
			if (fetchNpmPackage(platformPkg.name, platformPkg.version, destPath)) {
				resolvedTargetPackage = true;
				continue;
			}
		}

		console.warn(
			`  ${platformPkg.name}: not found in Bun store or node_modules`,
		);
	}

	if (!resolvedTargetPackage) {
		console.error(
			`  [ERROR] Target platform package ${targetPkg?.name ?? `@ast-grep/napi-${targetPlatformSuffix}`} was not materialized`,
		);
		process.exit(1);
	}
}

function copyLibsqlDependencies(nodeModulesDir: string): void {
	const libsqlPath = join(nodeModulesDir, "libsql");
	const libsqlPkgJsonPath = join(libsqlPath, "package.json");
	if (!existsSync(libsqlPkgJsonPath)) return;

	type LibsqlPackageJson = {
		dependencies?: Record<string, string>;
		optionalDependencies?: Record<string, string>;
	};
	const libsqlPkg = JSON.parse(
		readFileSync(libsqlPkgJsonPath, "utf8"),
	) as LibsqlPackageJson;
	const deps = libsqlPkg.dependencies ?? {};
	const optionalDeps = libsqlPkg.optionalDependencies ?? {};

	console.log("\nPreparing libsql runtime dependencies...");
	for (const [dep, version] of Object.entries(deps)) {
		copyDependencyForPackage(nodeModulesDir, "libsql", dep, version, true);
	}

	// Copy whichever optional native platform packages Bun installed for this platform.
	for (const dep of Object.keys(optionalDeps)) {
		copyModuleIfSymlink(nodeModulesDir, dep, false);
	}

	// Some Bun installs place optional deps under .bun/node_modules/@scope.
	// Mirror discovered @libsql optional packages if present there.
	const bunFlatLibsqlScopePath = join(
		getBunFlatNodeModulesDir(nodeModulesDir),
		"@libsql",
	);
	if (existsSync(bunFlatLibsqlScopePath)) {
		for (const entry of readdirSync(bunFlatLibsqlScopePath)) {
			if (
				!entry.includes("darwin") &&
				!entry.includes("linux") &&
				!entry.includes("win32")
			) {
				continue;
			}
			copyModuleIfSymlink(nodeModulesDir, `@libsql/${entry}`, false);
		}
	}

	// Cross-compilation: ensure the target platform's @libsql package is present
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetLibsqlPkgs = Object.entries(optionalDeps).filter(([name]) =>
		name.includes(targetSuffix),
	);
	for (const [name, version] of targetLibsqlPkgs) {
		const destPath = join(nodeModulesDir, name);
		if (!existsSync(destPath)) {
			fetchNpmPackage(name, version, destPath);
		}
	}
}

function copyParcelWatcherPlatformPackages(nodeModulesDir: string): void {
	const watcherPath = join(nodeModulesDir, "@parcel", "watcher");
	const watcherPkgJsonPath = join(watcherPath, "package.json");
	if (!existsSync(watcherPkgJsonPath)) return;

	type ParcelWatcherPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const watcherPkg = JSON.parse(
		readFileSync(watcherPkgJsonPath, "utf8"),
	) as ParcelWatcherPackageJson;
	const optionalDeps = watcherPkg.optionalDependencies ?? {};
	const platformPackages = Object.entries(optionalDeps)
		.filter(([name]) => name.startsWith("@parcel/watcher-"))
		.map(([name, version]) => ({ name, version }));

	if (platformPackages.length === 0) return;

	console.log("\nPreparing parcel watcher platform package...");
	const bunStoreDir = getBunStoreDir(nodeModulesDir);
	let resolvedPlatformPackage = false;

	for (const platformPkg of platformPackages) {
		const destPath = join(nodeModulesDir, platformPkg.name);
		if (existsSync(destPath)) {
			resolvedPlatformPackage =
				copyModuleIfSymlink(nodeModulesDir, platformPkg.name, false) ||
				resolvedPlatformPackage;
			continue;
		}

		const bunStoreFolderName = findBunStoreFolderName(
			bunStoreDir,
			platformPkg.name,
			platformPkg.version,
		);
		if (!bunStoreFolderName) {
			console.warn(
				`  ${platformPkg.name}: no Bun store entry matched version ${platformPkg.version}`,
			);
			continue;
		}

		const sourcePath = join(
			bunStoreDir,
			bunStoreFolderName,
			"node_modules",
			platformPkg.name,
		);
		if (!existsSync(sourcePath)) {
			console.warn(
				`  ${platformPkg.name}: Bun store path missing after resolve (${sourcePath})`,
			);
			continue;
		}

		console.log(`  ${platformPkg.name}: copying from Bun store`);
		mkdirSync(dirname(destPath), { recursive: true });
		cpSync(sourcePath, destPath, { recursive: true });
		resolvedPlatformPackage = true;
	}

	if (!resolvedPlatformPackage) {
		console.error(
			"  [ERROR] No `@parcel/watcher-<platform>` runtime package was materialized",
		);
		process.exit(1);
	}
}

function copyDuckdbPlatformPackages(nodeModulesDir: string): void {
	const nodeBindingsPath = join(nodeModulesDir, "@duckdb", "node-bindings");
	const nodeBindingsPkgJsonPath = join(nodeBindingsPath, "package.json");
	if (!existsSync(nodeBindingsPkgJsonPath)) return;

	type DuckdbBindingsPackageJson = {
		optionalDependencies?: Record<string, string>;
	};
	const nodeBindingsPkg = JSON.parse(
		readFileSync(nodeBindingsPkgJsonPath, "utf8"),
	) as DuckdbBindingsPackageJson;
	const optionalDeps = nodeBindingsPkg.optionalDependencies ?? {};

	console.log("\nPreparing duckdb platform package...");

	// The native binding is a `cpu`/`os`-gated optional dependency, so Bun only
	// installs the host's. For the target arch, fetch it from npm when missing.
	const targetSuffix = `${TARGET_PLATFORM}-${TARGET_ARCH}`;
	const targetEntry = Object.entries(optionalDeps).find(([name]) =>
		name.endsWith(targetSuffix),
	);
	if (!targetEntry) {
		console.error(
			`  [ERROR] No @duckdb/node-bindings optional dependency matched ${targetSuffix}`,
		);
		process.exit(1);
	}

	const [targetName, targetVersion] = targetEntry;
	const destPath = join(nodeModulesDir, targetName);
	if (existsSync(destPath)) {
		copyModuleIfSymlink(nodeModulesDir, targetName, true);
		return;
	}

	copyExactModuleVersion(
		nodeModulesDir,
		targetName,
		targetVersion,
		destPath,
		true,
	);
}

/**
 * Heal-only pass: populate any missing/dangling Bun store slots for required
 * native modules from the Bun cache. Intended to run *before*
 * `electron-builder install-app-deps` so @electron/rebuild can find and compile
 * the native binaries (e.g. better-sqlite3) that Bun's isolated install
 * occasionally fails to extract. Does not replace workspace symlinks.
 */
function healNativeModuleStoreSlots() {
	console.log("Healing Bun store slots for native runtime modules...");
	const nodeModulesDir = join(dirname(import.meta.dirname), "node_modules");
	for (const moduleName of requiredMaterializedNodeModules) {
		healBunStoreSlot(nodeModulesDir, moduleName);
	}
	console.log("Done healing Bun store slots.");
}

function prepareNativeModules() {
	console.log("Preparing external runtime modules for electron-builder...");
	console.log(
		`  Target: ${TARGET_PLATFORM}/${TARGET_ARCH} (host: ${process.platform}/${process.arch})`,
	);

	// bun creates symlinks for direct dependencies in the workspace's node_modules
	const nodeModulesDir = join(dirname(import.meta.dirname), "node_modules");

	console.log("\nMaterializing packaged runtime modules...");
	for (const moduleName of requiredMaterializedNodeModules) {
		copyModuleIfSymlink(nodeModulesDir, moduleName, true);
	}
	materializeRuntimePackageProductionDependencies(nodeModulesDir);
	materializeDesktopDependencyNativeDependencies(nodeModulesDir);
	materializeWorkspacePackageNativeDependencies(nodeModulesDir);

	console.log("\nPreparing ast-grep platform package...");
	copyAstGrepPlatformPackages(nodeModulesDir);
	copyParcelWatcherPlatformPackages(nodeModulesDir);
	copyLibsqlDependencies(nodeModulesDir);
	copyDuckdbPlatformPackages(nodeModulesDir);

	console.log("\nDone!");
}

if (process.argv.includes("--heal-store-only")) {
	healNativeModuleStoreSlots();
} else {
	prepareNativeModules();
}
