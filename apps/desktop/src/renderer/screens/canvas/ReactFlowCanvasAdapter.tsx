import type { CanvasDocument, CanvasMutationBatch } from "@rox/shared/canvas";
import { ReactFlowProvider } from "@xyflow/react";
import {
	CanvasFlow,
	type CanvasSelection,
} from "renderer/routes/_authenticated/_dashboard/canvas/CanvasFlow";

interface ReactFlowCanvasAdapterProps {
	baseVersion: number;
	compact?: boolean;
	disabled?: boolean;
	document: CanvasDocument;
	onMutationBatch: (batch: CanvasMutationBatch) => void;
	onSelectionChange: (selection: CanvasSelection) => void;
}

export function ReactFlowCanvasAdapter({
	baseVersion,
	disabled = false,
	document,
	onMutationBatch,
	onSelectionChange,
}: ReactFlowCanvasAdapterProps) {
	return (
		<ReactFlowProvider>
			<CanvasFlow
				baseVersion={baseVersion}
				disabled={disabled}
				document={document}
				modeBadge={disabled ? "Сохранение" : "Канвас"}
				onCreateTextNodeAt={() => undefined}
				onDropEntityAt={() => undefined}
				onMutationBatch={(batch) => onMutationBatch(batch)}
				onOpenRefNode={() => undefined}
				onSelectionChange={onSelectionChange}
			/>
		</ReactFlowProvider>
	);
}
