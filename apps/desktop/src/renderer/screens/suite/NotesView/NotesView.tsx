import { splitHighlightedSnippet } from "@rox/shared/knowledge/notes-search";
import {
	extractTags,
	normalizeWikiLinkTarget,
	parseWikiLinks,
} from "@rox/shared/knowledge/wikilinks";
import { Button } from "@rox/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@rox/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuLabel,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@rox/ui/dropdown-menu";
import { Input } from "@rox/ui/input";
import { Label } from "@rox/ui/label";
import { Skeleton } from "@rox/ui/skeleton";
import { toast } from "@rox/ui/sonner";
import { Textarea } from "@rox/ui/textarea";
import { cn } from "@rox/ui/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
	BookText,
	ChevronDown,
	ChevronUp,
	FileText,
	FolderInput,
	GitBranch,
	Notebook,
	Plus,
	Search,
	Tags,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useDebouncedValue } from "renderer/hooks/useDebouncedValue";
import { useCloudTrpc as useTRPC } from "renderer/lib/api-trpc-react";
import { logger } from "renderer/lib/logger";
import { SuiteQueryError } from "../components/SuiteQueryError";
import { SuiteScreen } from "../components/SuiteScreen";
import { CollaborativeNoteEditor } from "./components/CollaborativeNoteEditor";

/**
 * Render a `ts_headline` snippet with matched terms emphasized, splitting on the
 * safe sentinels. Text is ESCAPED React children (never `dangerouslySetInnerHTML`)
 * because the snippet is raw note markdown.
 */
function SnippetText({ snippet }: { snippet: string }) {
	const segments = splitHighlightedSnippet(snippet);
	if (segments.length === 0) return null;
	return (
		<span className="line-clamp-2 cursor-text select-text text-muted-foreground text-xs">
			{segments.map((seg, i) => {
				// Stable key: snippet segments are deterministic per render, so position
				// + content uniquely identifies a run.
				const key = `${i}:${seg.text}`;
				return seg.highlight ? (
					<mark
						key={key}
						className="bg-transparent font-medium text-foreground"
					>
						{seg.text}
					</mark>
				) : (
					<span key={key}>{seg.text}</span>
				);
			})}
		</span>
	);
}

/**
 * Notes (Suite P2 surfaced in P0): a three-pane workspace — notebooks on the
 * left, the selected notebook's notes in the middle, and the selected note's
 * markdown body edited on the right in `CollaborativeNoteEditor` (single-player
 * Textarea + autosave by default; a real-time Yjs/Liveblocks co-editing peer when
 * the `collaboration.editor` experiment is open). Supports creating a notebook and
 * creating a note (title + markdown body). List queries exclude the (up to 500k)
 * markdown column; the full body is fetched per-note via `notebooks.getNote`.
 *
 * Cache-first (AGENTS.md rule 9): existing notebooks/notes render immediately.
 */
export function NotesView() {
	const trpc = useTRPC();
	const queryClient = useQueryClient();

	const [activeNotebookId, setActiveNotebookId] = useState<string | null>(null);
	const [activeNoteId, setActiveNoteId] = useState<string | null>(null);

	const [notebookDialogOpen, setNotebookDialogOpen] = useState(false);
	const [notebookName, setNotebookName] = useState("");

	const [noteDialogOpen, setNoteDialogOpen] = useState(false);
	const [noteTitle, setNoteTitle] = useState("");
	const [noteMarkdown, setNoteMarkdown] = useState("");

	const notebooksQuery = useQuery(
		trpc.notes.listNotebooks.queryOptions(undefined),
	);
	const notebooks = notebooksQuery.data ?? [];

	// Auto-select the first notebook once data arrives and nothing is selected.
	useEffect(() => {
		if (activeNotebookId === null && notebooks.length > 0) {
			setActiveNotebookId(notebooks[0]?.id ?? null);
		}
	}, [activeNotebookId, notebooks]);

	const notesQuery = useQuery({
		...trpc.notes.listNotes.queryOptions({
			notebookId: activeNotebookId ?? undefined,
		}),
		enabled: activeNotebookId !== null,
	});
	const notes = notesQuery.data ?? [];

	// Server full-text search (D7 FTS), scoped to the active notebook to match the
	// list. Debounced so each keystroke doesn't fire a round-trip; cache-first so
	// prior results stay visible while a new query loads.
	const [searchInput, setSearchInput] = useState("");
	const debouncedQuery = useDebouncedValue(searchInput.trim(), 280);
	const isSearching = debouncedQuery.length > 0;
	const searchQuery = useQuery({
		...trpc.notes.searchNotes.queryOptions({
			query: debouncedQuery,
			notebookId: activeNotebookId ?? undefined,
		}),
		enabled: isSearching && activeNotebookId !== null,
	});
	const searchResults = searchQuery.data ?? [];

	const noteQuery = useQuery({
		...trpc.notes.getNote.queryOptions({ noteId: activeNoteId ?? "" }),
		enabled: activeNoteId !== null,
	});
	const backlinkSearchTitle = noteQuery.data?.title.trim() ?? "";
	const backlinksQuery = useQuery({
		...trpc.notes.searchNotes.queryOptions({
			query: backlinkSearchTitle,
			notebookId: activeNotebookId ?? undefined,
			limit: 8,
		}),
		enabled:
			activeNoteId !== null &&
			activeNotebookId !== null &&
			backlinkSearchTitle.length > 0,
	});
	const likelyBacklinks = (backlinksQuery.data ?? []).filter(
		(note) => note.id !== activeNoteId,
	);

	// --- note body editor (single-player baseline + collaborative-when-gated) ---
	// The reader pane is an editable markdown editor whose body autosaves through
	// `notes.updateNote` on a short debounce — the single-player baseline. When the
	// `collaboration.editor` experiment is open it is ALSO a Yjs/Liveblocks CRDT
	// peer (see CollaborativeNoteEditor), so two people editing the same note (web
	// or desktop) converge in real time. Mirrors the web `NoteEditor` autosave.
	const AUTOSAVE_DELAY_MS = 800;
	const [editorMarkdown, setEditorMarkdown] = useState("");
	const hydratedNoteId = useRef<string | null>(null);
	const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingMarkdownRef = useRef<string | null>(null);

	const updateNote = useMutation(
		trpc.notes.updateNote.mutationOptions({
			onError: (error) => {
				logger.error("[NotesView] updateNote failed", error);
				toast.error("Не удалось сохранить заметку");
			},
		}),
	);

	// Hydrate the editor from the loaded note once per note id, so typing is never
	// clobbered by a background refetch of the same note (cache-first, AGENTS.md #9).
	useEffect(() => {
		if (noteQuery.data && hydratedNoteId.current !== noteQuery.data.id) {
			setEditorMarkdown(noteQuery.data.markdown ?? "");
			hydratedNoteId.current = noteQuery.data.id;
		}
	}, [noteQuery.data]);

	// Keep the freshest mutate fn / note id for the debounced + unmount flush
	// without re-arming the effect on every keystroke.
	const flushSaveRef = useRef<() => void>(() => {});
	flushSaveRef.current = () => {
		if (saveTimer.current) clearTimeout(saveTimer.current);
		const payload = pendingMarkdownRef.current;
		pendingMarkdownRef.current = null;
		if (payload !== null && activeNoteId) {
			updateNote.mutate({ noteId: activeNoteId, markdown: payload });
		}
	};

	// Flush any pending edit when the editor unmounts (view close / note switch),
	// so the debounce never drops the last change.
	useEffect(() => {
		return () => flushSaveRef.current();
	}, []);

	const handleEditorChange = (next: string) => {
		setEditorMarkdown(next);
		pendingMarkdownRef.current = next;
		if (saveTimer.current) clearTimeout(saveTimer.current);
		// Capture the note id at schedule time so a debounced save always targets the
		// note that was being edited, never whichever note is active when it fires.
		const targetNoteId = activeNoteId;
		saveTimer.current = setTimeout(() => {
			const payload = pendingMarkdownRef.current;
			pendingMarkdownRef.current = null;
			if (payload !== null && targetNoteId) {
				updateNote.mutate({ noteId: targetNoteId, markdown: payload });
			}
		}, AUTOSAVE_DELAY_MS);
	};

	const createNotebook = useMutation(
		trpc.notes.createNotebook.mutationOptions({
			onSuccess: async (row) => {
				await queryClient.invalidateQueries({
					queryKey: trpc.notes.listNotebooks.queryKey(undefined),
				});
				setNotebookDialogOpen(false);
				setNotebookName("");
				if (row) setActiveNotebookId(row.id);
			},
			onError: (error) => {
				logger.error("[NotesView] createNotebook failed", error);
				toast.error("Не удалось создать блокнот");
			},
		}),
	);

	const createNote = useMutation(
		trpc.notes.createNote.mutationOptions({
			onSuccess: async (row) => {
				if (activeNotebookId) {
					await queryClient.invalidateQueries({
						queryKey: trpc.notes.listNotes.queryKey({
							notebookId: activeNotebookId,
						}),
					});
				}
				setNoteDialogOpen(false);
				setNoteTitle("");
				setNoteMarkdown("");
				if (row) setActiveNoteId(row.id);
			},
			onError: (error) => {
				logger.error("[NotesView] createNote failed", error);
				toast.error("Не удалось создать заметку");
			},
		}),
	);

	// --- notebook membership (G): add / remove / reorder ---------------------
	// Edges (note_book_items) are keyed by the note's backing
	// knowledge_documents.id, so we pass `documentId = note.knowledgeDocumentId`.
	const invalidateNotesList = async () => {
		if (activeNotebookId) {
			await queryClient.invalidateQueries({
				queryKey: trpc.notes.listNotes.queryKey({
					notebookId: activeNotebookId,
				}),
			});
		}
		await queryClient.invalidateQueries({
			queryKey: trpc.notes.listNotebooks.queryKey(undefined),
		});
	};

	const addNoteToNotebook = useMutation(
		trpc.notes.addNoteToNotebook.mutationOptions({
			onSuccess: invalidateNotesList,
			onError: (error) => {
				logger.error("[NotesView] addNoteToNotebook failed", error);
				toast.error("Не удалось добавить заметку в блокнот");
			},
		}),
	);

	const removeNoteFromNotebook = useMutation(
		trpc.notes.removeNoteFromNotebook.mutationOptions({
			onSuccess: invalidateNotesList,
			onError: (error) => {
				logger.error("[NotesView] removeNoteFromNotebook failed", error);
				toast.error("Не удалось убрать заметку из блокнота");
			},
		}),
	);

	const reorderNotebookItems = useMutation(
		trpc.notes.reorderNotebookItems.mutationOptions({
			onSuccess: invalidateNotesList,
			onError: (error) => {
				logger.error("[NotesView] reorderNotebookItems failed", error);
				toast.error("Не удалось изменить порядок заметок");
			},
		}),
	);

	const handleMoveNote = (documentId: string, targetNoteBookId: string) => {
		if (!activeNotebookId) return;
		addNoteToNotebook.mutate({ noteBookId: targetNoteBookId, documentId });
		removeNoteFromNotebook.mutate({ noteBookId: activeNotebookId, documentId });
	};

	const handleRemoveNote = (documentId: string) => {
		if (!activeNotebookId) return;
		removeNoteFromNotebook.mutate({ noteBookId: activeNotebookId, documentId });
	};

	// Swap a row with its neighbour, then persist the FULL set of backing-doc ids
	// in the new order. Cache-first: optimistically apply before mutating.
	const handleReorderNote = (index: number, direction: -1 | 1) => {
		if (!activeNotebookId) return;
		const target = index + direction;
		if (target < 0 || target >= notes.length) return;
		const next = [...notes];
		const a = next[index];
		const b = next[target];
		if (!a || !b) return;
		next[index] = b;
		next[target] = a;

		const orderedDocumentIds = next
			.map((n) => n.knowledgeDocumentId)
			.filter((id): id is string => id != null);
		if (orderedDocumentIds.length !== next.length) return;

		queryClient.setQueryData(
			trpc.notes.listNotes.queryKey({ notebookId: activeNotebookId }),
			next,
		);
		reorderNotebookItems.mutate({
			noteBookId: activeNotebookId,
			orderedDocumentIds,
		});
	};

	const otherNotebooks = notebooks.filter((nb) => nb.id !== activeNotebookId);
	const notesBySlug = useMemo(() => {
		return new Map(
			notes.map((note) => [normalizeWikiLinkTarget(note.title), note]),
		);
	}, [notes]);
	const outgoingLinks = useMemo(
		() => parseWikiLinks(editorMarkdown),
		[editorMarkdown],
	);
	const noteTags = useMemo(() => {
		const storedTags = (noteQuery.data?.tags ?? []) as string[];
		return [...new Set([...storedTags, ...extractTags(editorMarkdown)])];
	}, [editorMarkdown, noteQuery.data?.tags]);

	return (
		<SuiteScreen
			title="Заметки"
			description="Блокноты и markdown-заметки"
			icon={BookText}
			actions={
				<Button onClick={() => setNotebookDialogOpen(true)}>
					<Plus className="size-4" /> Новый блокнот
				</Button>
			}
		>
			{notebooksQuery.isError && (
				<SuiteQueryError
					message={notebooksQuery.error.message}
					onRetry={() => notebooksQuery.refetch()}
				/>
			)}

			{notebooks.length === 0 && notebooksQuery.isLoading && (
				<div className="space-y-2">
					{[0, 1, 2].map((i) => (
						<Skeleton key={i} className="h-10 w-full" />
					))}
				</div>
			)}

			{notebooks.length === 0 && notebooksQuery.isSuccess && (
				<div className="flex flex-col items-center justify-center rounded-lg border border-border border-dashed py-20 text-center">
					<Notebook className="mb-3 size-8 text-muted-foreground" />
					<span className="text-foreground text-sm">Блокнотов пока нет</span>
					<span className="mt-1 max-w-sm text-muted-foreground text-xs">
						Создайте первый блокнот, чтобы начать вести заметки.
					</span>
				</div>
			)}

			{notebooks.length > 0 && (
				<div className="flex h-[calc(100vh-220px)] min-h-96 min-w-0 gap-4">
					<div className="w-[clamp(14rem,17vw,20rem)] min-w-52 max-w-[30vw] resize-x overflow-hidden rounded-lg border border-border bg-card/85">
						<div className="border-border border-b px-3 py-3">
							<p className="font-medium text-sm">Хранилище</p>
							<p className="mt-0.5 text-muted-foreground text-xs">
								{notebooks.length} блокнот(ов), {notes.length} заметка(и)
							</p>
						</div>
						<div className="max-h-full overflow-y-auto">
							{notebooks.map((notebook) => (
								<button
									key={notebook.id}
									type="button"
									onClick={() => {
										setActiveNotebookId(notebook.id);
										setActiveNoteId(null);
									}}
									className={cn(
										"flex w-full items-center gap-2 border-border border-b px-3 py-2.5 text-left text-sm last:border-b-0 transition-colors hover:bg-accent/40",
										notebook.id === activeNotebookId && "bg-accent",
									)}
								>
									<span className="shrink-0">{notebook.icon ?? "📓"}</span>
									<span className="truncate">{notebook.name}</span>
								</button>
							))}
						</div>
					</div>

					<div className="flex w-[clamp(18rem,22vw,24rem)] min-w-64 max-w-[34vw] resize-x flex-col overflow-hidden rounded-lg border border-border bg-card/80">
						<div className="flex items-center justify-between border-border border-b px-2 py-1.5">
							<span className="text-muted-foreground text-xs">Заметки</span>
							<Button
								size="icon"
								variant="ghost"
								aria-label="Новая заметка"
								disabled={!activeNotebookId}
								onClick={() => setNoteDialogOpen(true)}
								className="size-6"
							>
								<Plus className="size-3.5" />
							</Button>
						</div>
						<div className="border-border border-b p-1.5">
							<div className="relative">
								<Search className="-translate-y-1/2 absolute top-1/2 left-2 size-3.5 text-muted-foreground" />
								<Input
									value={searchInput}
									onChange={(e) => setSearchInput(e.target.value)}
									placeholder="Поиск по заметкам"
									aria-label="Поиск по заметкам"
									disabled={!activeNotebookId}
									className="h-7 pl-7 text-sm"
								/>
							</div>
						</div>
						<div className="flex-1 overflow-y-auto">
							{isSearching ? (
								// Server FTS results. Cache-first (AGENTS.md rule 9): keep prior
								// results while loading; never blank to a spinner.
								searchQuery.isError ? (
									<p className="cursor-text select-text px-3 py-3 text-destructive text-xs">
										{searchQuery.error.message}
									</p>
								) : !searchQuery.data && searchQuery.isLoading ? (
									<p className="px-3 py-4 text-center text-muted-foreground text-xs">
										Поиск…
									</p>
								) : searchResults.length === 0 ? (
									<p className="px-3 py-4 text-center text-muted-foreground text-xs">
										Ничего не найдено
									</p>
								) : (
									searchResults.map((note) => (
										<button
											key={note.id}
											type="button"
											onClick={() => setActiveNoteId(note.id)}
											className={cn(
												"flex w-full flex-col gap-0.5 border-border border-b px-3 py-2 text-left last:border-b-0 transition-colors hover:bg-accent/40",
												note.id === activeNoteId && "bg-accent",
											)}
										>
											<span className="flex items-center gap-2 truncate text-sm">
												<FileText className="size-3.5 shrink-0 text-muted-foreground" />
												<span className="truncate">{note.title}</span>
											</span>
											{note.snippet ? (
												<SnippetText snippet={note.snippet} />
											) : null}
										</button>
									))
								)
							) : (
								<>
									{notesQuery.isError && (
										<p className="cursor-text select-text px-3 py-3 text-destructive text-xs">
											{notesQuery.error.message}
										</p>
									)}
									{notes.length === 0 && notesQuery.isSuccess && (
										<p className="px-3 py-4 text-center text-muted-foreground text-xs">
											Нет заметок
										</p>
									)}
									{notes.map((note, index) => {
										const documentId = note.knowledgeDocumentId;
										const canManage = documentId != null;
										return (
											<div
												key={note.id}
												className={cn(
													"group relative flex items-center border-border border-b last:border-b-0 transition-colors hover:bg-accent/40",
													note.id === activeNoteId && "bg-accent",
												)}
											>
												<button
													type="button"
													onClick={() => setActiveNoteId(note.id)}
													className="flex min-w-0 flex-1 items-center gap-2 px-3 py-2 text-left text-sm"
												>
													<FileText className="size-3.5 shrink-0 text-muted-foreground" />
													<span className="truncate">{note.title}</span>
												</button>
												<div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity focus-within:opacity-100 group-hover:opacity-100">
													<Button
														type="button"
														variant="ghost"
														size="icon"
														className="size-6 text-muted-foreground disabled:opacity-30"
														aria-label="Выше"
														disabled={!canManage || index === 0}
														onClick={() => handleReorderNote(index, -1)}
													>
														<ChevronUp className="size-3.5" />
													</Button>
													<Button
														type="button"
														variant="ghost"
														size="icon"
														className="size-6 text-muted-foreground disabled:opacity-30"
														aria-label="Ниже"
														disabled={!canManage || index === notes.length - 1}
														onClick={() => handleReorderNote(index, 1)}
													>
														<ChevronDown className="size-3.5" />
													</Button>
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button
																type="button"
																variant="ghost"
																size="icon"
																className="size-6 text-muted-foreground disabled:opacity-30"
																aria-label="Переместить в блокнот"
																disabled={!canManage}
															>
																<FolderInput className="size-3.5" />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="end">
															<DropdownMenuLabel>
																Переместить в блокнот
															</DropdownMenuLabel>
															{otherNotebooks.length === 0 ? (
																<DropdownMenuItem disabled>
																	Других блокнотов нет
																</DropdownMenuItem>
															) : (
																otherNotebooks.map((nb) => (
																	<DropdownMenuItem
																		key={nb.id}
																		onSelect={() =>
																			documentId &&
																			handleMoveNote(documentId, nb.id)
																		}
																	>
																		<span className="truncate">
																			{nb.icon ? `${nb.icon} ` : ""}
																			{nb.name}
																		</span>
																	</DropdownMenuItem>
																))
															)}
															<DropdownMenuSeparator />
															<DropdownMenuItem
																variant="destructive"
																onSelect={() =>
																	documentId && handleRemoveNote(documentId)
																}
															>
																Убрать из этого блокнота
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												</div>
											</div>
										);
									})}
								</>
							)}
						</div>
					</div>

					<div className="min-w-0 flex-1 overflow-hidden rounded-lg border border-border bg-card/85">
						{activeNoteId === null ? (
							<div className="flex h-full flex-col items-center justify-center text-center">
								<FileText className="mb-3 size-8 text-muted-foreground" />
								<span className="text-muted-foreground text-sm">
									Выберите заметку
								</span>
							</div>
						) : noteQuery.isError ? (
							<p className="cursor-text select-text p-4 text-destructive text-sm">
								{noteQuery.error.message}
							</p>
						) : noteQuery.data ? (
							<div className="flex h-full flex-col">
								<div className="flex items-center justify-between border-border border-b px-4 py-3">
									<h2 className="cursor-text select-text font-semibold text-lg">
										{noteQuery.data.title}
									</h2>
									{updateNote.isPending ? (
										<span className="text-muted-foreground text-xs">
											Сохранение…
										</span>
									) : null}
								</div>
								<div className="grid min-h-0 flex-1 grid-cols-[minmax(0,1fr)_minmax(15rem,22rem)] gap-3 p-3 max-xl:grid-cols-1">
									<div className="flex min-h-0 flex-col">
										<CollaborativeNoteEditor
											key={noteQuery.data.id}
											noteId={noteQuery.data.id}
											value={editorMarkdown}
											onChange={handleEditorChange}
										/>
									</div>
									<aside className="flex min-h-0 flex-col gap-3 overflow-y-auto rounded-md border border-border bg-background/70 p-3">
										<section>
											<div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs uppercase">
												<Tags className="size-3.5" />
												Теги
											</div>
											{noteTags.length === 0 ? (
												<p className="text-muted-foreground text-xs">
													Добавьте #tag в текст заметки.
												</p>
											) : (
												<div className="flex flex-wrap gap-1.5">
													{noteTags.map((tag) => (
														<span
															key={tag}
															className="rounded border border-border bg-muted/60 px-2 py-0.5 text-xs"
														>
															#{tag}
														</span>
													))}
												</div>
											)}
										</section>

										<section>
											<div className="mb-2 flex items-center gap-2 text-muted-foreground text-xs uppercase">
												<GitBranch className="size-3.5" />
												Связи
											</div>
											{outgoingLinks.length === 0 ? (
												<p className="text-muted-foreground text-xs">
													Свяжите заметки через [[название]].
												</p>
											) : (
												<div className="space-y-1.5">
													{outgoingLinks.map((link) => {
														const linkedNote = notesBySlug.get(link.target);
														return (
															<button
																key={`${link.raw}:${link.target}`}
																type="button"
																disabled={!linkedNote}
																onClick={() => {
																	if (linkedNote)
																		setActiveNoteId(linkedNote.id);
																}}
																className="flex w-full items-center justify-between gap-2 rounded border border-border bg-muted/50 px-2 py-1.5 text-left text-xs transition-colors enabled:hover:bg-accent disabled:cursor-default"
															>
																<span className="truncate">
																	{link.alias ?? link.target}
																</span>
																<span className="shrink-0 text-muted-foreground">
																	{linkedNote ? "открыть" : "нет заметки"}
																</span>
															</button>
														);
													})}
												</div>
											)}
										</section>

										<section>
											<div className="mb-2 text-muted-foreground text-xs uppercase">
												Вероятные обратные ссылки
											</div>
											{backlinksQuery.isFetching &&
											likelyBacklinks.length === 0 ? (
												<p className="text-muted-foreground text-xs">Поиск…</p>
											) : likelyBacklinks.length === 0 ? (
												<p className="text-muted-foreground text-xs">
													Пока нет заметок, которые явно ссылаются на текущую.
												</p>
											) : (
												<div className="space-y-1.5">
													{likelyBacklinks.map((note) => (
														<button
															key={note.id}
															type="button"
															onClick={() => setActiveNoteId(note.id)}
															className="w-full rounded border border-border bg-muted/50 px-2 py-1.5 text-left text-xs transition-colors hover:bg-accent"
														>
															<span className="line-clamp-1">{note.title}</span>
														</button>
													))}
												</div>
											)}
										</section>
									</aside>
								</div>
							</div>
						) : (
							<div className="space-y-3 p-4">
								<Skeleton className="h-6 w-1/2" />
								<Skeleton className="h-4 w-full" />
								<Skeleton className="h-4 w-3/4" />
							</div>
						)}
					</div>
				</div>
			)}

			{/* Create notebook dialog */}
			<Dialog open={notebookDialogOpen} onOpenChange={setNotebookDialogOpen}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Новый блокнот</DialogTitle>
						<DialogDescription>
							Блокноты группируют ваши заметки.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="notebook-name">Название</Label>
						<Input
							id="notebook-name"
							value={notebookName}
							onChange={(e) => setNotebookName(e.target.value)}
							placeholder="Например: Идеи"
						/>
					</div>
					<DialogFooter>
						<Button
							disabled={!notebookName.trim() || createNotebook.isPending}
							onClick={() =>
								createNotebook.mutate({ name: notebookName.trim() })
							}
						>
							Создать
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>

			{/* Create note dialog */}
			<Dialog open={noteDialogOpen} onOpenChange={setNoteDialogOpen}>
				<DialogContent className="max-h-[min(720px,calc(100dvh-2rem))] overflow-y-auto">
					<DialogHeader>
						<DialogTitle>Новая заметка</DialogTitle>
						<DialogDescription>
							Markdown поддерживается в теле заметки.
						</DialogDescription>
					</DialogHeader>
					<div className="flex flex-col gap-3">
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="note-title">Заголовок</Label>
							<Input
								id="note-title"
								value={noteTitle}
								onChange={(e) => setNoteTitle(e.target.value)}
								placeholder="Заголовок заметки"
							/>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="note-markdown">Текст (markdown)</Label>
							<Textarea
								id="note-markdown"
								value={noteMarkdown}
								onChange={(e) => setNoteMarkdown(e.target.value)}
								placeholder="# Заголовок&#10;&#10;Текст…"
								rows={10}
								className="font-mono text-sm"
							/>
						</div>
					</div>
					<DialogFooter>
						<Button
							disabled={
								!activeNotebookId || !noteTitle.trim() || createNote.isPending
							}
							onClick={() => {
								if (!activeNotebookId) return;
								createNote.mutate({
									notebookId: activeNotebookId,
									title: noteTitle.trim(),
									markdown: noteMarkdown,
								});
							}}
						>
							Создать
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</SuiteScreen>
	);
}
