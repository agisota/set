import {
	Message,
	MessageContent,
	MessageResponse,
} from "@rox/ui/ai-elements/message";
import { cn } from "@rox/ui/lib/utils";
import {
	AnimatedHeight,
	motionSpring,
	StatusPulse,
	useShouldAnimate,
} from "@rox/ui/motion";
import { motion } from "framer-motion";
import { SubagentInnerToolCall } from "renderer/components/Chat/components/SubagentInnerToolCall";
import {
	type SubagentEntries,
	toSubagentViewModels,
} from "./utils/toSubagentViewModels";

interface SubagentExecutionMessageProps {
	subagents: SubagentEntries;
	inline?: boolean;
}

function getStatusLabel(status: "running" | "completed" | "error"): string {
	if (status === "running") return "Выполняется";
	if (status === "completed") return "Завершено";
	return "Ошибка";
}

function getStatusClassName(status: "running" | "completed" | "error"): string {
	if (status === "running") {
		return "border-primary/40 bg-primary/10 text-primary";
	}
	if (status === "completed") {
		return "border-emerald-500/40 bg-emerald-500/10 text-emerald-700 dark:text-emerald-400";
	}
	return "border-destructive/40 bg-destructive/10 text-destructive";
}

export function SubagentExecutionMessage({
	subagents,
	inline = false,
}: SubagentExecutionMessageProps) {
	const animate = useShouldAnimate("decorative");
	if (subagents.length === 0) return null;
	const viewModels = toSubagentViewModels(subagents);

	const content = (
		<div className="w-full max-w-none space-y-3 rounded-xl border bg-card/95 p-3">
			<div className="text-sm font-medium text-foreground">
				Активность субагентов
			</div>
			<motion.div
				className="space-y-3"
				initial={animate ? "hidden" : false}
				animate={animate ? "visible" : undefined}
				variants={
					animate
						? { visible: { transition: { staggerChildren: 0.05 } } }
						: undefined
				}
			>
				{viewModels.map((subagent) => (
					<motion.div
						key={subagent.toolCallId}
						className="space-y-2 rounded-md border bg-muted/20 p-3"
						layout={animate}
						variants={
							animate
								? {
										hidden: { opacity: 0, y: 6 },
										visible: { opacity: 1, y: 0 },
									}
								: undefined
						}
						transition={animate ? motionSpring.soft : undefined}
					>
						<div className="flex flex-wrap items-center justify-between gap-2">
							<div className="flex items-center gap-2 text-sm font-medium text-foreground">
								{animate && subagent.status === "running" ? (
									<StatusPulse colorClassName="bg-primary" />
								) : null}
								{subagent.task}
							</div>
							<span
								className={cn(
									"rounded-full border px-2 py-0.5 text-xs font-medium",
									getStatusClassName(subagent.status),
								)}
							>
								{getStatusLabel(subagent.status)}
							</span>
						</div>
						<AnimatedHeight
							open={animate ? subagent.status === "running" : true}
						>
							<div className="space-y-2">
								{subagent.toolCalls.length > 0 ? (
									<div className="space-y-1">
										{subagent.toolCalls.map((tool, index) => (
											<SubagentInnerToolCall
												key={`${subagent.toolCallId}-${tool.name}-${index}`}
												name={tool.name}
												isError={tool.isError}
												isPending={
													subagent.status === "running" &&
													index === subagent.toolCalls.length - 1
												}
												args={tool.args}
												result={tool.result}
											/>
										))}
									</div>
								) : null}
								{subagent.text ? (
									<MessageResponse
										animated={false}
										isAnimating={false}
										mermaid={{ config: { theme: "default" } }}
									>
										{subagent.text}
									</MessageResponse>
								) : null}
							</div>
						</AnimatedHeight>
					</motion.div>
				))}
			</motion.div>
		</div>
	);

	if (inline) return content;

	return (
		<Message from="assistant">
			<MessageContent>{content}</MessageContent>
		</Message>
	);
}
