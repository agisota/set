# ROX: ТЗ по ремонту продуктового UX, 2026-06-25

## Current state / Текущее состояние

В ROX уже есть поверхности аккаунта, голоса, почты, заметок, календаря,
диска, памяти, журнала, канваса, пайплайнов, экспериментов и управления.
Но текущий desktop UX показывает незавершенные состояния прямо пользователю:
часть обещанных действий не видна, часть элементов сжата, часть статусов
выглядит как внутренние технические флаги. Основание: скриншоты от 2026-06-25
и текущий checkout `/Users/marklindgreen/Projects/RRR/rox`.

- В аккаунте сейчас может появиться текст `Привяжите аккаунты, чтобы выбрать имя пользователя: Telegram` из `IdentitySettings.tsx`, но на странице нет видимой кнопки подключения Telegram. Поэтому Telegram выглядит обязательным, хотя пользователь не получает действия для разблокировки.
- В блоке `Баланс и сессии` сейчас возможна сырая точность вроде `500.000000`; в `AccountUsagePanel.tsx` уже есть форматтеры, но `Баланс Rox` может вывести исходную строку баланса, а USD форматируется до четырех знаков.
- Фильтры usage-панели сейчас построены responsive-grid'ом; в видимом desktop layout они оказываются друг под другом, хотя на такой ширине должны быть в одной строке.
- Настройки голоса обещают кнопку микрофона в поле ввода, но mic сейчас подключен только через ветку `ChatInputFooter` / `ChatComposerControls` и скрывается, если `settings.getDictationEnabled` выключен. Также он становится недоступен, если `voice.isConfigured` возвращает false. Из-за этого другие prompt inputs могут не показывать микрофон при том, что настройки обещают его наличие.
- Почта, заметки, календарь, диск, память, журнал и рефлексия сейчас зажаты в узкие панели, пока справа остается большое пустое пространство. Колонки не выглядят явно resizable, поэтому пользователь не видит активный аккаунт, полный email, папки и содержимое.
- Для Drive уже есть planned storage/share surface в `plans/rox-comms-suite/MASTER-PLAN.md`, но desktop UI пока не доказывает, что загруженными файлами/папками можно делиться, а `Навести порядок` не выглядит работающей командой.
- Заметки и канвас существуют, но ожидаемая модель ближе к Obsidian: full-width workspace, дерево файлов, backlinks, graph/canvas, editor/preview и предсказуемые drag/resize interaction.
- В экспериментах сейчас видны английские labels: `Needs config`, `Available`, `Stubbed`, категории вроде `Templates`, а также технические feature names из `ExperimentalFeatureCatalog.tsx` и `packages/shared/src/experimental-features/index.ts`.
- `NeedConfig` / `Needs config` сейчас выглядит как внутренний статус, а не пользовательская диагностика. Пользователь не понимает, какой provider/runtime надо настроить и что именно делать дальше.
- В настройках внешнего вида есть editor и terminal font controls, но нет отдельного UI font control для app chrome.
- Фон пайплайнов и management-поверхности слишком точечные и визуально шумные. Goals/tasks/missions видны как пустые статические placeholders, а не как runnable controls.
- Старт чата может падать с `omp exited (code=1, signal=null)` / OMP failed, без понятного recovery path в UI.
- Для branch/worktree tags и colors ранее предполагалось заимствование из Hermes, но текущий branch control не показывает tagged/colored branches сверху.

## Visual QA pass / Проверка packaged app через Computer Use

Источник проверки: `/Applications/Rox.app`, bundle `com.rox.one`, PID `32080`,
packaged renderer `file:///Applications/Rox.app/Contents/Resources/app.asar/dist/renderer/index.html`.
Проверка выполнена через Computer Use / Peekaboo без мутаций данных: опасные
или изменяющие действия вроде `Создать ссылку`, `Добавить себе`, создания
папок, заметок, задач и запуска пайплайнов не нажимались.

### Cross-surface findings

- Общая glass/wallpaper тема сама является дефектом читаемости: многие рабочие поверхности лежат прямо на ярком mountain wallpaper, поэтому таблицы, списки, empty states и secondary text визуально выцветают.
- Несколько рабочих экранов используют только левую треть viewport, а справа остается большая декоративная пустота: это подтверждено для `Inbox`, `Mail`, `Drive`, `Notes`, `Calendar`, `Memory`, `Journal`, `Reflection`, `Saved Prompts`, `Skills Library` и списка `Pipelines`.
- В app chrome и настройках остались English fallbacks: `New Workspace`, `Create a new workspace`, `Production Canvas Workspace`, `Text card`, `Search experiments...`, `Reset all`, `Needs config`, `Available`, `Stubbed`, `Configure`, `Open`, wallpaper names и terminal sample text.
- Settings pages визуально стабильнее остальных, но account/settings content слишком узкий и centered: проблема layout не решена, она просто менее заметна на черном фоне.
- Branch/workspace rail показывает много строк вида `main +18035 -0`, но tagged/colored/pinned priority visually не подтверждена.
- Кнопки и статусы часто видны через accessibility tree, но не читаются глазами из-за low contrast, transparency и small text. Acceptance must be visual, not only AX-present.

### Screen findings

- `#/v2-workspaces`: workspace table and rows are washed out on wallpaper; global English `New Workspace` / `Create a new workspace` remains visible.
- `#/canvas`: canvas uses full width better than most screens, but contains English demo copy, no Obsidian-like vault tree/backlinks, and no clear note/canvas relationship model.
- `#/journal` and `#/journal?tab=reflection`: content is a small top-left island; feed/reflection empty states do not use workspace width.
- `#/memory`: memory import/examples exist, but the panel is transparent over wallpaper and visually weak; add/import actions were not mutationally tested.
- `#/inbox`: three-column shell exists, but it is squeezed left and the right side is decorative wallpaper.
- `#/drive`: folder `1` and storage state are visible; folder menu exposes `Переименовать`, `Поделиться`, `Копировать ссылку`, `Удалить`; share modal opens with password field and `Создать ссылку`, but actual link creation was not clicked. `Навести порядок` was not found as a visible drive command.
- `#/calendar`: controls show `Июнь 2026` and view modes, but the month surface is visually empty/fragmented; `Экспорт в .ics`, `Импорт из .ics`, and `Событие` are disabled.
- `#/notes`: only notebook shell and `Новый блокнот` are visible; there is no serious note list/editor/backlinks/canvas behavior comparable to Obsidian.
- `#/email`: account `anti@mail.com` / `agisota` is present in AX, but visually tiny and cramped; message list and preview are squeezed left, with wallpaper taking the remaining width.
- `#/pipelines`: pipeline cards sit in the top-left area and do not use the workspace width.
- `#/pipelines/<id>`: editor confirms noisy dot-grid background; `Запустить пайплайн` is disabled with `7 проблем(ы)`, but the run blocker needs clearer diagnostics and a calmer canvas.
- `#/tasks`: table uses more width than comms surfaces, but rows are low-contrast and extremely dense; many titles are bilingual duplicated Russian/English, increasing scan cost.
- `#/automations`: template grid exists, but still sits on glass/wallpaper with weak contrast and emoji-heavy cards; create/run proof still needs validation.
- `#/skills-library`: installed count shows `0`, catalog count `21`; narrow list/detail layout and skeleton-like blocks make the surface feel unfinished.
- `#/saved-prompts`: folder/list area and prompt card exist, but the layout is left-biased and much of the viewport remains wallpaper.
- `#/settings/account`: confirms `500.000000`, Telegram dead-end, usage filters wrapping, and narrow centered settings layout.
- `#/settings/experimental`: confirms full-page i18n debt and internal status leakage: `Agent-Native Team OS controls`, `Needs config`, `Stubbed`, `Available`, English category names and descriptions.
- `#/settings/voice`: `Голосовой ввод` switch is on and `Фоновый агент` is off, but the page does not explain why mic is still missing from observed prompt inputs. It needs runtime/config/permission coverage.
- `#/settings/appearance`: has editor and terminal font controls, but no UI font control. Glass is on, opacity is `46%`, wallpaper is on, and this appears to be the root cause for many readability failures.

## Target state / Целевое состояние

ROX должен ощущаться как единое рабочее место оператора, а не набор узких
недоделанных панелей. Каждое обещание в настройках должно соответствовать
видимому контролу, каждая недоступная функция должна объяснять причину, а каждая
широкая desktop-поверхность должна осмысленно использовать доступный viewport.

- Аккаунт не упоминает Telegram как требование, если рядом нет видимого working action для подключения Telegram. Внешние провайдеры остаются опциональными источниками identity, а не необъясненными blockers для ROX handle.
- Все Rox и USD значения в account settings отображаются максимум с двумя знаками после запятой. Tokens и requests остаются integer formatted.
- Usage filters на desktop держатся в одной горизонтальной строке и переносятся только на реально узких widths.
- Voice settings и все prompt inputs согласованы: если dictation включен и сконфигурирован, mic button виден; если он выключен или не сконфигурирован, пользователь видит disabled mic или ясный status с точной причиной.
- Почта, заметки, календарь, диск, память, журнал и рефлексия используют full-width adaptive shells с resizable panes, visible account identity, readable lists и честными empty states.
- Drive позволяет делиться загруженными файлами/папками и доказывает, что `Навести порядок` выполняет реальное organize action или показывает честное unavailable-state explanation.
- Notes и canvas получают Obsidian-like workspace behavior: file tree, editor/preview, backlinks, canvas/graph affordances, drag/resize, command-driven actions и persistent layout.
- Experiments полностью локализованы на русский. `NeedConfig` становится `Требуется настройка` с коротким человеческим объяснением и именами missing dependencies/config keys, но без secret values.
- Appearance settings разделяют UI font, editor font и terminal font. UI font меняет app chrome live и не ломает terminal/editor rendering.
- Tagged/colored branches pinned или sorted выше untagged branches, с Hermes behavior как reference implementation.
- Goals, tasks и missions запускаются из management panel. Panel чуть темнее и визуально спокойнее фона.
- Pipeline backgrounds спокойнее: меньше dot density/opacity, лучше contrast, нет визуального shimmer.
- Старт чата либо успешно запускается, либо падает с actionable OMP diagnosis, retry/reconnect path и ссылкой на log reference.
- Wallpaper/glass может быть включен, но рабочие surfaces сохраняют читаемость: operator content получает достаточный opaque scrim, контраст, и no-wallpaper fallback for dense tools.
- Все workspace surfaces используют понятную desktop geometry: либо full-width shell, либо intentionally constrained modal/card. Случайных left-island layouts быть не должно.
- Visual QA acceptance выполняется глазами и скриншотами: недостаточно, чтобы элемент существовал в accessibility tree.

## Gap / transformation / Переход

Нужен продуктовый UX repair pass в трех слоях:

- Copy/state truth: replace internal or misleading copy with Russian user-facing state, especially identity, experiments, voice, and OMP errors.
- Layout truth: replace narrow fixed panes with full-width responsive shells and resizable work areas for comms, notes, drive, memory, journal, canvas, and management.
- Capability truth: wire or honestly disable promised actions such as mic input, drive sharing, organize, runnable goals/tasks/missions, and tagged branch priority.
- Theme truth: keep personality in the wallpaper/glass system, but prevent it from becoming the foreground of dense operational tools.

## Tasks as state transitions / Задачи как переходы состояния

1. Given that we are now in current state where Account identity mentions Telegram without an obvious Telegram connect path, and target state is Account identity has no dead-end provider requirement, do a copy and action audit in `IdentitySettings.tsx` and linked auth/provider settings so that the page either shows a working provider connect CTA or says that the ROX handle can be claimed after any supported verified account.

2. Given that we are now in current state where Account usage can show raw precision and wrapped filters, and target state is two-decimal money plus one-row desktop filters, do formatting and layout fixes in `AccountUsagePanel.tsx` so that `Баланс Rox`, `Потрачено Rox`, and `Расходы USD` render with two decimals and filters stay in one row at desktop widths.

3. Given that we are now in current state where Voice settings promise a mic but some prompt inputs show none, and target state is every prompt input has a truthful dictation affordance, do a voice affordance audit across `ChatInputFooter`, `ChatComposerControls`, `WorkspaceChatInterface`, and settings copy so that the mic is visible when usable and visibly diagnosed when hidden, disabled, or unconfigured.

4. Given that we are now in current state where dictation depends on `settings.getDictationEnabled` and `voice.isConfigured` but the user sees no reason, and target state is explainable voice state, do a status model update in voice settings and composer tooltips so that the UI distinguishes `Выключено`, `Нет доступа к микрофону`, and `Требуется настройка распознавания`.

5. Given that we are now in current state where Mail is squeezed and does not clearly show which account/mailbox is active, and target state is a full-width mail workspace, do a layout repair in `EmailView` and the suite shell so that account identity, full email address, folders, message list, and preview have readable widths and resizable columns.

6. Given that we are now in current state where Notes do not behave like a serious knowledge workspace, and target state is Obsidian-like notes, do a notes UX pass in `NotesView` and knowledge document surfaces so that users can create, find, edit, preview, link, and navigate notes in a full-width, persistent layout.

7. Given that we are now in current state where Calendar is constrained by the same narrow shell, and target state is a readable scheduling surface, do a calendar layout pass in `CalendarView` and the suite shell so that month/week/day areas use the available viewport and side panels are resizable or collapsible.

8. Given that we are now in current state where Drive does not prove sharing or organize behavior, and target state is usable file/folder operations, do a drive capability pass in `DriveView`, drive routers, and share-link surfaces so that uploaded files/folders can be shared and `Навести порядок` performs a real organize action with visible progress and result.

9. Given that we are now in current state where Memory, Journal, feed, and reflection appear empty or nonfunctional, and target state is a full-width working recall/reflection workspace, do a state and data-flow audit across those screens so that loading, empty, error, and populated states are distinct and the primary actions actually execute.

10. Given that we are now in current state where Canvas lacks Obsidian-level interaction expectations, and target state is a usable visual thinking workspace, do a canvas UX pass using Obsidian Canvas as the reference so that nodes, links, selection, pan/zoom, drag/drop, import/export, and persistence feel predictable.

11. Given that we are now in current state where Experiments exposes English and internal statuses, and target state is fully Russian user-facing settings, do localization in `ExperimentalFeatureCatalog.tsx` and `packages/shared/src/experimental-features/index.ts` so that categories, labels, descriptions, maturity, availability, reset actions, and dependency hints are Russian.

12. Given that we are now in current state where `Needs config` / `NeedConfig` gives no useful diagnosis, and target state is understandable configuration status, do a dependency explanation pass so that each blocked experiment shows `Требуется настройка`, the missing dependency name, a safe hint, and a link to the relevant settings or docs without printing secrets.

13. Given that we are now in current state where Appearance settings separate editor and terminal fonts but not UI font, and target state is independent UI/editor/terminal font control, do a settings model and renderer CSS variable pass so that app chrome, editor content, and terminal each have live, independent font family and size controls.

14. Given that we are now in current state where tagged/colored branches are not prioritized, and target state is Hermes-style branch priority, do a branch/worktree discovery pass against the Hermes implementation and port the sorting/tag rendering behavior so that colored or tagged branches appear above untagged branches in branch pickers and management views.

15. Given that we are now in current state where goals, tasks, and missions look like empty management placeholders, and target state is runnable dashboard control, do a management-panel wiring pass so that each row can be launched, shows status, and reports result/error from the underlying workflow runtime.

16. Given that we are now in current state where pipeline/background visuals are too noisy, and target state is a calmer operator surface, do a background token and component style pass so that dot density, opacity, contrast, and panel darkness reduce visual shimmer while keeping spatial orientation.

17. Given that we are now in current state where starting chat can fail with `omp exited (code=1, signal=null)`, and target state is actionable recovery, do an OMP startup diagnostic pass so that chat start validates OMP availability, captures stderr/log location, retries safe startup when possible, and shows one clear Russian recovery message when it cannot recover.

18. Given that we are now in current state where wallpaper/glass is applied behind dense work surfaces and makes them unreadable, and target state is readable operator content with personality preserved, do a global theme-shell pass over the app background, scrims, panel opacity, text contrast, and dense-surface overrides so that tables, lists, forms, and empty states remain readable with wallpaper/glass on.

19. Given that we are now in current state where multiple screens show English fallback copy in Russian UI, and target state is Russian-first product copy, do an i18n sweep for visible app chrome and settings strings found in the visual QA pass so that `New Workspace`, `Create a new workspace`, canvas demo text, experiment controls, wallpaper labels, and terminal samples are localized or replaced.

20. Given that we are now in current state where many workspace screens render as left-biased islands, and target state is deliberate full-width desktop geometry, do a shared workspace-shell audit for `Inbox`, `Mail`, `Drive`, `Notes`, `Calendar`, `Memory`, `Journal`, `Reflection`, `Saved Prompts`, `Skills Library`, `Automations`, and `Pipelines` so that each screen either uses resizable full-width panes or intentionally documented constrained layout.

21. Given that we are now in current state where Calendar controls exist but core calendar content and actions look disabled or fragmented, and target state is a usable scheduling workspace, do a calendar functional-state pass so that month/week/day/list views show real grids or clear empty states, and disabled import/export/event actions explain the missing requirement.

22. Given that we are now in current state where Tasks uses more width but is visually dense and bilingual duplicated, and target state is scannable task management, do a tasks table readability and title-language cleanup so that task rows have contrast, hierarchy, density controls, and one canonical display language per row.

23. Given that we are now in current state where Pipeline editor run is disabled with problem count but weak visual diagnostics, and target state is explainable pipeline execution readiness, do a pipeline diagnostics and canvas contrast pass so that each blocker is visible, actionable, and not hidden by noisy dot-grid styling.

## Verification proof / Доказательство готовности

Реализацию можно считать готовой только когда есть такое доказательство:

- Account screenshot: нет Telegram dead-end, деньги с двумя знаками, filters в одной desktop-строке.
- Voice screenshot matrix: dictation on/configured, on/unconfigured, off и mic-permission denied; у каждого состояния есть visible affordance или explanation.
- Screenshots почты, заметок, календаря, диска, памяти, журнала, рефлексии и канваса на wide desktop width: full-width usage, readable/resizable panes.
- Drive smoke: upload или existing file/folder может создать share action, а `Навести порядок` дает visible progress/result или truthful unavailable state.
- Notes/canvas smoke: создать note, связать note, открыть canvas, перетащить node, сохранить и переоткрыть layout.
- Experiments screenshot: все labels на русском; `Требуется настройка` объясняет missing dependency без secret values.
- Appearance smoke: UI font size/family меняет app chrome; terminal font меняет только terminal; editor font меняет только editor/markdown surface.
- Branch picker screenshot: tagged/colored branches sorted above untagged branches.
- Management panel smoke: goal, task и mission launch paths показывают running/success/error states.
- Chat startup smoke: OMP success path работает; forced OMP failure показывает actionable Russian diagnosis вместо raw `omp exited`.
- Code checks: targeted unit/component tests для formatting, experiment labels, voice state и branch sorting; затем доступный repo desktop lint/typecheck/build gate.
- Packaged visual QA matrix from `/Applications/Rox.app`: screenshots for `Workspaces`, `Canvas`, `Journal`, `Reflection`, `Memory`, `Inbox`, `Drive`, `Calendar`, `Notes`, `Mail`, `Pipelines`, `Tasks`, `Automations`, `Skills Library`, `Saved Prompts`, `Account`, `Voice`, `Appearance`, and `Experiments`.
- Theme proof: same dense screens captured with wallpaper/glass on and with fallback/no-wallpaper mode; content remains readable in both states.
- Drive share proof: safe test folder creates a share link and copy-link path, or the UI shows a truthful unavailable state with exact missing backend/config.
- Pipeline proof: disabled run state lists exact blockers; after blockers are fixed, run button becomes enabled and reports running/success/error.
- Calendar proof: enabled/disabled action states are explained, and at least one event creation/import/export path is smoke-tested or intentionally scoped out with visible copy.

## Remaining blockers / decisions / Оставшиеся решения

- Telegram не должен считаться required provider, пока product явно не shipped Telegram connect flow. Product default для этого ТЗ: Telegram optional и hidden unless actionable.
- `NeedConfig` означает, что feature blocked by missing provider/runtime configuration. UI должен показывать dependency names и safe hints, но никогда secret values.
- OMP failure handling может потребовать local runtime inspection; реализация не должна прятать failure за generic toast.
- Visual QA не нажимал mutating actions. Share-link creation, memory import/add, creating folders/notes/tasks/events, and pipeline execution still need safe test fixtures before implementation is claimed done.
- Это ТЗ не авторизует production deploys, credential changes, schema migrations или external publishing. Для этого нужен отдельный high-stakes execution plan.
