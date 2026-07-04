import { Button } from "@rox/ui/button";
import { Card } from "@rox/ui/card";
import {
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";

export interface OnboardingOverlayStep {
	id: string;
	anchor: string;
	title: string;
	body: string;
	action: string;
}

interface TargetRect {
	top: number;
	left: number;
	width: number;
	height: number;
}

interface OnboardingOverlayProps {
	step: OnboardingOverlayStep;
	stepIndex: number;
	totalSteps: number;
	onPause: () => void;
	onNext: () => void;
	onTargetAvailabilityChange?: (isAvailable: boolean) => void;
}

const CARD_WIDTH = 360;
const CARD_MARGIN = 16;

function escapeAnchorSelector(anchor: string) {
	if ("CSS" in window && typeof window.CSS.escape === "function") {
		return window.CSS.escape(anchor);
	}

	return anchor.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function findAnchorTarget(anchor: string) {
	const targets = Array.from(
		document.querySelectorAll<HTMLElement>(
			`[data-onboarding-anchor="${escapeAnchorSelector(anchor)}"]`,
		),
	);

	return (
		targets.find((target) => {
			const rect = target.getBoundingClientRect();
			return rect.width > 0 && rect.height > 0;
		}) ?? null
	);
}

function getTargetRect(anchor: string): TargetRect | null {
	const target = findAnchorTarget(anchor);
	if (!target) {
		return null;
	}

	const rect = target.getBoundingClientRect();
	if (rect.width <= 0 || rect.height <= 0) {
		return null;
	}

	return {
		top: rect.top,
		left: rect.left,
		width: rect.width,
		height: rect.height,
	};
}

function clamp(value: number, min: number, max: number) {
	return Math.min(Math.max(value, min), max);
}

export function OnboardingOverlay({
	step,
	stepIndex,
	totalSteps,
	onPause,
	onNext,
	onTargetAvailabilityChange,
}: OnboardingOverlayProps) {
	const [targetRect, setTargetRect] = useState<TargetRect | null>(null);
	const dialogRef = useRef<HTMLDivElement>(null);
	const titleId = useId();
	const bodyId = useId();

	const updateTargetRect = useCallback(() => {
		const nextRect = getTargetRect(step.anchor);
		setTargetRect(nextRect);
		onTargetAvailabilityChange?.(nextRect !== null);
	}, [onTargetAvailabilityChange, step.anchor]);

	useEffect(() => {
		updateTargetRect();
		const observer = new MutationObserver(() => updateTargetRect());
		observer.observe(document.body, {
			childList: true,
			subtree: true,
			attributes: true,
			attributeFilter: [
				"aria-hidden",
				"class",
				"data-onboarding-anchor",
				"hidden",
				"style",
			],
		});
		window.addEventListener("resize", updateTargetRect);
		window.addEventListener("scroll", updateTargetRect, true);

		return () => {
			observer.disconnect();
			window.removeEventListener("resize", updateTargetRect);
			window.removeEventListener("scroll", updateTargetRect, true);
		};
	}, [updateTargetRect]);

	useEffect(() => {
		const previousActiveElement = document.activeElement;
		dialogRef.current?.focus();

		function getFocusableElements() {
			const root = dialogRef.current;
			if (!root) return [];
			return Array.from(
				root.querySelectorAll<HTMLElement>(
					'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
				),
			).filter(
				(element) =>
					!element.hasAttribute("disabled") &&
					element.getAttribute("aria-hidden") !== "true",
			);
		}

		function handleKeyDown(event: KeyboardEvent) {
			if (event.key === "Escape") {
				event.preventDefault();
				onPause();
				return;
			}

			if (event.key !== "Tab") {
				return;
			}

			const focusable = getFocusableElements();
			if (focusable.length === 0) {
				event.preventDefault();
				dialogRef.current?.focus();
				return;
			}

			const first = focusable[0];
			const last = focusable.at(-1);
			if (!first || !last) {
				return;
			}

			if (event.shiftKey && document.activeElement === first) {
				event.preventDefault();
				last.focus();
			} else if (!event.shiftKey && document.activeElement === last) {
				event.preventDefault();
				first.focus();
			}
		}

		document.addEventListener("keydown", handleKeyDown);
		return () => {
			document.removeEventListener("keydown", handleKeyDown);
			if (previousActiveElement instanceof HTMLElement) {
				previousActiveElement.focus();
			}
		};
	}, [onPause]);

	const cardPosition = useMemo(() => {
		if (!targetRect) {
			return null;
		}

		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;
		const preferredTop = targetRect.top + targetRect.height + CARD_MARGIN;
		const fallbackTop = targetRect.top - 220 - CARD_MARGIN;
		const top =
			preferredTop + 220 <= viewportHeight
				? preferredTop
				: Math.max(CARD_MARGIN, fallbackTop);

		return {
			top,
			left: clamp(
				targetRect.left,
				CARD_MARGIN,
				Math.max(CARD_MARGIN, viewportWidth - CARD_WIDTH - CARD_MARGIN),
			),
		};
	}, [targetRect]);

	if (!targetRect || !cardPosition) {
		return (
			<div
				ref={dialogRef}
				className="no-drag pointer-events-auto fixed inset-0 z-50"
				role="dialog"
				aria-modal="true"
				aria-labelledby={titleId}
				aria-describedby={bodyId}
				tabIndex={-1}
			>
				<div className="absolute inset-0 bg-black/60" />
				<Card className="no-drag pointer-events-auto absolute left-1/2 top-1/2 w-[min(24rem,calc(100vw-2rem))] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-lg border-border/70 bg-popover p-4 text-popover-foreground shadow-2xl">
					<div className="space-y-2">
						<div className="text-xs font-medium text-muted-foreground">
							Шаг {stepIndex + 1} из {totalSteps}
						</div>
						<div id={titleId} className="text-base font-semibold leading-tight">
							Готовим этот шаг
						</div>
						<p id={bodyId} className="text-sm leading-5 text-muted-foreground">
							{step.title}
						</p>
						<div className="rounded-md bg-muted px-3 py-2 text-sm">
							{step.action}
						</div>
					</div>
					<div className="flex items-center justify-end gap-2">
						<Button
							className="no-drag pointer-events-auto"
							variant="ghost"
							size="sm"
							onClick={onPause}
						>
							Отложить
						</Button>
						<Button
							className="no-drag pointer-events-auto"
							size="sm"
							onClick={onNext}
						>
							Дальше
						</Button>
					</div>
				</Card>
			</div>
		);
	}

	return (
		<div
			ref={dialogRef}
			className="no-drag pointer-events-auto fixed inset-0 z-50"
			role="dialog"
			aria-modal="true"
			aria-labelledby={titleId}
			aria-describedby={bodyId}
			tabIndex={-1}
		>
			<div className="absolute inset-0 bg-black/60" />
			<div
				className="pointer-events-none absolute rounded-lg ring-2 ring-primary ring-offset-2 ring-offset-background"
				style={{
					top: targetRect.top - 6,
					left: targetRect.left - 6,
					width: targetRect.width + 12,
					height: targetRect.height + 12,
					boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.35)",
				}}
			/>
			<Card
				className="no-drag pointer-events-auto absolute gap-4 rounded-lg border-border/70 bg-popover p-4 text-popover-foreground shadow-2xl"
				style={{
					top: cardPosition.top,
					left: cardPosition.left,
					width: CARD_WIDTH,
				}}
			>
				<div className="space-y-2">
					<div className="text-xs font-medium text-muted-foreground">
						Шаг {stepIndex + 1} из {totalSteps}
					</div>
					<div id={titleId} className="text-base font-semibold leading-tight">
						{step.title}
					</div>
					<p id={bodyId} className="text-sm leading-5 text-muted-foreground">
						{step.body}
					</p>
					<div className="rounded-md bg-muted px-3 py-2 text-sm">
						{step.action}
					</div>
				</div>
				<div className="flex items-center justify-end gap-2">
					<Button
						className="no-drag pointer-events-auto"
						variant="ghost"
						size="sm"
						onClick={onPause}
					>
						Отложить
					</Button>
					<Button
						className="no-drag pointer-events-auto"
						size="sm"
						onClick={onNext}
					>
						Дальше
					</Button>
				</div>
			</Card>
		</div>
	);
}
