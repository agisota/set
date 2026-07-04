import { describe, expect, it } from "bun:test";
import {
	DEFAULT_ONBOARDING_STATUS,
	normalizeOnboardingStatus,
} from "@rox/shared/onboarding";
import {
	findStep,
	getFirstIncompleteStep,
	getFirstIncompleteStepInOrder,
	getNextIncompleteStepAfter,
	getStepNavigationRoute,
	isStepRouteMatch,
	selectResumableTourStep,
} from "./onboardingTourStepSelection";

describe("onboarding tour step selection", () => {
	const completedAt = "2026-06-26T00:00:00.000Z";

	it("treats v1 and v2 workspace routes as compatible", () => {
		const workspaceStep = findStep("workspace", "workspace-chat");

		if (!workspaceStep) {
			throw new Error("workspace-chat step must exist");
		}
		expect(isStepRouteMatch("/workspace", workspaceStep)).toBe(true);
		expect(isStepRouteMatch("/workspace/abc", workspaceStep)).toBe(true);
		expect(isStepRouteMatch("/v2-workspace/abc", workspaceStep)).toBe(true);
	});

	it("navigates v2 tour steps through packaged v1-compatible routes", () => {
		const workspaceStep = findStep("workspace", "workspace-chat");
		const workspacesStep = findStep("workspaces", "open-workspaces");

		if (!workspaceStep || !workspacesStep) {
			throw new Error("workspace tour steps must exist");
		}

		expect(getStepNavigationRoute(workspaceStep)).toBe("/workspace");
		expect(getStepNavigationRoute(workspacesStep)).toBe("/workspaces");
	});

	it("preserves nested path suffixes when navigating through route aliases", () => {
		const workspaceStep = findStep("workspace", "workspace-chat");

		if (!workspaceStep) {
			throw new Error("workspace-chat step must exist");
		}

		expect(getStepNavigationRoute(workspaceStep, "/v2-workspace/abc")).toBe(
			"/workspace/abc",
		);
		expect(getStepNavigationRoute(workspaceStep, "/workspace/abc")).toBe(
			"/workspace/abc",
		);
	});

	it("prefers a visible incomplete step on resume instead of a hidden active step", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				activeTourId: "tasks_pr",
				activeStepId: "tasks-create",
				pausedAt: completedAt,
			},
		});
		const hiddenActiveStep = findStep("tasks_pr", "tasks-create");

		if (!hiddenActiveStep) {
			throw new Error("tasks-create step must exist");
		}

		const selected = selectResumableTourStep({
			status,
			activeStep: hiddenActiveStep,
			pathname: "/workspace",
			isTargetVisible: (anchor) => anchor === "nav-workspaces",
		});

		expect(selected?.tourId).toBe("workspaces");
		expect(selected?.id).toBe("open-workspaces");
	});

	it("does not resume a stale later active step when an earlier step is still incomplete", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				activeTourId: "workspace",
				activeStepId: "workspace-chat",
				pausedAt: completedAt,
			},
		});
		const staleActiveStep = findStep("workspace", "workspace-chat");

		if (!staleActiveStep) {
			throw new Error("workspace-chat step must exist");
		}

		const selected = selectResumableTourStep({
			status,
			activeStep: staleActiveStep,
			pathname: "/workspace",
			isTargetVisible: (anchor) =>
				anchor === "workspace-chat" || anchor === "nav-workspaces",
		});

		expect(selected?.tourId).toBe("workspaces");
		expect(selected?.id).toBe("open-workspaces");
	});

	it("prefers a visible current-route step over a visible sidebar step on resume", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				activeTourId: "workspace",
				activeStepId: "workspace-chat",
				pausedAt: completedAt,
				completedTours: {
					workspaces: completedAt,
					workspace: completedAt,
				},
			},
		});
		const hiddenActiveStep = findStep("workspace", "workspace-chat");

		const selected = selectResumableTourStep({
			status,
			activeStep: hiddenActiveStep,
			pathname: "/tasks",
			isTargetVisible: (anchor) =>
				anchor === "nav-settings" || anchor === "tasks-create",
		});

		expect(selected?.tourId).toBe("tasks_pr");
		expect(selected?.id).toBe("tasks-create");
	});

	it("falls back to the active incomplete step when no incomplete target is visible", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				activeTourId: "tasks_pr",
				activeStepId: "tasks-create",
				pausedAt: completedAt,
				completedTours: {
					workspaces: completedAt,
					workspace: completedAt,
				},
			},
		});
		const hiddenActiveStep = findStep("tasks_pr", "tasks-create");

		if (!hiddenActiveStep) {
			throw new Error("tasks-create step must exist");
		}

		const selected = selectResumableTourStep({
			status,
			activeStep: hiddenActiveStep,
			pathname: "/workspace",
			isTargetVisible: () => false,
		});

		expect(selected).toBe(hiddenActiveStep);
	});

	it("does not resume a hidden active step on the current route when another incomplete step is navigable", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				activeTourId: "workspace",
				activeStepId: "workspace-chat",
				pausedAt: completedAt,
				completedTours: {
					workspaces: completedAt,
				},
			},
		});
		const hiddenActiveStep = findStep("workspace", "workspace-chat");

		const selected = selectResumableTourStep({
			status,
			activeStep: hiddenActiveStep,
			pathname: "/workspace",
			isTargetVisible: () => false,
		});

		expect(selected?.tourId).toBe("tasks_pr");
		expect(selected?.id).toBe("tasks-create");
	});

	it("can require visible anchors when choosing the first incomplete step", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				completedTours: {
					workspaces: completedAt,
					workspace: completedAt,
				},
			},
		});

		const selected = getFirstIncompleteStep(status, "/workspace", {
			preferVisibleTarget: true,
			isTargetVisible: (anchor) => anchor === "nav-settings",
		});

		expect(selected?.tourId).toBe("settings");
	});

	it("chooses the next incomplete step by registry order after the active step", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				completedTours: {
					workspace: completedAt,
				},
				completedSteps: {
					workspace: {
						"workspace-chat": completedAt,
					},
				},
			},
		});
		const activeStep = findStep("workspace", "workspace-chat");

		if (!activeStep) {
			throw new Error("workspace-chat step must exist");
		}

		const selected = getNextIncompleteStepAfter(status, activeStep);

		expect(selected?.tourId).toBe("tasks_pr");
		expect(selected?.id).toBe("tasks-create");
	});

	it("does not wrap next-step selection after the final tour step", () => {
		const status = normalizeOnboardingStatus({
			activation: {
				...DEFAULT_ONBOARDING_STATUS.activation,
				completedAt,
			},
			tours: {
				...DEFAULT_ONBOARDING_STATUS.tours,
				completedTours: {
					workspaces: completedAt,
					workspace: completedAt,
					tasks_pr: completedAt,
					automations: completedAt,
					pipelines: completedAt,
					skills_library: completedAt,
					memory: completedAt,
					settings: completedAt,
				},
			},
		});
		const finalStep = findStep("settings", "settings-models");

		if (!finalStep) {
			throw new Error("settings-models step must exist");
		}

		expect(getNextIncompleteStepAfter(status, finalStep)).toBeNull();
		expect(getFirstIncompleteStepInOrder(status)).toBeNull();
	});
});
