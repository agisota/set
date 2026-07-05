interface ResolveActiveCanvasIdInput {
	initialCanvasId?: string | null;
	selectedCanvasId?: string | null;
	canvasIds: string[];
}

export function resolveActiveCanvasId({
	initialCanvasId,
	selectedCanvasId,
	canvasIds,
}: ResolveActiveCanvasIdInput): string | null {
	if (selectedCanvasId && canvasIds.includes(selectedCanvasId)) {
		return selectedCanvasId;
	}
	if (initialCanvasId && canvasIds.includes(initialCanvasId)) {
		return initialCanvasId;
	}
	return canvasIds[0] ?? null;
}
