export interface CanvasSelectionState {
	nodeIds: string[];
	edgeIds: string[];
	groupIds: string[];
}

export function emptyCanvasSelection(): CanvasSelectionState {
	return {
		nodeIds: [],
		edgeIds: [],
		groupIds: [],
	};
}

export function getCanvasSelectionCount(
	selection: CanvasSelectionState,
): number {
	return (
		selection.nodeIds.length +
		selection.edgeIds.length +
		selection.groupIds.length
	);
}

export function toCanvasCapabilitySelectionInput(
	selection: CanvasSelectionState,
): CanvasSelectionState | null {
	if (getCanvasSelectionCount(selection) === 0) return null;
	return {
		nodeIds: selection.nodeIds,
		edgeIds: selection.edgeIds,
		groupIds: selection.groupIds,
	};
}

interface CanvasCapabilityDisabledReasonInput {
	hasActiveCanvas: boolean;
	isPending: boolean;
	requiresSelection?: boolean;
	selection: CanvasSelectionState;
}

export function getCanvasCapabilityDisabledReason({
	hasActiveCanvas,
	isPending,
	requiresSelection,
	selection,
}: CanvasCapabilityDisabledReasonInput): string | undefined {
	if (!hasActiveCanvas) {
		return "Откройте сохраненный канвас перед запуском возможности.";
	}
	if (isPending) {
		return "Возможность канваса уже выполняется.";
	}
	if (requiresSelection && getCanvasSelectionCount(selection) === 0) {
		return "Выделите узлы, связи или группы перед запуском возможности.";
	}
	return undefined;
}
