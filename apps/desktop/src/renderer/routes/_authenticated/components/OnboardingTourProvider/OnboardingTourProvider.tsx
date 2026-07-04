import { ANALYTICS_EVENTS } from "@rox/shared/constants";
import {
	getOnboardingPercentComplete,
	normalizeOnboardingStatus,
	type OnboardingStatus,
	type SurfaceTourId,
} from "@rox/shared/onboarding";
import { useLocation, useNavigate } from "@tanstack/react-router";
import type { ReactNode } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { trackEvent } from "renderer/lib/analytics";
import { apiTrpcClient } from "renderer/lib/api-trpc-client";
import { logger } from "renderer/lib/logger";
import { useOnboardingTourStore } from "renderer/stores/onboarding-tour";
import { OnboardingOverlay } from "./components/OnboardingOverlay";
import { OnboardingResumeButton } from "./components/OnboardingResumeButton";
import { ONBOARDING_TOURS } from "./onboardingTourRegistry";
import {
	findStep,
	getFirstIncompleteStep,
	getFirstIncompleteStepInOrder,
	getNextIncompleteStepAfter,
	getStepIndex,
	getStepNavigationRoute,
	hasRemainingTours,
	isStepCompleted,
	isTourCompleted,
	selectResumableTourStep,
	TOUR_STEPS,
	type TourStepWithContext,
} from "./onboardingTourStepSelection";

interface OnboardingTourProviderProps {
	children: ReactNode;
}

function escapeAnchorSelector(anchor: string) {
	if ("CSS" in window && typeof window.CSS.escape === "function") {
		return window.CSS.escape(anchor);
	}

	return anchor.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function isTargetVisible(anchor: string) {
	const targets = Array.from(
		document.querySelectorAll<HTMLElement>(
			`[data-onboarding-anchor="${escapeAnchorSelector(anchor)}"]`,
		),
	);

	return targets.some((target) => {
		const rect = target.getBoundingClientRect();
		return rect.width > 0 && rect.height > 0;
	});
}

function markTourIfComplete(
	status: OnboardingStatus,
	tourId: SurfaceTourId,
	completedAt: string,
) {
	const tour = ONBOARDING_TOURS[tourId];
	const completedStepIds = status.tours.completedSteps[tourId] ?? {};
	const allTourStepsCompleted = tour.steps.every(
		(step) => completedStepIds[step.id],
	);
	if (!allTourStepsCompleted) {
		return status;
	}

	return normalizeOnboardingStatus({
		...status,
		tours: {
			...status.tours,
			completedTours: {
				...status.tours.completedTours,
				[tourId]: completedAt,
			},
		},
	});
}

function updateLocalStatus(
	status: OnboardingStatus,
	step: TourStepWithContext,
	completedAt: string,
) {
	return markTourIfComplete(
		normalizeOnboardingStatus({
			...status,
			tours: {
				...status.tours,
				activeTourId: step.tourId,
				activeStepId: step.id,
				pausedAt: null,
				completedSteps: {
					...status.tours.completedSteps,
					[step.tourId]: {
						...(status.tours.completedSteps[step.tourId] ?? {}),
						[step.id]: completedAt,
					},
				},
			},
		}),
		step.tourId,
		completedAt,
	);
}

export function OnboardingTourProvider({
	children,
}: OnboardingTourProviderProps) {
	const location = useLocation();
	const navigate = useNavigate();
	const activeTourId = useOnboardingTourStore((state) => state.activeTourId);
	const activeStepId = useOnboardingTourStore((state) => state.activeStepId);
	const pausedAt = useOnboardingTourStore((state) => state.pausedAt);
	const setActiveStep = useOnboardingTourStore((state) => state.setActiveStep);
	const pause = useOnboardingTourStore((state) => state.pause);
	const resume = useOnboardingTourStore((state) => state.resume);
	const clear = useOnboardingTourStore((state) => state.clear);
	const [status, setStatus] = useState<OnboardingStatus | null>(null);
	const [, setHasAvailableTarget] = useState(true);

	useEffect(() => {
		let cancelled = false;

		async function loadProgress() {
			try {
				const progress = await apiTrpcClient.user.onboardingProgress.query();
				if (!cancelled) {
					setStatus(normalizeOnboardingStatus(progress));
				}
			} catch (error) {
				logger.error("[onboarding-tour] progress load failed", error);
				if (!cancelled) {
					setStatus(normalizeOnboardingStatus(null));
				}
			}
		}

		void loadProgress();

		return () => {
			cancelled = true;
		};
	}, []);

	useEffect(() => {
		if (!status || activeTourId || activeStepId || pausedAt) {
			return;
		}

		const nextStep = getFirstIncompleteStep(status, location.pathname, {
			preferVisibleTarget: true,
			isTargetVisible,
		});
		if (!nextStep) {
			return;
		}

		setHasAvailableTarget(true);
		setActiveStep(nextStep.tourId, nextStep.id, location.pathname);
		trackEvent(ANALYTICS_EVENTS.ONBOARDING_TOUR_STARTED, {
			surface: nextStep.tourId,
			step_id: nextStep.id,
			route: location.pathname,
		});
	}, [
		activeStepId,
		activeTourId,
		location.pathname,
		pausedAt,
		setActiveStep,
		status,
	]);

	const activeStep = useMemo(
		() => findStep(activeTourId, activeStepId),
		[activeStepId, activeTourId],
	);
	const firstIncompleteStep = status
		? getFirstIncompleteStepInOrder(status)
		: null;
	const currentStep =
		status &&
		activeStep &&
		firstIncompleteStep &&
		getStepIndex(firstIncompleteStep) < getStepIndex(activeStep)
			? firstIncompleteStep
			: activeStep;
	const currentStepIndex = getStepIndex(currentStep);
	const hasRemaining = status ? hasRemainingTours(status) : false;
	const percent = status ? getOnboardingPercentComplete(status) : 0;
	const isActiveStepCompleted =
		status && currentStep
			? isStepCompleted(status, currentStep) ||
				isTourCompleted(status, currentStep.tourId)
			: false;
	const shouldShowResumeButton =
		hasRemaining && (currentStep === null || pausedAt !== null);
	const shouldShowOverlay =
		currentStep !== null && pausedAt === null && !isActiveStepCompleted;

	useEffect(() => {
		if (!status || !currentStep || !isActiveStepCompleted) {
			return;
		}

		const nextStep =
			getNextIncompleteStepAfter(status, currentStep) ??
			getFirstIncompleteStep(status, location.pathname, {
				preferVisibleTarget: false,
			});
		if (!nextStep) {
			clear();
			return;
		}

		const targetRoute = isTargetVisible(nextStep.anchor)
			? location.pathname
			: getStepNavigationRoute(nextStep, location.pathname);
		setHasAvailableTarget(true);
		setActiveStep(nextStep.tourId, nextStep.id, targetRoute);
		if (targetRoute !== location.pathname) {
			void navigate({ to: targetRoute });
		}
	}, [
		clear,
		currentStep,
		isActiveStepCompleted,
		location.pathname,
		navigate,
		setActiveStep,
		status,
	]);

	const patchServerTours = useCallback(
		async (
			patch: Parameters<
				typeof apiTrpcClient.user.updateOnboardingProgress.mutate
			>[0],
		) => {
			try {
				await apiTrpcClient.user.updateOnboardingProgress.mutate(patch);
			} catch (error) {
				logger.error("[onboarding-tour] progress update failed", error);
			}
		},
		[],
	);

	const handlePause = useCallback(() => {
		if (!currentStep) return;
		const pausedAtIso = new Date().toISOString();
		pause(location.pathname);
		setStatus((current) =>
			current
				? normalizeOnboardingStatus({
						...current,
						tours: {
							...current.tours,
							activeTourId: currentStep.tourId,
							activeStepId: currentStep.id,
							pausedAt: pausedAtIso,
							lastRoute: location.pathname,
						},
					})
				: current,
		);
		void patchServerTours({
			tours: {
				activeTourId: currentStep.tourId,
				activeStepId: currentStep.id,
				pausedAt: pausedAtIso,
				lastRoute: location.pathname,
			},
		});
		trackEvent(ANALYTICS_EVENTS.ONBOARDING_TOUR_PAUSED, {
			surface: currentStep.tourId,
			step_id: currentStep.id,
			route: location.pathname,
		});
	}, [currentStep, location.pathname, patchServerTours, pause]);

	const handleResume = useCallback(() => {
		const nextStep = status
			? selectResumableTourStep({
					status,
					activeStep: currentStep,
					pathname: location.pathname,
					isTargetVisible,
				})
			: currentStep;

		if (!nextStep) {
			clear();
			return;
		}

		const targetIsVisible = isTargetVisible(nextStep.anchor);
		const targetRoute = targetIsVisible
			? location.pathname
			: getStepNavigationRoute(nextStep, location.pathname);
		setHasAvailableTarget(true);
		resume();
		setActiveStep(nextStep.tourId, nextStep.id, targetRoute);
		if (targetRoute !== location.pathname) {
			void navigate({ to: targetRoute });
		}
		void patchServerTours({
			tours: {
				activeTourId: nextStep.tourId,
				activeStepId: nextStep.id,
				pausedAt: null,
				lastRoute: targetRoute,
			},
		});
		trackEvent(ANALYTICS_EVENTS.ONBOARDING_TOUR_RESUMED, {
			surface: nextStep.tourId,
			step_id: nextStep.id,
			route: targetRoute,
		});
	}, [
		clear,
		currentStep,
		location.pathname,
		navigate,
		patchServerTours,
		resume,
		setActiveStep,
		status,
	]);

	const handleNext = useCallback(() => {
		if (!currentStep || !status) {
			clear();
			return;
		}

		const completedAt = new Date().toISOString();
		const nextStatus = updateLocalStatus(status, currentStep, completedAt);
		setStatus(nextStatus);
		trackEvent(ANALYTICS_EVENTS.ONBOARDING_TOUR_STEP_COMPLETED, {
			surface: currentStep.tourId,
			step_id: currentStep.id,
			route: location.pathname,
		});

		if (nextStatus.tours.completedTours[currentStep.tourId]) {
			trackEvent(ANALYTICS_EVENTS.ONBOARDING_TOUR_COMPLETED, {
				surface: currentStep.tourId,
				route: location.pathname,
				completion_source: "overlay_next",
			});
		}

		if (!hasRemainingTours(nextStatus)) {
			trackEvent(ANALYTICS_EVENTS.ONBOARDING_ALL_COMPLETED, {
				completion_source: "overlay_next",
			});
			clear();
		}

		void patchServerTours({
			tours: {
				activeTourId: null,
				activeStepId: null,
				pausedAt: null,
				completedSteps: {
					[currentStep.tourId]: {
						...(nextStatus.tours.completedSteps[currentStep.tourId] ?? {}),
					},
				},
				completedTours: nextStatus.tours.completedTours,
				lastRoute: location.pathname,
			},
		});

		const nextStep =
			getNextIncompleteStepAfter(nextStatus, currentStep) ??
			getFirstIncompleteStepInOrder(nextStatus);

		if (!nextStep) {
			clear();
			return;
		}

		const targetRoute = isTargetVisible(nextStep.anchor)
			? location.pathname
			: getStepNavigationRoute(nextStep, location.pathname);
		setHasAvailableTarget(true);
		setActiveStep(nextStep.tourId, nextStep.id, targetRoute);
		if (targetRoute !== location.pathname) {
			void navigate({ to: targetRoute });
		}
	}, [
		clear,
		currentStep,
		location.pathname,
		navigate,
		patchServerTours,
		setActiveStep,
		status,
	]);

	return (
		<>
			{children}
			{shouldShowOverlay && currentStep ? (
				<OnboardingOverlay
					step={currentStep}
					stepIndex={Math.max(currentStepIndex, 0)}
					totalSteps={TOUR_STEPS.length}
					onPause={handlePause}
					onNext={handleNext}
					onTargetAvailabilityChange={setHasAvailableTarget}
				/>
			) : null}
			{shouldShowResumeButton ? (
				<OnboardingResumeButton percent={percent} onResume={handleResume} />
			) : null}
		</>
	);
}
