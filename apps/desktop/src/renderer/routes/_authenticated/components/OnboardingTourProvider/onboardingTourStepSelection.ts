import {
	type OnboardingStatus,
	REQUIRED_SURFACE_TOURS,
	type SurfaceTourId,
} from "@rox/shared/onboarding";
import {
	ONBOARDING_TOURS,
	type OnboardingTourStep,
} from "./onboardingTourRegistry";

export interface TourStepWithContext extends OnboardingTourStep {
	tourId: SurfaceTourId;
	surfaceName: string;
}

type IsTargetVisible = (anchor: string) => boolean;

const ROUTE_ALIASES: Partial<Record<string, string[]>> = {
	"/v2-workspace": ["/workspace"],
	"/v2-workspaces": ["/workspaces"],
};

export const TOUR_STEPS: TourStepWithContext[] = REQUIRED_SURFACE_TOURS.flatMap(
	(tourId) =>
		ONBOARDING_TOURS[tourId].steps.map((step) => ({
			...step,
			tourId,
			surfaceName: ONBOARDING_TOURS[tourId].surfaceName,
		})),
);

function isRouteMatch(pathname: string, route: string) {
	return pathname === route || pathname.startsWith(`${route}/`);
}

export function isStepRouteMatch(
	pathname: string,
	step: Pick<TourStepWithContext, "route">,
) {
	return [step.route, ...(ROUTE_ALIASES[step.route] ?? [])].some((route) =>
		isRouteMatch(pathname, route),
	);
}

export function getStepNavigationRoute(
	step: Pick<TourStepWithContext, "route">,
	pathname?: string,
) {
	const targetRoute = ROUTE_ALIASES[step.route]?.[0] ?? step.route;
	if (!pathname) return targetRoute;

	const matchedRoute = [step.route, ...(ROUTE_ALIASES[step.route] ?? [])].find(
		(route) => isRouteMatch(pathname, route),
	);
	if (!matchedRoute) return targetRoute;

	return `${targetRoute}${pathname.slice(matchedRoute.length)}`;
}

export function findStep(tourId: SurfaceTourId | null, stepId: string | null) {
	if (!tourId || !stepId) return null;
	return (
		TOUR_STEPS.find((step) => step.tourId === tourId && step.id === stepId) ??
		null
	);
}

export function isStepCompleted(
	status: OnboardingStatus,
	step: TourStepWithContext,
) {
	return Boolean(status.tours.completedSteps[step.tourId]?.[step.id]);
}

export function isTourCompleted(
	status: OnboardingStatus,
	tourId: SurfaceTourId,
) {
	return Boolean(status.tours.completedTours[tourId]);
}

export function hasRemainingTours(status: OnboardingStatus) {
	return REQUIRED_SURFACE_TOURS.some(
		(tourId) => !isTourCompleted(status, tourId),
	);
}

export function getStepIndex(step: TourStepWithContext | null) {
	if (!step) return -1;
	return TOUR_STEPS.findIndex(
		(candidate) => candidate.tourId === step.tourId && candidate.id === step.id,
	);
}

export function getFirstIncompleteStepInOrder(status: OnboardingStatus) {
	return (
		TOUR_STEPS.find(
			(step) =>
				!isStepCompleted(status, step) && !isTourCompleted(status, step.tourId),
		) ?? null
	);
}

export function getNextIncompleteStepAfter(
	status: OnboardingStatus,
	step: TourStepWithContext,
) {
	const activeStepIndex = getStepIndex(step);
	if (activeStepIndex < 0) {
		return getFirstIncompleteStepInOrder(status);
	}

	return (
		TOUR_STEPS.slice(activeStepIndex + 1).find(
			(candidate) =>
				!isStepCompleted(status, candidate) &&
				!isTourCompleted(status, candidate.tourId),
		) ?? null
	);
}

interface FirstIncompleteStepOptions {
	preferVisibleTarget: boolean;
	isTargetVisible?: IsTargetVisible;
}

export function getFirstIncompleteStep(
	status: OnboardingStatus,
	pathname: string,
	{ preferVisibleTarget, isTargetVisible }: FirstIncompleteStepOptions,
) {
	const canUseStep = (step: TourStepWithContext) =>
		!isStepCompleted(status, step) &&
		!isTourCompleted(status, step.tourId) &&
		(!preferVisibleTarget || isTargetVisible?.(step.anchor) === true);

	const routeStep = TOUR_STEPS.find(
		(step) => isStepRouteMatch(pathname, step) && canUseStep(step),
	);
	if (routeStep) return routeStep;

	return TOUR_STEPS.find(canUseStep) ?? null;
}

interface ResumableStepOptions {
	status: OnboardingStatus;
	activeStep: TourStepWithContext | null;
	pathname: string;
	isTargetVisible: IsTargetVisible;
}

export function selectResumableTourStep({
	status,
	activeStep,
	pathname,
	isTargetVisible,
}: ResumableStepOptions) {
	const incompleteSteps = TOUR_STEPS.filter(
		(step) =>
			!isStepCompleted(status, step) && !isTourCompleted(status, step.tourId),
	);
	const firstIncompleteStep = incompleteSteps[0] ?? null;
	const activeStepIsIncomplete =
		activeStep !== null &&
		incompleteSteps.some(
			(step) => step.tourId === activeStep.tourId && step.id === activeStep.id,
		);
	const activeStepIsStale =
		activeStepIsIncomplete &&
		firstIncompleteStep !== null &&
		getStepIndex(firstIncompleteStep) < getStepIndex(activeStep);

	if (activeStepIsStale) {
		return firstIncompleteStep;
	}

	if (activeStepIsIncomplete && isTargetVisible(activeStep.anchor)) {
		return activeStep;
	}

	const visibleRouteStep = incompleteSteps.find(
		(step) => isStepRouteMatch(pathname, step) && isTargetVisible(step.anchor),
	);
	if (visibleRouteStep) {
		return visibleRouteStep;
	}

	const visibleStep = incompleteSteps.find((step) =>
		isTargetVisible(step.anchor),
	);
	if (visibleStep) {
		return visibleStep;
	}

	const navigableStep = incompleteSteps.find(
		(step) => !isStepRouteMatch(pathname, step),
	);
	if (navigableStep) {
		return navigableStep;
	}

	return activeStepIsIncomplete ? activeStep : (incompleteSteps[0] ?? null);
}
