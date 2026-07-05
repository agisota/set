import { PIPELINE_TEMPLATES, type PipelineTemplate } from "../templates";
import { PipelineTemplateCard } from "./components/PipelineTemplateCard";

interface PipelinesEmptyStateProps {
	/** Create a pipeline from the chosen template (skips the dialog). */
	onSelectTemplate: (template: PipelineTemplate) => void;
	/** Disables the cards while a create is in flight. */
	isCreating?: boolean;
}

/**
 * Empty state for the pipelines index. Instead of a bare dashed box, it surfaces
 * the built-in templates inline as selectable cards (mirroring the Automations
 * "Начните с шаблона" gallery). The "Пустой" template stays available so users
 * can still start from a blank canvas.
 */
export function PipelinesEmptyState({
	onSelectTemplate,
	isCreating = false,
}: PipelinesEmptyStateProps) {
	return (
		<div className="flex w-full flex-col gap-6">
			<div className="flex flex-col gap-1">
				<h2 className="text-base font-semibold tracking-tight">
					Начните с шаблона
				</h2>
				<p className="text-sm text-muted-foreground">
					Выберите готовый граф — создастся пайплайн, который можно сразу
					отредактировать на холсте.
				</p>
			</div>
			<div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
				{PIPELINE_TEMPLATES.map((template) => (
					<PipelineTemplateCard
						key={template.id}
						template={template}
						onSelect={onSelectTemplate}
						disabled={isCreating}
					/>
				))}
			</div>
		</div>
	);
}
