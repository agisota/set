import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@rox/ui/dialog";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { toast } from "@rox/ui/sonner";
import { cn } from "@rox/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { Network, Plus, Workflow } from "lucide-react";
import { useState } from "react";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { logger } from "renderer/lib/logger";
import { PipelinesEmptyState } from "../PipelinesEmptyState";
import { PIPELINE_TEMPLATES, type PipelineTemplate } from "../templates";

/** Kebab-case a free-text name into a slug seed. */
function slugify(input: string): string {
	return input
		.toLowerCase()
		.trim()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 60);
}

/**
 * The pipelines index: lists the org's agent pipelines and creates a new one
 * from a template (or blank). A pipeline is a `workflow_definitions` row with
 * `engine="pipeline"`; creation seeds the chosen template's graph as the draft.
 *
 * Cache-first (AGENTS.md rule 9): existing pipeline rows render immediately.
 */
export function PipelinesIndex() {
	const trpc = useTRPC();
	const navigate = useNavigate();
	const queryClient = useQueryClient();

	const [dialogOpen, setDialogOpen] = useState(false);
	const [templateId, setTemplateId] = useState(PIPELINE_TEMPLATES[0]?.id ?? "");
	const [name, setName] = useState("");

	const pipelinesQuery = useQuery(trpc.pipeline.list.queryOptions(undefined));

	const createMutation = useMutation(
		trpc.pipeline.createDraft.mutationOptions({
			onSuccess: async (row) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.pipeline.list.queryKey(undefined),
				});
				setDialogOpen(false);
				setName("");
				navigate({
					to: "/pipelines/$pipelineId",
					params: { pipelineId: row.id },
				});
			},
			onError: (error) => {
				logger.error("[PipelinesIndex] createDraft failed", error);
				toast.error("Не удалось создать пайплайн");
			},
		}),
	);

	const pipelines = pipelinesQuery.data ?? [];

	/**
	 * Create a pipeline from a template. When `template` is passed (e.g. an
	 * empty-state gallery card), it creates from that template directly with its
	 * default name — skipping the dialog. Otherwise it falls back to the dialog's
	 * selected template + typed name.
	 */
	const handleCreate = (template?: PipelineTemplate) => {
		const chosen =
			template ??
			PIPELINE_TEMPLATES.find((t) => t.id === templateId) ??
			PIPELINE_TEMPLATES[0];
		if (!chosen) return;
		const finalName = (template ? "" : name.trim()) || chosen.name;
		const slug = `${slugify(finalName) || chosen.slugSeed}-${Date.now()
			.toString(36)
			.slice(-4)}`;
		createMutation.mutate({
			name: finalName,
			slug,
			draftState: chosen.build(),
		});
	};

	return (
		<div className="flex h-full w-full flex-col overflow-y-auto bg-background/85 px-6 py-6">
			<div className="mb-6 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
				<div className="min-w-0">
					<h1 className="flex min-w-0 items-center gap-2 text-xl font-medium">
						<Network className="size-5 text-primary" /> Пайплайны агентов
					</h1>
					<p className="max-w-2xl text-sm text-muted-foreground">
						Конструктор графов из агентов-ролей, триггеров и гейтов.
					</p>
				</div>

				<Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
					<DialogTrigger asChild>
						<Button className="w-fit shrink-0 self-start">
							<Plus className="size-4" /> Новый пайплайн
						</Button>
					</DialogTrigger>
					<DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] overflow-y-auto">
						<DialogHeader>
							<DialogTitle>Новый пайплайн</DialogTitle>
							<DialogDescription>
								Выберите шаблон графа — его можно отредактировать на холсте.
							</DialogDescription>
						</DialogHeader>
						<div className="flex flex-col gap-3">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="pipeline-name">Название</Label>
								<Input
									id="pipeline-name"
									value={name}
									onChange={(e) => setName(e.target.value)}
									placeholder="Например: Ревью кода"
								/>
							</div>
							<div className="flex flex-col gap-2">
								<Label>Шаблон</Label>
								<div className="grid gap-2">
									{PIPELINE_TEMPLATES.map((template) => (
										<button
											key={template.id}
											type="button"
											data-onboarding-anchor={
												template.id === PIPELINE_TEMPLATES[0]?.id
													? "pipeline-template"
													: undefined
											}
											aria-pressed={template.id === templateId}
											aria-label={`Выбрать шаблон: ${template.name}`}
											onClick={() => setTemplateId(template.id)}
											className={cn(
												"flex min-h-20 flex-col items-start gap-0.5 rounded-md border p-3 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
												template.id === templateId &&
													"border-primary bg-primary/5",
											)}
										>
											<span className="text-sm font-medium">
												{template.name}
											</span>
											<span className="text-xs text-muted-foreground">
												{template.description}
											</span>
										</button>
									))}
								</div>
							</div>
						</div>
						<DialogFooter>
							<Button
								disabled={createMutation.isPending}
								onClick={() => handleCreate()}
							>
								Создать
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>

			{pipelinesQuery.isError && (
				<div className="rounded-lg border border-destructive/40 p-6 text-center">
					<p className="select-text cursor-text text-sm text-destructive">
						{pipelinesQuery.error.message}
					</p>
					<Button
						size="sm"
						variant="outline"
						className="mt-3"
						onClick={() => pipelinesQuery.refetch()}
					>
						Повторить
					</Button>
				</div>
			)}

			{pipelinesQuery.isSuccess && pipelines.length === 0 && (
				<PipelinesEmptyState
					onSelectTemplate={handleCreate}
					isCreating={createMutation.isPending}
				/>
			)}

			<div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
				{pipelines.map((pipeline) => (
					<button
						key={pipeline.id}
						type="button"
						aria-label={`Открыть пайплайн ${pipeline.name}`}
						onClick={() =>
							navigate({
								to: "/pipelines/$pipelineId",
								params: { pipelineId: pipeline.id },
							})
						}
						className="flex min-h-32 flex-col items-start gap-2 rounded-lg border bg-card p-4 text-left transition-colors hover:border-primary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
					>
						<div className="flex w-full items-center gap-2">
							<Workflow className="size-4 text-primary" />
							<span className="flex-1 truncate text-sm font-medium">
								{pipeline.name}
							</span>
							{pipeline.status === "archived" && (
								<Badge variant="outline" className="text-[10px]">
									архив
								</Badge>
							)}
						</div>
						<span className="w-full truncate font-mono text-[11px] text-muted-foreground">
							{pipeline.slug}
						</span>
						{pipeline.description && (
							<p className="line-clamp-2 text-xs text-muted-foreground">
								{pipeline.description}
							</p>
						)}
					</button>
				))}
			</div>
		</div>
	);
}
