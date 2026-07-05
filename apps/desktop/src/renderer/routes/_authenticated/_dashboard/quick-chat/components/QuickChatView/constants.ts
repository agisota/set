import type { ThinkingLevel } from "@rox/ui/ai-elements/thinking-toggle";

export type ReasoningLevel = ThinkingLevel;

export const REASONING_LEVELS: ReasoningLevel[] = [
	"off",
	"low",
	"medium",
	"high",
	"xhigh",
];

export const DEFAULT_REASONING_LEVEL: ReasoningLevel = "medium";

export const STARTER_PROMPT_IDS = [
	"plan-day",
	"diff-bug-scan",
	"polish-draft",
	"research-digest",
] as const;
