import { Button } from "@rox/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@rox/ui/dialog";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { Skeleton } from "@rox/ui/skeleton";
import { toast } from "@rox/ui/sonner";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	ChevronRight,
	FilePlus,
	Folder,
	FolderPlus,
	HardDrive,
	Link2,
	LoaderCircle,
	Sparkles,
} from "lucide-react";
import { useState } from "react";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { logger } from "renderer/lib/logger";
import { SuiteQueryError } from "../components/SuiteQueryError";
import { SuiteScreen } from "../components/SuiteScreen";
import { formatFileSize } from "../utils/formatFileSize";

interface Crumb {
	id: string | null;
	name: string;
}

type ShareDialogState = {
	url: string;
	targetKind: "file" | "folder";
};

/** Public share base — files/folders resolve at `rox.one/d/<token>`. */
const SHARE_BASE = "https://rox.one/d";

function getErrorMessage(error: unknown) {
	if (error instanceof Error) return error.message;
	return "";
}

function getDriveActionErrorDescription(error: unknown, fallback: string) {
	const message = getErrorMessage(error);

	if (/object storage|R2 credentials/i.test(message)) {
		return "Drive storage на backend не настроен: отсутствуют R2 credentials. Публичное скачивание файлов недоступно до настройки storage.";
	}

	if (/still being processed/i.test(message)) {
		return "Файл еще обрабатывается. Ссылку можно создать после завершения загрузки и проверки.";
	}

	if (/safety scan/i.test(message)) {
		return "Файл заблокирован проверкой безопасности, поэтому публичная ссылка для него недоступна.";
	}

	return message || fallback;
}

/**
 * Drive folder/file browser (Suite P0). Reads `drive.listFolder` for the current
 * folder, supports drilling into folders via a breadcrumb trail, creating a
 * folder, and minting a public share link for a file or folder
 * (`drive.createShare`). Bytes never proxy through the app — share/download URLs
 * are presigned server-side; P0 surfaces share-link creation only.
 *
 * Cache-first (AGENTS.md rule 9): existing rows render immediately; the skeleton
 * shows only when there is genuinely no data and the query is still loading.
 */
export function DriveView() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();

	const [trail, setTrail] = useState<Crumb[]>([{ id: null, name: "Диск" }]);
	const currentFolderId = trail[trail.length - 1]?.id ?? null;

	const [createOpen, setCreateOpen] = useState(false);
	const [folderName, setFolderName] = useState("");
	const [shareDialog, setShareDialog] = useState<ShareDialogState | null>(null);
	const [organizeResult, setOrganizeResult] = useState<{
		movedCount: number;
		createdFolderCount: number;
		targets: { folderName: string }[];
	} | null>(null);
	const [organizeError, setOrganizeError] = useState<string | null>(null);

	const listQuery = useQuery(
		trpc.drive.listFolder.queryOptions({ folderId: currentFolderId }),
	);

	const createFolder = useMutation(
		trpc.drive.createFolder.mutationOptions({
			onSuccess: async () => {
				await queryClient.invalidateQueries({
					queryKey: trpc.drive.listFolder.queryKey({
						folderId: currentFolderId,
					}),
				});
				setCreateOpen(false);
				setFolderName("");
			},
			onError: (error) => {
				logger.error("[DriveView] createFolder failed", error);
				toast.error("Не удалось создать папку");
			},
		}),
	);

	const createShare = useMutation(
		trpc.drive.createShare.mutationOptions({
			onSuccess: (row) => {
				const url = `${SHARE_BASE}/${row.token}`;
				setShareDialog({
					url,
					targetKind: row.fileId ? "file" : "folder",
				});
				void navigator.clipboard?.writeText(url).then(
					() => toast.success("Ссылка скопирована"),
					() => toast.success("Ссылка создана"),
				);
			},
			onError: (error) => {
				const description = getDriveActionErrorDescription(
					error,
					"Backend не создал публичную ссылку. Повторите позже.",
				);
				logger.error("[DriveView] createShare failed", error);
				toast.error("Не удалось создать ссылку", { description });
			},
		}),
	);

	const organizeFolder = useMutation(
		trpc.drive.organizeFolder.mutationOptions({
			onMutate: () => {
				setOrganizeResult(null);
				setOrganizeError(null);
			},
			onSuccess: async (result) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.drive.listFolder.queryKey({
						folderId: currentFolderId,
					}),
				});
				setOrganizeResult(result);

				if (result.movedCount === 0) {
					toast.success("На диске уже порядок");
					return;
				}

				toast.success("Файлы разложены по папкам", {
					description: `${result.movedCount} файл(ов), ${result.createdFolderCount} новая папка(и).`,
				});
			},
			onError: (error) => {
				const description = getDriveActionErrorDescription(
					error,
					"Backend не выполнил безопасную сортировку текущей папки. Файлы не изменены.",
				);
				setOrganizeError(description);
				logger.error("[DriveView] organizeFolder failed", error);
				toast.error("Не удалось навести порядок", { description });
			},
		}),
	);

	const folders = listQuery.data?.folders ?? [];
	const files = listQuery.data?.files ?? [];
	const isEmpty = folders.length === 0 && files.length === 0;

	const openFolder = (id: string, name: string) => {
		setTrail((prev) => [...prev, { id, name }]);
	};

	const goToCrumb = (index: number) => {
		setTrail((prev) => prev.slice(0, index + 1));
	};

	return (
		<SuiteScreen
			title="Диск"
			description="Файлы и папки, общий доступ по ссылке"
			icon={HardDrive}
			actions={
				<>
					<Button
						variant="outline"
						disabled={organizeFolder.isPending || listQuery.isLoading}
						aria-label="Навести порядок в текущей папке"
						title="Разложить файлы в текущей папке по типам: документы, изображения, медиа, архивы, код и прочее."
						onClick={() => organizeFolder.mutate({ folderId: currentFolderId })}
					>
						{organizeFolder.isPending ? (
							<LoaderCircle className="size-4 animate-spin" />
						) : (
							<Sparkles className="size-4" />
						)}
						Навести порядок
					</Button>
					<Button onClick={() => setCreateOpen(true)}>
						<FolderPlus className="size-4" /> Новая папка
					</Button>
				</>
			}
		>
			<nav className="mb-4 flex flex-wrap items-center gap-1 text-sm">
				{trail.map((crumb, index) => (
					<span key={crumb.id ?? "root"} className="flex items-center gap-1">
						{index > 0 && (
							<ChevronRight className="size-3.5 text-muted-foreground" />
						)}
						<button
							type="button"
							onClick={() => goToCrumb(index)}
							disabled={index === trail.length - 1}
							className="rounded px-1 py-0.5 text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:font-medium disabled:text-foreground"
						>
							{crumb.name}
						</button>
					</span>
				))}
			</nav>

			{organizeResult && (
				<div className="mb-4 rounded-lg border border-border bg-card/80 px-4 py-3 text-sm">
					<p className="font-medium text-foreground">
						{organizeResult.movedCount > 0
							? `Разложено файлов: ${organizeResult.movedCount}`
							: "В текущей папке нечего раскладывать"}
					</p>
					<p className="mt-1 text-muted-foreground text-xs">
						{organizeResult.movedCount > 0
							? `Папок создано: ${organizeResult.createdFolderCount}. Направления: ${organizeResult.targets
									.map((target) => target.folderName)
									.join(", ")}.`
							: "Создайте или загрузите файлы, чтобы авто-сортировка перенесла их по типам."}
					</p>
				</div>
			)}

			{organizeError && (
				<div className="mb-4 rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-3 text-sm">
					<p className="font-medium text-foreground">
						Наведение порядка недоступно
					</p>
					<p className="mt-1 cursor-text select-text text-muted-foreground text-xs">
						{organizeError}
					</p>
				</div>
			)}

			{listQuery.isError && (
				<SuiteQueryError
					message={listQuery.error.message}
					onRetry={() => listQuery.refetch()}
				/>
			)}

			{isEmpty && listQuery.isLoading && (
				<div className="space-y-2">
					{[0, 1, 2, 3].map((i) => (
						<Skeleton key={i} className="h-12 w-full" />
					))}
				</div>
			)}

			{isEmpty && listQuery.isSuccess && (
				<div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed py-20 text-center">
					<FilePlus className="mb-3 size-8 text-muted-foreground" />
					<span className="text-foreground text-sm">Папка пуста</span>
					<span className="mt-1 max-w-sm text-muted-foreground text-xs">
						Создайте подпапку. Когда здесь появится файл или папка, рядом будет
						кнопка «Поделиться».
					</span>
				</div>
			)}

			{!isEmpty && (
				<div className="overflow-hidden rounded-lg border border-border bg-card/80">
					{folders.map((folder) => (
						<div
							key={folder.id}
							className="flex items-center gap-3 border-border border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/40"
						>
							<button
								type="button"
								onClick={() => openFolder(folder.id, folder.name)}
								className="flex min-w-0 flex-1 items-center gap-3 text-left"
							>
								<Folder className="size-4 shrink-0 text-primary" />
								<span className="truncate text-sm">{folder.name}</span>
							</button>
							<Button
								size="sm"
								variant="outline"
								aria-label={`Поделиться папкой ${folder.name}`}
								className="shrink-0 gap-1.5"
								disabled={createShare.isPending}
								onClick={() => createShare.mutate({ folderId: folder.id })}
							>
								<Link2 className="size-4" />
								<span>Поделиться</span>
							</Button>
						</div>
					))}
					{files.map((file) => (
						<div
							key={file.id}
							className="flex items-center gap-3 border-border border-b px-3 py-2.5 last:border-b-0 hover:bg-accent/40"
						>
							<FilePlus className="size-4 shrink-0 text-muted-foreground" />
							<span className="min-w-0 flex-1 truncate text-sm">
								{file.name}
							</span>
							<span className="shrink-0 text-muted-foreground text-xs tabular-nums">
								{formatFileSize(file.sizeBytes)}
							</span>
							<Button
								size="sm"
								variant="outline"
								aria-label={`Поделиться файлом ${file.name}`}
								className="shrink-0 gap-1.5"
								disabled={createShare.isPending}
								onClick={() => createShare.mutate({ fileId: file.id })}
							>
								<Link2 className="size-4" />
								<span>Поделиться</span>
							</Button>
						</div>
					))}
				</div>
			)}

			<Dialog open={createOpen} onOpenChange={setCreateOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Новая папка</DialogTitle>
						<DialogDescription>
							Папка будет создана в текущем расположении.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="drive-folder-name">Название</Label>
						<Input
							id="drive-folder-name"
							value={folderName}
							onChange={(e) => setFolderName(e.target.value)}
							placeholder="Например: Документы"
							onKeyDown={(e) => {
								if (e.key === "Enter" && folderName.trim()) {
									createFolder.mutate({
										name: folderName.trim(),
										parentId: currentFolderId,
									});
								}
							}}
						/>
					</div>
					<DialogFooter>
						<Button
							disabled={!folderName.trim() || createFolder.isPending}
							onClick={() =>
								createFolder.mutate({
									name: folderName.trim(),
									parentId: currentFolderId,
								})
							}
						>
							Создать
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			<Dialog
				open={shareDialog !== null}
				onOpenChange={(open) => {
					if (!open) setShareDialog(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Ссылка для доступа</DialogTitle>
						<DialogDescription>
							{shareDialog?.targetKind === "folder"
								? "Папка доступна по публичной ссылке. Массовое скачивание папок пока не включено."
								: "Файл доступен по публичной ссылке. Если storage backend не настроен, создание такой ссылки блокируется заранее."}
						</DialogDescription>
					</DialogHeader>
					<Input
						readOnly
						value={shareDialog?.url ?? ""}
						className="cursor-text select-text"
						onFocus={(e) => e.currentTarget.select()}
					/>
					<DialogFooter>
						<Button
							variant="outline"
							onClick={() => {
								if (shareDialog?.url) {
									void navigator.clipboard
										?.writeText(shareDialog.url)
										.then(() => toast.success("Ссылка скопирована"));
								}
							}}
						>
							Скопировать
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SuiteScreen>
	);
}
