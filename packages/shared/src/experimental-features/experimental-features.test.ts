import { describe, expect, test } from "bun:test";
import {
	EXPERIMENTAL_FEATURE_CATEGORIES,
	EXPERIMENTAL_FEATURE_CATEGORY_LABELS,
	EXPERIMENTAL_FEATURES,
	formatExperimentalFeatureSurfaceLabel,
	getExperimentalFeatureDefinition,
	getExperimentalFeatureDisplayCopy,
	isExperimentalFeatureId,
	listExperimentalFeatures,
	resolveExperimentalFeatureState,
} from ".";

describe("experimental features registry", () => {
	test("contains a complete unique default-on feature baseline", () => {
		const minimumFeatureCount = EXPERIMENTAL_FEATURE_CATEGORIES.length * 10;
		expect(EXPERIMENTAL_FEATURES.length).toBeGreaterThanOrEqual(
			minimumFeatureCount,
		);

		const ids = new Set(EXPERIMENTAL_FEATURES.map((feature) => feature.id));
		expect(ids.size).toBe(EXPERIMENTAL_FEATURES.length);

		for (const feature of EXPERIMENTAL_FEATURES) {
			expect(feature.defaultEnabled).toBe(true);
			expect(feature.owner.length).toBeGreaterThan(0);
			expect(feature.killSwitch.length).toBeGreaterThan(0);
			expect(feature.telemetryEvent).toContain("experimental_feature_");
			expect(feature.affectedSurfaces.length).toBeGreaterThan(0);
		}
	});

	test("keeps at least ten features per declared category", () => {
		const countsByCategory = new Map(
			EXPERIMENTAL_FEATURE_CATEGORIES.map((category) => [category, 0]),
		);
		for (const feature of EXPERIMENTAL_FEATURES) {
			countsByCategory.set(
				feature.category,
				(countsByCategory.get(feature.category) ?? 0) + 1,
			);
		}

		for (const category of EXPERIMENTAL_FEATURE_CATEGORIES) {
			const featureCount = countsByCategory.get(category) ?? 0;
			expect(listExperimentalFeatures(category)).toHaveLength(featureCount);
			expect(featureCount).toBeGreaterThanOrEqual(10);
		}
		const categorizedCount = Array.from(countsByCategory.values()).reduce(
			(total, count) => total + count,
			0,
		);
		expect(categorizedCount).toBe(EXPERIMENTAL_FEATURES.length);
	});

	test("provides Russian-first visible copy for the experiments catalog", () => {
		expect(EXPERIMENTAL_FEATURE_CATEGORY_LABELS.templates).toBe("Шаблоны");
		expect(EXPERIMENTAL_FEATURE_CATEGORY_LABELS.rooms).toBe(
			"Объединённые процессы",
		);
		expect(formatExperimentalFeatureSurfaceLabel("Template gallery")).toBe(
			"Галерея шаблонов",
		);

		const forbiddenVisibleLabels = [
			"Needs config",
			"Available",
			"Stubbed",
			"Templates",
			"Agent Onboarding Templates",
			"Database Mapper Templates",
		];

		for (const feature of EXPERIMENTAL_FEATURES) {
			const copy = getExperimentalFeatureDisplayCopy(feature);
			const visibleCopy = [
				EXPERIMENTAL_FEATURE_CATEGORY_LABELS[feature.category],
				copy.title,
				copy.shortDescription,
				copy.longDescription,
				...feature.affectedSurfaces.map(formatExperimentalFeatureSurfaceLabel),
			].join(" ");
			for (const label of forbiddenVisibleLabels) {
				expect(visibleCopy).not.toContain(label);
			}
		}
	});

	test("resolves a disabled user override without changing availability", () => {
		const state = resolveExperimentalFeatureState(
			"agentNative.screenContextBus",
			{
				overrides: {
					"agentNative.screenContextBus": false,
				},
			},
		);

		expect(state.enabled).toBe(false);
		expect(state.userOverride).toBe(false);
		expect(state.availability).toBe("not_implemented");
	});

	test("reports missing provider configuration while preserving default-on preference", () => {
		const state = resolveExperimentalFeatureState("live.voiceRooms");

		expect(state.enabled).toBe(true);
		expect(state.userOverride).toBeNull();
		expect(state.availability).toBe("needs_configuration");
		expect(
			state.missingDependencies?.map((dependency) => dependency.id),
		).toEqual(["livekit"]);
		expect(state.reason).toContain("Требуется настройка");
		expect(state.reason).toContain("LiveKit");
		expect(state.reason).toContain("Настройте URL LiveKit");
		expect(state.reason).toContain("Значения секретов здесь не показываются");
		expect(state.reason).not.toContain("LIVEKIT_API_SECRET");
		expect(state.reason).not.toContain("NEXT_PUBLIC_LIVEKIT_URL");
	});

	test("reports blocked kill switches as disabled", () => {
		const state = resolveExperimentalFeatureState("projectOs.workspaceShell", {
			killSwitches: {
				"projectOs.workspaceShell": true,
			},
		});

		expect(state.enabled).toBe(false);
		expect(state.availability).toBe("blocked");
	});

	test("guards unknown IDs", () => {
		expect(isExperimentalFeatureId("rooms.voiceToPr")).toBe(true);
		expect(isExperimentalFeatureId("missing.feature")).toBe(false);
		expect(getExperimentalFeatureDefinition("missing.feature")).toBeUndefined();
	});

	test("templates.marketplace ships a ready, locally-backed surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"templates.marketplace",
		);
		expect(definition).toBeDefined();
		// The slice is powered by the local project-creation engine, so the only
		// required provider is the desktop runtime (no external catalog endpoint).
		expect(definition?.implementationStatus).toBe("ready");
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
	});

	test("templates.marketplace resolves available with the desktop runtime", () => {
		const state = resolveExperimentalFeatureState("templates.marketplace", {
			dependencies: { "desktop-runtime": "configured" },
		});
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("templates.marketplace stays hidden when disabled by the user", () => {
		const state = resolveExperimentalFeatureState("templates.marketplace", {
			dependencies: { "desktop-runtime": "configured" },
			overrides: { "templates.marketplace": false },
		});
		expect(state.enabled).toBe(false);
		expect(state.availability).toBe("available");
	});

	test("templates.previewSandbox ships a ready, locally-derived dry-run surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"templates.previewSandbox",
		);
		expect(definition).toBeDefined();
		// The preview is a pure dry-run derived from the local template spec +
		// starter-preset catalog, so — like templates.marketplace — the only
		// required provider is the desktop runtime (no external catalog endpoint).
		expect(definition?.implementationStatus).toBe("ready");
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
		// The Agent-Native templates endpoint must NOT be a dependency of the local
		// dry-run preview (importing external templates is a separate feature).
		expect(
			(definition?.dependencies ?? []).some(
				(dependency) => dependency.id === "agent-native-templates",
			),
		).toBe(false);
	});

	test("templates.previewSandbox resolves available with the desktop runtime", () => {
		const state = resolveExperimentalFeatureState("templates.previewSandbox", {
			dependencies: { "desktop-runtime": "configured" },
		});
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("templates.previewSandbox stays hidden when disabled by the user", () => {
		const state = resolveExperimentalFeatureState("templates.previewSandbox", {
			dependencies: { "desktop-runtime": "configured" },
			overrides: { "templates.previewSandbox": false },
		});
		expect(state.enabled).toBe(false);
		expect(state.availability).toBe("available");
	});

	test("templates.permissionsManifest ships a ready, locally-derived confirm surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"templates.permissionsManifest",
		);
		expect(definition).toBeDefined();
		// The manifest is derived purely from the local template spec +
		// starter-preset catalog (the pre-install confirm step), so — like
		// templates.previewSandbox — the only required provider is the desktop
		// runtime (no external catalog endpoint).
		expect(definition?.implementationStatus).toBe("ready");
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
		// The Agent-Native templates endpoint must NOT gate the local confirm step
		// (importing external templates is a separate feature).
		expect(
			(definition?.dependencies ?? []).some(
				(dependency) => dependency.id === "agent-native-templates",
			),
		).toBe(false);
	});

	test("templates.permissionsManifest resolves available with the desktop runtime", () => {
		const state = resolveExperimentalFeatureState(
			"templates.permissionsManifest",
			{ dependencies: { "desktop-runtime": "configured" } },
		);
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("templates.permissionsManifest stays hidden when disabled by the user", () => {
		const state = resolveExperimentalFeatureState(
			"templates.permissionsManifest",
			{
				dependencies: { "desktop-runtime": "configured" },
				overrides: { "templates.permissionsManifest": false },
			},
		);
		expect(state.enabled).toBe(false);
		expect(state.availability).toBe("available");
	});

	test("live.pushToTalkDesktop ships a ready desktop-runtime surface gated on LiveKit", () => {
		const definition = getExperimentalFeatureDefinition(
			"live.pushToTalkDesktop",
		);
		expect(definition).toBeDefined();
		expect(definition?.implementationStatus).toBe("ready");
		// The global-shortcut surface only needs LiveKit (for the voice room); the
		// desktop runtime is a runtime dependency, not a blocking provider.
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders.map((dependency) => dependency.id)).toEqual([
			"livekit",
		]);
	});

	test("live.pushToTalkDesktop resolves available once LiveKit is configured", () => {
		const state = resolveExperimentalFeatureState("live.pushToTalkDesktop", {
			dependencies: { "desktop-runtime": "configured", livekit: "configured" },
		});
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("live.pushToTalkDesktop needs configuration when LiveKit is missing", () => {
		const state = resolveExperimentalFeatureState("live.pushToTalkDesktop", {
			dependencies: { "desktop-runtime": "configured", livekit: "missing" },
		});
		// Enabled by default, but not usable until the provider is configured —
		// so the gate (enabled && available) stays closed.
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("needs_configuration");
	});

	// --- Project OS Phase-1: native object graph, Huly demoted ---------------

	test("Huly is an OPTIONAL provider (not a required gate)", () => {
		// Every project-os.* feature that lists Huly must treat it as optional, so
		// the resolver never marks them needs_configuration purely for missing Huly.
		const huly = EXPERIMENTAL_FEATURES.flatMap((f) => f.dependencies).find(
			(dep) => dep.id === "huly",
		);
		expect(huly).toBeDefined();
		expect(huly?.required).toBe(false);
	});

	test("Huly is never the reason a projectOs.* feature is gated", () => {
		// Only the desktop runtime is configured — no huly provider at all.
		const deps = { "desktop-runtime": "configured" } as const;
		for (const feature of listExperimentalFeatures("project-os")) {
			const state = resolveExperimentalFeatureState(feature, {
				dependencies: deps,
			});
			// Missing Huly env must never appear in the gating reason after demote.
			expect(state.reason ?? "").not.toContain("Huly");

			// A feature whose ONLY provider dependency is Huly must NOT be
			// needs_configuration once Huly is optional (it resolves on its own
			// implementationStatus instead). Features with a different required
			// provider (e.g. meetingNotes → LiveKit) may still need configuration.
			const otherRequiredProviders = feature.dependencies.filter(
				(dep) => dep.kind === "provider" && dep.required && dep.id !== "huly",
			);
			if (otherRequiredProviders.length === 0) {
				expect(state.availability).not.toBe("needs_configuration");
			}
		}
	});

	test("projectOs.workspaceShell ships a ready, locally-backed surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"projectOs.workspaceShell",
		);
		expect(definition).toBeDefined();
		expect(definition?.implementationStatus).toBe("ready");
		// Backed by ProjectObjectGraphLaunchpad — no required provider dependency.
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
	});

	test("projectOs.workspaceShell resolves available with the desktop runtime", () => {
		const state = resolveExperimentalFeatureState("projectOs.workspaceShell", {
			dependencies: { "desktop-runtime": "configured" },
		});
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("projectOs.crmContacts ships a ready, natively-backed contacts surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"projectOs.crmContacts",
		);
		expect(definition).toBeDefined();
		expect(definition?.implementationStatus).toBe("ready");
		// Backed by CrmContactsPanel over `graph.listContacts` + `graph.neighbors` —
		// Huly is demoted to an optional import connector, so there is no required
		// provider dependency (the contact objects are canonical on the Rox graph).
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
	});

	test("projectOs.crmContacts resolves available with the desktop runtime", () => {
		const state = resolveExperimentalFeatureState("projectOs.crmContacts", {
			dependencies: { "desktop-runtime": "configured" },
		});
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("agentNative.commandPalette ships a ready, locally-backed surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"agentNative.commandPalette",
		);
		expect(definition).toBeDefined();
		expect(definition?.implementationStatus).toBe("ready");
		// Backed by the desktop command palette's agentNativeProvider — gated only
		// on the desktop runtime, with no external Agent-Native provider dependency
		// (clean flip, no provider demotion required).
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
	});

	test("agentNative.commandPalette resolves available with the desktop runtime", () => {
		const state = resolveExperimentalFeatureState(
			"agentNative.commandPalette",
			{ dependencies: { "desktop-runtime": "configured" } },
		);
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});

	test("agentNative.commandPalette stays hidden when disabled by the user", () => {
		const state = resolveExperimentalFeatureState(
			"agentNative.commandPalette",
			{
				dependencies: { "desktop-runtime": "configured" },
				overrides: { "agentNative.commandPalette": false },
			},
		);
		// The provider gate is `enabled && available`; a user opt-out closes it
		// even though the surface itself is available.
		expect(state.enabled).toBe(false);
		expect(state.availability).toBe("available");
	});

	test("projectOs.hulyImport stays planned but is no longer needs_configuration", () => {
		// The optional Huly import connector is still 'planned' (no surface yet),
		// but with no Huly env it now reports not_implemented (planned) rather than
		// needs_configuration — Huly is optional.
		const state = resolveExperimentalFeatureState("projectOs.hulyImport", {
			dependencies: { "desktop-runtime": "configured" },
		});
		expect(state.availability).toBe("not_implemented");
	});

	test("collaboration.threadsAsObjects ships a ready, Postgres/Electric-backed surface", () => {
		const definition = getExperimentalFeatureDefinition(
			"collaboration.threadsAsObjects",
		);
		expect(definition).toBeDefined();
		expect(definition?.implementationStatus).toBe("ready");
		// Durable on the native object graph (comment_threads/comments + Electric),
		// so Liveblocks is OPTIONAL — there is no required provider gate.
		const requiredProviders = (definition?.dependencies ?? []).filter(
			(dependency) => dependency.kind === "provider" && dependency.required,
		);
		expect(requiredProviders).toHaveLength(0);
	});

	test("collaboration.threadsAsObjects resolves available with the desktop runtime (no Liveblocks)", () => {
		// The comment surface opens with only the desktop runtime; missing Liveblocks
		// must NOT push it to needs_configuration (Liveblocks is an optional
		// accelerator), so the gate (enabled && available) opens.
		const state = resolveExperimentalFeatureState(
			"collaboration.threadsAsObjects",
			{ dependencies: { "desktop-runtime": "configured" } },
		);
		expect(state.enabled).toBe(true);
		expect(state.availability).toBe("available");
		expect(state.reason).toBeUndefined();
	});
});
