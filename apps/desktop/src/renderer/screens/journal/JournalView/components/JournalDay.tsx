import type { SelectJournalEntry } from "@rox/db/schema";

interface JournalDayProps {
	entry: SelectJournalEntry;
}

function formatDay(day: string): string {
	return new Intl.DateTimeFormat("ru-RU", {
		day: "numeric",
		month: "long",
		year: "numeric",
		timeZone: "UTC",
		weekday: "long",
	}).format(new Date(`${day}T12:00:00.000Z`));
}

export function JournalDay({ entry }: JournalDayProps) {
	const learnings = entry.learnings ?? [];
	const memorySuggestions = entry.memorySuggestions ?? [];
	const tips = entry.tips ?? [];

	return (
		<article className="space-y-5">
			<header>
				<h2 className="font-mono text-muted-foreground text-xs uppercase tracking-[0.18em]">
					{formatDay(entry.day)}
				</h2>
			</header>

			{entry.reflection ? (
				<p className="select-text font-serif text-foreground text-lg leading-relaxed">
					{entry.reflection}
				</p>
			) : null}

			{learnings.length > 0 ? (
				<section className="border-primary/60 border-l-2 pl-4">
					<h3 className="mb-2 font-semibold text-[11px] text-primary uppercase tracking-wider">
						Выводы
					</h3>
					<ul className="space-y-1.5">
						{learnings.map((learning, index) => (
							<li
								key={`${entry.id}-learning-${index}`}
								className="select-text text-foreground text-sm leading-snug"
							>
								{learning.text}
							</li>
						))}
					</ul>
				</section>
			) : null}

			{memorySuggestions.length > 0 ? (
				<section>
					<h3 className="mb-2 font-semibold text-[11px] text-amber-600 uppercase tracking-wider dark:text-amber-500">
						В память
					</h3>
					<div className="space-y-2">
						{memorySuggestions.map((suggestion, index) => (
							<div
								key={`${entry.id}-memory-${index}`}
								className="rounded-md border border-amber-500/25 bg-amber-500/5 p-2.5"
							>
								<span className="select-text text-foreground text-sm leading-snug">
									{suggestion.body}
								</span>
							</div>
						))}
					</div>
				</section>
			) : null}

			{tips.length > 0 ? (
				<section>
					<h3 className="mb-1.5 font-semibold text-[11px] text-muted-foreground uppercase tracking-wider">
						Советы
					</h3>
					<ul className="space-y-1">
						{tips.map((tip, index) => (
							<li
								key={`${entry.id}-tip-${index}`}
								className="select-text text-muted-foreground text-xs italic leading-snug"
							>
								{tip.text}
							</li>
						))}
					</ul>
				</section>
			) : null}
		</article>
	);
}
