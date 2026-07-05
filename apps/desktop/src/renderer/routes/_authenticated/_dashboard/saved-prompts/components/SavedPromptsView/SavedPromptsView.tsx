import type { SelectSavedPrompt } from "@rox/local-db";
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
import { toast } from "@rox/ui/sonner";
import { Textarea } from "@rox/ui/textarea";
import { cn } from "@rox/ui/utils";
import { useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import {
	LuBookmarkPlus,
	LuCopy,
	LuMessageSquarePlus,
	LuPencil,
	LuPlus,
	LuTrash2,
} from "react-icons/lu";
import { useCopyToClipboard } from "renderer/hooks/useCopyToClipboard";
import { electronTrpc } from "renderer/lib/electron-trpc";
import { useQuickChatDraftStore } from "renderer/stores/quick-chat-draft";
import { DEFAULT_SAVED_PROMPTS } from "./default-prompts";

type DialogState =
	| { mode: "closed" }
	| { mode: "create" }
	| { mode: "edit"; prompt: SelectSavedPrompt };

export function SavedPromptsView() {
	const navigate = useNavigate();
	const utils = electronTrpc.useUtils();
	const { copyToClipboard } = useCopyToClipboard();
	const stagePrompt = useQuickChatDraftStore((state) => state.stagePrompt);

	const { data: prompts = [], isLoading } =
		electronTrpc.savedPrompts.list.useQuery();

	const [dialog, setDialog] = useState<DialogState>({ mode: "closed" });
	const [title, setTitle] = useState("");
	const [body, setBody] = useState("");

	const invalidate = () => {
		void utils.savedPrompts.list.invalidate();
	};

	const createMutation = electronTrpc.savedPrompts.create.useMutation({
		onSuccess: () => {
			invalidate();
			setDialog({ mode: "closed" });
			toast.success("Промпт сохранён");
		},
		onError: (error) => toast.error(`Не удалось сохранить: ${error.message}`),
	});

	const updateMutation = electronTrpc.savedPrompts.update.useMutation({
		onSuccess: () => {
			invalidate();
			setDialog({ mode: "closed" });
			toast.success("Промпт обновлён");
		},
		onError: (error) => toast.error(`Не удалось обновить: ${error.message}`),
	});

	const deleteMutation = electronTrpc.savedPrompts.delete.useMutation({
		onSuccess: () => {
			invalidate();
			toast.success("Промпт удалён");
		},
		onError: (error) => toast.error(`Не удалось удалить: ${error.message}`),
	});

	const openCreate = () => {
		setTitle("");
		setBody("");
		setDialog({ mode: "create" });
	};

	const openEdit = (prompt: SelectSavedPrompt) => {
		setTitle(prompt.title);
		setBody(prompt.body);
		setDialog({ mode: "edit", prompt });
	};

	const handleSubmit = () => {
		const trimmedTitle = title.trim();
		if (trimmedTitle.length === 0 || body.trim().length === 0) {
			toast.error("Заполните название и текст промпта");
			return;
		}
		if (dialog.mode === "create") {
			createMutation.mutate({ title: trimmedTitle, body });
		} else if (dialog.mode === "edit") {
			updateMutation.mutate({
				id: dialog.prompt.id,
				title: trimmedTitle,
				body,
			});
		}
	};

	const handleUseInChat = (prompt: SelectSavedPrompt) => {
		stagePrompt(prompt.body);
		navigate({ to: "/quick-chat" });
	};

	const isSaving = createMutation.isPending || updateMutation.isPending;

	return (
		<div className="flex h-full w-full flex-1 flex-col overflow-hidden">
			<header className="flex items-center justify-between gap-3 border-b border-border px-6 py-4">
				<div className="min-w-0">
					<h1 className="text-lg font-semibold text-foreground">
						Сохранённые промпты
					</h1>
					<p className="text-sm text-muted-foreground">
						Библиотека готовых промптов — переиспользуйте их в чате.
					</p>
				</div>
				<Button onClick={openCreate} className="shrink-0">
					<LuPlus className="size-4" />
					Новый промпт
				</Button>
			</header>

			<div className="flex-1 overflow-y-auto px-6 py-4">
				{prompts.length === 0 ? (
					isLoading ? null : (
						<div className="flex w-full flex-col gap-3">
							<div className="flex flex-col gap-1 pt-2">
								<h2 className="text-sm font-medium text-foreground">
									Примеры — сохраните себе
								</h2>
								<p className="text-sm text-muted-foreground">
									Готовые промпты для старта. Сохраните понравившиеся или
									создайте свой.
								</p>
							</div>
							<ul className="grid gap-3 xl:grid-cols-2">
								{DEFAULT_SAVED_PROMPTS.map((example) => (
									<li
										key={example.id}
										className={cn(
											"group flex flex-col gap-2 rounded-lg border border-dashed border-border bg-card/50 p-4",
											"transition-colors hover:border-border/80",
										)}
									>
										<div className="flex items-start justify-between gap-3">
											<h3 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
												{example.title}
											</h3>
											<div className="flex shrink-0 items-center gap-1">
												<Button
													size="sm"
													variant="outline"
													onClick={() =>
														createMutation.mutate({
															title: example.title,
															body: example.body,
														})
													}
													disabled={createMutation.isPending}
												>
													<LuBookmarkPlus className="size-4" />
													Сохранить
												</Button>
												<Button
													size="icon"
													variant="ghost"
													aria-label="Вставить в чат"
													onClick={() => {
														stagePrompt(example.body);
														navigate({ to: "/quick-chat" });
													}}
												>
													<LuMessageSquarePlus className="size-4" />
												</Button>
												<Button
													size="icon"
													variant="ghost"
													aria-label="Скопировать"
													onClick={() => {
														void copyToClipboard(example.body);
														toast.success("Скопировано в буфер обмена");
													}}
												>
													<LuCopy className="size-4" />
												</Button>
											</div>
										</div>
										<p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground select-text">
											{example.body}
										</p>
									</li>
								))}
							</ul>
						</div>
					)
				) : (
					<ul className="grid gap-3 xl:grid-cols-2">
						{prompts.map((prompt) => (
							<li
								key={prompt.id}
								className={cn(
									"group flex flex-col gap-2 rounded-lg border border-border bg-card p-4",
									"transition-colors hover:border-border/80",
								)}
							>
								<div className="flex items-start justify-between gap-3">
									<h2 className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
										{prompt.title}
									</h2>
									<div className="flex shrink-0 items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100 group-focus-within:opacity-100">
										<Button
											size="icon"
											variant="ghost"
											aria-label="Вставить в чат"
											onClick={() => handleUseInChat(prompt)}
										>
											<LuMessageSquarePlus className="size-4" />
										</Button>
										<Button
											size="icon"
											variant="ghost"
											aria-label="Скопировать"
											onClick={() => {
												void copyToClipboard(prompt.body);
												toast.success("Скопировано в буфер обмена");
											}}
										>
											<LuCopy className="size-4" />
										</Button>
										<Button
											size="icon"
											variant="ghost"
											aria-label="Редактировать"
											onClick={() => openEdit(prompt)}
										>
											<LuPencil className="size-4" />
										</Button>
										<Button
											size="icon"
											variant="ghost"
											aria-label="Удалить"
											onClick={() => deleteMutation.mutate({ id: prompt.id })}
										>
											<LuTrash2 className="size-4" />
										</Button>
									</div>
								</div>
								<p className="line-clamp-3 whitespace-pre-wrap text-sm text-muted-foreground select-text">
									{prompt.body}
								</p>
							</li>
						))}
					</ul>
				)}
			</div>

			<Dialog
				open={dialog.mode !== "closed"}
				onOpenChange={(open) => {
					if (!open) setDialog({ mode: "closed" });
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>
							{dialog.mode === "edit" ? "Редактировать промпт" : "Новый промпт"}
						</DialogTitle>
						<DialogDescription>
							Название поможет быстро найти промпт, текст вставится в чат.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<Input
							placeholder="Название"
							value={title}
							onChange={(event) => setTitle(event.target.value)}
							maxLength={200}
							autoFocus
						/>
						<Textarea
							placeholder="Текст промпта"
							value={body}
							onChange={(event) => setBody(event.target.value)}
							className="min-h-40 resize-y"
						/>
					</div>
					<DialogFooter>
						<Button
							variant="ghost"
							onClick={() => setDialog({ mode: "closed" })}
						>
							Отмена
						</Button>
						<Button onClick={handleSubmit} disabled={isSaving}>
							{dialog.mode === "edit" ? "Сохранить" : "Создать"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
