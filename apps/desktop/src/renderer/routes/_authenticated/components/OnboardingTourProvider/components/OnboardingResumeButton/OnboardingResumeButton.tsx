import { Button } from "@rox/ui/button";

interface OnboardingResumeButtonProps {
	percent: number;
	onResume: () => void;
}

export function OnboardingResumeButton({
	percent,
	onResume,
}: OnboardingResumeButtonProps) {
	return (
		<Button
			className="no-drag pointer-events-auto fixed left-3 bottom-[calc(env(safe-area-inset-bottom)+22rem)] z-[60] max-w-[min(18rem,calc(100vw-1.5rem))] shadow-lg"
			size="sm"
			onClick={onResume}
		>
			Продолжить онбординг · {percent}%
		</Button>
	);
}
