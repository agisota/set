import {
	EXPERIMENTAL_FEATURE_CATEGORIES,
	EXPERIMENTAL_FEATURE_CATEGORY_LABELS,
	EXPERIMENTAL_FEATURES,
	type ExperimentalFeatureAvailability,
	type ExperimentalFeatureId,
	type ExperimentalFeatureMaturity,
	type ExperimentalFeatureState,
	formatExperimentalFeatureSurfaceLabel,
	getExperimentalFeatureDisplayCopy,
} from "@rox/shared/experimental-features";
import { Badge } from "@rox/ui/badge";
import { Button } from "@rox/ui/button";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { toast } from "@rox/ui/sonner";
import { Switch } from "@rox/ui/switch";
import { useMemo, useState } from "react";
import { HiOutlineArrowPath, HiOutlineMagnifyingGlass } from "react-icons/hi2";
import { track } from "renderer/lib/analytics";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { TemplateGalleryModal } from "renderer/routes/_authenticated/components/TemplateGalleryModal";
import { getLaunchpadAction } from "./launchpad-action";

const AVAILABILITY_LABEL: Record<ExperimentalFeatureAvailability, string> = {
	available: "Доступно",
	blocked: "Заблокировано",
	needs_configuration: "Требуется настройка",
	not_implemented: "Ещё не подключено",
};

const AVAILABILITY_CLASS: Record<ExperimentalFeatureAvailability, string> = {
	available: "border-emerald-500/40 text-emerald-700 dark:text-emerald-300",
	blocked: "border-destructive/50 text-destructive",
	needs_configuration: "border-amber-500/50 text-amber-700 dark:text-amber-300",
	not_implemented: "border-sky-500/40 text-sky-700 dark:text-sky-300",
};

const MATURITY_LABEL: Record<ExperimentalFeatureMaturity, string> = {
	alpha: "Альфа",
	beta: "Бета",
	preview: "Предпросмотр",
};

const LAUNCHPAD_ITEMS = [
	{
		featureId: "agentNative.sourceMarketplace",
		title: "Источники агентов",
		description: "Подключить Agent-Native источники к composer и запускам.",
	},
	{
		featureId: "templates.marketplace",
		title: "Галерея шаблонов",
		description: "Просматривать и применять Agent-Native шаблоны.",
	},
	{
		featureId: "collaboration.presence",
		title: "Комнаты совместной работы",
		description: "Открывать общие рабочие комнаты с Liveblocks-ready presence.",
	},
	{
		featureId: "live.voiceRooms",
		title: "Live-операции",
		description: "Запускать голосовые и агентные комнаты на LiveKit.",
	},
	{
		featureId: "projectOs.workspaceShell",
		title: "Project OS",
		description:
			"Навигация по связанным задачам, чатам, звонкам и roadmap-данным.",
	},
	{
		featureId: "rooms.operationsCommandCenter",
		title: "Объединённые процессы",
		description:
			"Запуск межпровайдерных операционных комнат с агентами и live-контекстом.",
	},
] as const satisfies readonly {
	description: string;
	featureId: ExperimentalFeatureId;
	title: string;
}[];

function getDefaultState(id: ExperimentalFeatureId): ExperimentalFeatureState {
	return {
		id,
		enabled: true,
		defaultEnabled: true,
		userOverride: null,
		availability: "not_implemented",
		reason: "Загружаем текущее состояние.",
		dependencies: [],
	};
}

function normalizeSearch(value: string) {
	return value.trim().toLowerCase();
}

function featureCardId(id: ExperimentalFeatureId): string {
	return `experimental-feature-card-${id.replaceAll(".", "-")}`;
}

function formatAvailabilityReason(
	state: ExperimentalFeatureState,
	fallback?: string,
) {
	if (state.availability === "needs_configuration") {
		const missingDependencies = state.missingDependencies?.length
			? state.missingDependencies
			: state.dependencies.filter(
					(dependency) => dependency.kind === "provider" && dependency.required,
				);
		if (missingDependencies.length > 0) {
			const dependencyNames = missingDependencies
				.map((dependency) => dependency.label)
				.join(", ");
			const setupHints = missingDependencies
				.map((dependency) => dependency.configurationHint)
				.filter((hint): hint is string => Boolean(hint?.trim()));
			return [
				`Требуется настройка: ${dependencyNames}.`,
				...setupHints,
				"Откройте настройки соответствующего провайдера или интеграции и добавьте недостающую конфигурацию. Значения секретов здесь не показываются.",
			].join(" ");
		}
		return (
			fallback ??
			"Требуется настройка провайдера или среды выполнения. Проверьте соответствующий раздел настроек; значения секретов здесь не показываются."
		);
	}
	if (state.availability === "blocked") {
		return "Функция отключена глобальным переключателем безопасности.";
	}
	if (state.availability === "not_implemented") {
		return "Панель управления уже видна, но продуктовая поверхность ещё подключается.";
	}
	if (!state.enabled) {
		return "Отключено в настройках экспериментов.";
	}
	return fallback;
}

export function ExperimentalFeatureCatalog() {
	const [searchQuery, setSearchQuery] = useState("");
	const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
	const utils = electronTrpc.useUtils();
	const statesQuery =
		electronTrpc.settings.experimentalFeatures.list.useQuery();
	const setOverride =
		electronTrpc.settings.experimentalFeatures.setOverride.useMutation({
			onSuccess: async (_state, variables) => {
				await utils.settings.experimentalFeatures.list.invalidate();
				const definition = EXPERIMENTAL_FEATURES.find(
					(feature) => feature.id === variables.id,
				);
				if (definition) {
					track(definition.telemetryEvent, { enabled: variables.enabled });
				}
			},
			onError: (error) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Не удалось обновить экспериментальную функцию",
				);
			},
		});
	const resetAll =
		electronTrpc.settings.experimentalFeatures.resetAll.useMutation({
			onSuccess: async () => {
				await utils.settings.experimentalFeatures.list.invalidate();
				toast.success(
					"Экспериментальные функции сброшены к значениям по умолчанию",
				);
			},
			onError: (error) => {
				toast.error(
					error instanceof Error
						? error.message
						: "Не удалось сбросить экспериментальные функции",
				);
			},
		});

	const statesById = useMemo(
		() =>
			new Map(
				(statesQuery.data ?? []).map((state) => [
					state.id,
					state as ExperimentalFeatureState,
				]),
			),
		[statesQuery.data],
	);

	const normalizedSearch = normalizeSearch(searchQuery);
	const visibleFeatures = useMemo(() => {
		if (!normalizedSearch) return EXPERIMENTAL_FEATURES;
		return EXPERIMENTAL_FEATURES.filter((feature) => {
			const displayCopy = getExperimentalFeatureDisplayCopy(feature);
			const haystack = [
				feature.id,
				displayCopy.title,
				displayCopy.shortDescription,
				displayCopy.longDescription,
				feature.category,
				...feature.affectedSurfaces.map(formatExperimentalFeatureSurfaceLabel),
				...feature.dependencies.map((dependency) => dependency.label),
			]
				.join(" ")
				.toLowerCase();
			return haystack.includes(normalizedSearch);
		});
	}, [normalizedSearch]);

	const totalEnabled = Array.from(statesById.values()).filter(
		(state) => state.enabled,
	).length;
	const fallbackEnabled = statesQuery.data
		? totalEnabled
		: EXPERIMENTAL_FEATURES.length;

	function openLaunchpadFeature(id: ExperimentalFeatureId) {
		if (getLaunchpadAction(id) === "open-template-gallery") {
			setTemplateGalleryOpen(true);
			return;
		}
		const card = document.getElementById(featureCardId(id));
		card?.scrollIntoView({ block: "center", behavior: "smooth" });
		card?.focus({ preventScroll: true });
	}

	return (
		<section className="space-y-5">
			<div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
				<div className="space-y-1">
					<Label className="text-sm font-medium">
						Управление экспериментальными функциями
					</Label>
					<p className="text-xs text-muted-foreground">
						Здесь видны экспериментальные возможности и их готовность. Если
						функция требует настройку, Rox показывает безопасную диагностику без
						значений секретов.
					</p>
				</div>
				<div className="flex items-center gap-2">
					<Badge variant="outline">
						{fallbackEnabled}/{EXPERIMENTAL_FEATURES.length} включено
					</Badge>
					<Button
						type="button"
						variant="outline"
						size="sm"
						onClick={() => resetAll.mutate()}
						disabled={resetAll.isPending || setOverride.isPending}
					>
						<HiOutlineArrowPath className="size-4" aria-hidden />
						Сбросить всё
					</Button>
				</div>
			</div>

			<div className="relative">
				<HiOutlineMagnifyingGlass
					className="-translate-y-1/2 pointer-events-none absolute top-1/2 left-3 size-4 text-muted-foreground"
					aria-hidden
				/>
				<Input
					value={searchQuery}
					onChange={(event) => setSearchQuery(event.target.value)}
					placeholder="Поиск по экспериментам, провайдерам, поверхностям..."
					className="pl-9"
				/>
			</div>

			<div className="space-y-3 rounded-md border p-4">
				<div className="space-y-1">
					<h3 className="text-sm font-semibold">Точки входа</h3>
					<p className="text-xs text-muted-foreground">
						Эти точки входа читают те же переключатели. Отключённые функции
						остаются скрытыми или неактивными вне этой панели.
					</p>
				</div>
				<div className="grid gap-3 md:grid-cols-2">
					{LAUNCHPAD_ITEMS.map((item) => {
						const state =
							statesById.get(item.featureId) ?? getDefaultState(item.featureId);
						const isDisabled =
							!state.enabled || state.availability !== "available";
						const actionLabel = !state.enabled
							? "Отключено"
							: state.availability === "needs_configuration"
								? "Настроить"
								: state.availability === "blocked"
									? "Заблокировано"
									: state.availability === "not_implemented"
										? "Скоро"
										: "Открыть";
						const reason = formatAvailabilityReason(state, state.reason);

						return (
							<div
								key={item.featureId}
								className="flex items-start justify-between gap-3 rounded-md border bg-muted/20 p-3"
							>
								<div className="min-w-0 space-y-1">
									<div className="flex flex-wrap items-center gap-2">
										<p className="text-sm font-medium">{item.title}</p>
										<Badge
											variant="outline"
											className={AVAILABILITY_CLASS[state.availability]}
										>
											{AVAILABILITY_LABEL[state.availability]}
										</Badge>
									</div>
									<p className="text-xs text-muted-foreground">
										{item.description}
									</p>
									{reason && (
										<p className="text-xs text-muted-foreground">{reason}</p>
									)}
								</div>
								<Button
									type="button"
									size="sm"
									variant="outline"
									onClick={() => openLaunchpadFeature(item.featureId)}
									disabled={isDisabled}
									className="shrink-0"
								>
									{actionLabel}
								</Button>
							</div>
						);
					})}
				</div>
			</div>

			<div className="space-y-6">
				{EXPERIMENTAL_FEATURE_CATEGORIES.map((category) => {
					const categoryFeatures = visibleFeatures.filter(
						(feature) => feature.category === category,
					);
					if (categoryFeatures.length === 0) return null;

					return (
						<section key={category} className="space-y-3">
							<div className="flex items-center justify-between gap-3 border-b pb-2">
								<h3 className="text-sm font-semibold">
									{EXPERIMENTAL_FEATURE_CATEGORY_LABELS[category]}
								</h3>
								<Badge variant="secondary">{categoryFeatures.length}</Badge>
							</div>
							<div className="divide-y rounded-md border">
								{categoryFeatures.map((feature) => {
									const displayCopy =
										getExperimentalFeatureDisplayCopy(feature);
									const state =
										statesById.get(feature.id) ?? getDefaultState(feature.id);
									const reason = formatAvailabilityReason(state, state.reason);
									const switchId = `experimental-feature-${feature.id.replaceAll(
										".",
										"-",
									)}`;

									return (
										<div
											key={feature.id}
											id={featureCardId(feature.id)}
											tabIndex={-1}
											className="grid gap-4 p-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-start"
										>
											<div className="min-w-0 space-y-3">
												<div className="space-y-1">
													<div className="flex flex-wrap items-center gap-2">
														<Label
															htmlFor={switchId}
															className="text-sm font-medium"
														>
															{displayCopy.title}
														</Label>
														<Badge variant="outline">
															{MATURITY_LABEL[feature.maturity]}
														</Badge>
														<Badge
															variant="outline"
															className={AVAILABILITY_CLASS[state.availability]}
														>
															{AVAILABILITY_LABEL[state.availability]}
														</Badge>
														{state.userOverride !== null && (
															<Badge variant="secondary">Изменено</Badge>
														)}
													</div>
													<p className="text-xs text-muted-foreground">
														{displayCopy.shortDescription}
													</p>
												</div>

												<div className="flex flex-wrap gap-1.5">
													{feature.affectedSurfaces.map((surface) => (
														<Badge key={surface} variant="outline">
															{formatExperimentalFeatureSurfaceLabel(surface)}
														</Badge>
													))}
												</div>

												{feature.dependencies.length > 0 && (
													<p className="text-xs text-muted-foreground">
														Зависимости:{" "}
														{feature.dependencies
															.map((dependency) => dependency.label)
															.join(", ")}
													</p>
												)}

												{reason && (
													<p className="text-xs text-muted-foreground">
														{reason}
													</p>
												)}

												<details className="text-xs text-muted-foreground">
													<summary className="cursor-pointer text-foreground">
														Подробнее
													</summary>
													<p className="mt-1">{displayCopy.longDescription}</p>
												</details>
											</div>

											<Switch
												id={switchId}
												checked={state.enabled}
												onCheckedChange={(enabled) =>
													setOverride.mutate({ id: feature.id, enabled })
												}
												disabled={
													statesQuery.isLoading ||
													setOverride.isPending ||
													resetAll.isPending
												}
												aria-label={`Переключить ${displayCopy.title}`}
												className="justify-self-start md:justify-self-end"
											/>
										</div>
									);
								})}
							</div>
						</section>
					);
				})}
			</div>

			<TemplateGalleryModal
				open={templateGalleryOpen}
				onOpenChange={setTemplateGalleryOpen}
				onCreated={({ projectId }) => {
					setTemplateGalleryOpen(false);
					toast.success("Проект создан из шаблона", {
						description: `ID проекта: ${projectId}`,
					});
				}}
				onError={(message) =>
					toast.error("Не удалось создать проект", { description: message })
				}
			/>
		</section>
	);
}
