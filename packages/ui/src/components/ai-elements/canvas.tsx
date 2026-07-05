import { Background, ReactFlow, type ReactFlowProps } from "@xyflow/react";
import type { ReactNode } from "react";
import { cn } from "../../lib/utils";
import "@xyflow/react/dist/style.css";

type CanvasProps = ReactFlowProps & {
	children?: ReactNode;
};

export const Canvas = ({ children, className, ...props }: CanvasProps) => (
	<ReactFlow
		className={cn("h-full w-full", className)}
		deleteKeyCode={["Backspace", "Delete"]}
		fitView
		panOnDrag={false}
		panOnScroll
		selectionOnDrag={true}
		zoomOnDoubleClick={false}
		{...props}
	>
		<Background
			bgColor="var(--sidebar)"
			color="hsl(var(--muted-foreground) / 0.22)"
			gap={44}
			size={0.7}
		/>
		{children}
	</ReactFlow>
);
