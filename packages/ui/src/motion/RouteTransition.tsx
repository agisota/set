import { AnimatePresence, motion } from "motion/react";
import type { ReactNode } from "react";
import { ease, motionDuration } from "./tokens";
import { useShouldAnimate } from "./useMotionPreference";

/**
 * Page-level route transition wrapper (case 003 / PR-03).
 *
 * Wraps the single shared dashboard `<Outlet />` in a short opacity+y crossfade
 * keyed on the top-level path segment, so only coarse page-category switches
 * (workspace ↔ automations ↔ tasks) animate — never intra-category workspace
 * switches, which would otherwise remount xterm/CodeMirror/BrowserPane subtrees.
 *
 * Decorative tier: when `useShouldAnimate('decorative')` is false (reduced
 * motion / Off / Essential) we skip AnimatePresence entirely and render the
 * content directly so those users never trigger enter/exit remount churn.
 */
export function RouteTransition({
	transitionKey,
	children,
}: {
	transitionKey: string;
	children: ReactNode;
}) {
	const shouldAnimate = useShouldAnimate("decorative");
	if (!shouldAnimate) {
		return <div className="flex min-h-0 min-w-0 w-full flex-1">{children}</div>;
	}
	return (
		<AnimatePresence mode="wait" initial={false}>
			<motion.div
				key={transitionKey}
				className="flex min-h-0 min-w-0 w-full flex-1"
				initial={{ opacity: 0, y: 6 }}
				animate={{ opacity: 1, y: 0 }}
				exit={{ opacity: 0, y: -4 }}
				transition={{ duration: motionDuration.fast, ease: ease.standard }}
			>
				{children}
			</motion.div>
		</AnimatePresence>
	);
}
