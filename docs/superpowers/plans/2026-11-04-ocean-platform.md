# Ocean Platform Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Поставить общий Ocean runtime/server, собственный локальный движок и
графический чат автономных ботов, затем графический клиент работы с проектом.

**Architecture:** Один владелец профиля обслуживает все четыре клиента.
Собственный движок Ocean вызывает облачные и локальные модели через ProviderPort и инструменты через
порты Ocean. Codex/Claude CLI не запускаются: OpenAI/Anthropic подключаются как
провайдеры моделей, а Ocean сам исполняет tool calls и управляет командой.
Один runtime обслуживает смешанную команду; у каждого бота собственное
сохранённое подключение и модель. Локальный сервер выполняет вычисления на CPU/GPU.

**Tech Stack:** TypeScript strict, Node, pnpm 12.16.1, SQLite, Unix socket,
существующий Desktop, прямой MCP SDK после квалификации публичного API.

**Spec:** [Принятая архитектура](../../ocean/platform-architecture.md),
[детали автономности/MCP](../specs/2026-11-04-ocean-autonomy-mcp-design.md).

## Global Constraints

- Linux x86_64/Omarchy — целевая платформа; на БигПК разработку не переносить.
- Domain чистый; application зависит только от domain; I/O за портами.
- TypeScript строгий; исходный файл не превышает 300 физических строк.
- Runtime — единственный владелец состояния, полномочий и исполнения.
- Модели через API, без Codex/Claude CLI и без второго агентного цикла.
- Облачные и локальные модели, включая смешанную команду, входят в приоритет 1.
- Нет глобального переключателя модели для всех ботов и скрытого cloud fallback.
- Bypass permissions действует внутри явно выданной доверенной области.
- Квитанция фиксируется до исполнения; неизвестный эффект не повторяется.
- Клиентский disconnect не является отменой; отмена не доказывает cleanup.
- Сохранять real profiles, credentials, Ocean 1.0/RC2 и чужие worktrees.
- Не расширять старые grants при миграции; модель не подтверждает себя.
- Root check/build/format и отдельные native/live gates обязательны.

## Review Focus

1. Ротация модели/ключа во время хода: старый ход сохраняет снимок подключения,
   следующий использует новую активацию; два провайдера не исполняют один ход.
   В смешанной команде ротация одного бота не переключает остальных (B/D).
2. Делегирование после отзыва прав: очередь не протаскивает старое разрешение
   и не подменяет отправителя; внутри текущей области нет лишних окон (C/D).
3. Потеря квитанции и рестарт на границе dispatch: один runId, не два эффекта;
   неясный исход остаётся неясным (A/D/F).
4. Одновременные задачи и ожидание коллеги: разные ресурсы работают параллельно,
   один worktree координируется, ожидание не занимает последний слот (D).
5. Старый клиент/профиль: неподдерживаемая capability даёт явный отказ,
   переподключение не теряет историю и не расширяет доступ (A/E/F).
   У локального подключения нет обязательного фиктивного ключа, а отсутствие
   сети/tools/vision/usage не маскируется облачным fallback или нулевым usage (B/F).

---

## Статус и способ исполнения

Это **обновлённая карта поставки и контракт первого этапа**, не выполненные задачи.
Пользователь утвердил архитектуру и разрешил реализацию по порядку, commit/push/merge.
Сначала исполняется A; B–F — отдельные подсистемы с собственными подробными
task-by-task планами перед изменением кода. G/H имеют более низкий приоритет.
Не превращать этот документ в разрешение одновременно переписать все слои.

Рабочая база — `/home/ryltsevmg/Projects/Ocean-stable`, ветка
`codex/ocean11-stable`, исходная ревизия `438338b`. В исходном каталоге Ocean
и design-worktree есть защищённые чужие изменения. Их не stash/reset/clean.
В stable сохранены незавершённые `github-session-rig.ts` и
`plugin-catalog-lifetime.test.ts`; они не приняты вместе с новым дизайном.

## A. Runtime/server и существующий локальный движок — приоритет 1

**Результат:** один продуктовый путь от комнаты до `runTurn`, проверенная жизнь
задачи без UI; собственный движок работает без установленных агентных CLI.
Не создавать `AgentEngine` для переключения внешних CLI, вторую БД или новый
сервер только ради структуры пакетов. Вынос пакета допускается позднее по
реальной зависимости; `apps/cli/src/local-runtime` уже может быть composition root.

**Files:**

- Preserve/inspect: `packages/application/src/turn.ts`, `round.ts`, `tool-round.ts`,
  `types.ts`, `provider.ts`, `chat-turn-execution.ts`, `direct-chat.ts`.
- Modify only for demonstrated gaps: `apps/cli/src/runtime.ts`,
  `apps/cli/src/local-runtime/host.ts`, `turns.ts`, `broadcast.ts`.
- Existing regression: `apps/cli/src/local-runtime/process.test.ts`,
  `lost-receipt-process.test.ts`, `restart-process.test.ts`,
  `apps/cli/src/engine/agent-loop.test.ts`.
- Create tests: `apps/cli/src/local-runtime/own-engine-process.test.ts`,
  `packages/application/src/own-engine.test.ts`.
- Register new process test: `vitest.process-cases.config.ts`.

**Interfaces:**

- Consumes: `ProviderPort.stream(request: ModelRequest): AsyncIterable<ProviderEvent>`.
- Preserves: `runTurn(input: TurnInput): Promise<TurnOutcome>` and
  `executeChatTurn(deps: ChatTurnExecutionDeps, input: ChatTurnExecutionInput): Promise<ChatTurn>`.
- Preserves: `startLocalRuntime(options: LocalRuntimeHostOptions): Promise<LocalRuntimeHost>`;
  `DirectChatService.submit` returns committed receipt and fresh completion only.
- Produces: подтверждённый общий execution path для следующих подсистем;
  серверный контракт `packages/contracts/src/local-runtime*.ts` не меняется без
  новой потребности/capability. ProviderPort остаётся границей одного model request.

### Task 1: A1. Сохранить базу и установить границы

- [ ] Проверить git status/HEAD и сохранить точный diff незавершённых собственных
      изменений отдельно от чужих. Не включать их в новый commit автоматически.
- [ ] В одноразовом HOME/XDG запустить `pnpm check`, `pnpm build`,
      `pnpm format:check`; записать каждый exit code и упавший тест.
      Известный предыдущий результат: три SDK catalog-lifetime регрессии и два
      неформатированных незавершённых файла; не называть это зелёной базой.
- [ ] Для каждого сбоя решить: исправление сохранённого поведения либо замена
      проверки при удалении старого backend в C. Нельзя просто отключить регрессию.
- [ ] Проверить `runTurn`/room/ACP call graph; зафиксировать место admission,
      claim, invocation и publication. Existing tests проходящие не переписывать.

### Task 2: A2. Проверить собственный движок

- [ ] В `own-engine.test.ts` добавить сценарий scripted ProviderPort:
      сначала tool call, затем финальный ответ. Проверить ровно 2 model requests,
      1 вызов tool, 1 TaskRun attempt, `outcome.kind === 'completed'`, передачу
      результата tool во второй запрос и запись claim раньше вызова инструмента.
- [ ] Добавить неизвестный исход tool: `outcome.kind === 'uncertain'`,
      вызов tool ровно 1, следующего model request нет. Проверить отказ прав до I/O.
- [ ] Запустить `pnpm test packages/application/src/own-engine.test.ts`.
      Для найденного дефекта сначала получить FAIL по конкретному утверждению;
      уже проходящий characterization test не требует искусственного RED.
- [ ] Исправить только доказанные нарушения в перечисленных application файлах.
      Использовать существующие lifecycle/service, не второй журнал/цикл.
- [ ] Повторить focused test: PASS; затем root gates. Сохранить отдельный commit
      с явным списком собственных файлов: `test: pin local engine ownership` либо
      `fix: preserve local engine execution ownership`, если исправление понадобилось.

### Task 3: A3. Проверить независимость от клиентов

- [ ] В `own-engine-process.test.ts` поднять runtime с детерминированным
      провайдером на приватном профиле; в PATH нет Codex/Claude. Отправить запрос,
      закрыть первый клиент во время генерации, вторым получить тот же runId,
      ровно 1 итоговое сообщение и счётчик вызова провайдера 1.
- [ ] Оборвать ответ после commit admission, повторить тот же requestId:
      исходный runId, счётчик 1. Изменённые данные с тем же ID дают конфликт.
- [ ] В отдельном сценарии после durable effect claim аварийно завершить
      runtime: после рестарта исход unknown, эффект не повторён, cancellation
      не подтверждена. Переиспользовать существующие crash fixtures.
- [ ] Добавить сценарий старого клиента без новой capability: прежний чат
      доступен, неизвестная операция отклоняется, права не меняются.
- [ ] Зарегистрировать файл в processCases. Запускать
      `pnpm test:process apps/cli/src/local-runtime/own-engine-process.test.ts`;
      ожидается PASS всех сценариев, без живых credentials и без внешнего CLI.
- [ ] Исправить только выявленные дефекты host composition; root gates и
      scoped review. Commit: `test: qualify shared runtime with the local engine`.

## Task 4: B. Облачные и локальные модели — приоритет 1

**Сохраняем:** ProviderPort, DeepSeek, provider activation, secret store,
изображения с проверкой байтов и интерфейс настроек провайдера.

**Files:** существующие `packages/application/src/provider*.ts`,
`packages/provider-core`, `packages/provider-deepseek`,
`apps/cli/src/local-runtime/provider-settings.ts`; новые
`packages/provider-openai/src/{provider,wire,stream,index}.ts` и
`packages/provider-anthropic/src/{provider,wire,stream,index}.ts` с тестами.
Для локального сервера — `packages/provider-local/src/{provider,wire,stream,index}.ts`
и тесты. Общие protocol helpers переиспользуются через `provider-core`, когда
wire-контракт действительно совпадает; не копировать HTTP/SSE код по поставщикам.
Привязка бота к подключению затрагивает `packages/domain/src`, store migrations
и bot settings; их точные DTO/таблицы фиксируются в подробном плане B до кода.
Package manifests/tsconfig/export/packaging входят в ту же поставку адаптера.

**Interfaces:** каждый адаптер реализует существующий `ProviderPort`; auth
разрешается runtime, не моделью/клиентом. Не маскировать Anthropic под wire-format
DeepSeek. В подробном плане B закрепить API/версии после чтения официальных docs.

Дополнительный контракт B: сохраняемая привязка бота
`BotModelBinding { readonly connectionId: string; readonly modelId: string }`;
activation каждого хода фиксирует эту привязку и ревизию подключения.
Подключение различает `cloud`/`local`, endpoint и режим auth. Локальное auth-none
разрешается явной настройкой подключения, а не отсутствием обязательного ключа
у облачного провайдера. При миграции старое выбранное подключение привязывается
к прежним ботам без изменения их модели или неявного создания доступа к новым.

- [ ] Обобщить настройки provider/model и проверку подключения без чтения ключа в UI.
- [ ] Добавить независимую привязку модели каждому боту: облачный A и локальный B
      одновременно в одной комнате. Повтор запуска/рестарт сохраняет обе привязки.
- [ ] Выбрать и закрепить поддерживаемые локальный сервер и model artifact;
      до включения в поставку проверить tools/streaming/usage на целевом ноутбуке.
      Первый сценарий — подключение к установленному серверу с доступными весами,
      без обязательной загрузки, установки или обновления backend самим Ocean.
- [ ] Реализовать local adapter через ProviderPort, явный endpoint и optional auth;
      отказ соединения/неизвестная модель не запускают другую модель или сервер.
- [ ] Добавить адаптеры: streaming, tools, usage, errors, cancellation,
      ограничение request bytes и подтверждённые modalities каждого model ID.
- [ ] Локальный сервер без usage: сохранить метрику как недоступную, не 0;
      применить лимиты времени/числа запросов. До реализации уточнить `ProviderEvent`,
      lifecycle и budget contract: сейчас движок требует usage. Не притворяться,
      что совместимости wire-format достаточно. Оценку отличать от фактических токенов.
- [ ] Fixtures: частичный SSE, malformed tool arguments, недостающий terminal,
      401/429/timeout и неподдерживаемое изображение; ни одного самовольного retry эффекта.
- [ ] Local fixtures: endpoint недоступен, модель не загружена, нет tools/vision,
      разрыв stream и повтор requestId. Unsupported отклоняется явно;
      неизвестное исполнение не повторяется, облачный вызов отсутствует.
- [ ] Ротация ключа/модели во время работы: текущий activation неизменен,
      следующий ход использует новый; никакого fallback на другую модель после unknown.
- [ ] Offline gate: с заранее доступными весами и отключённым внешним доступом
      локальный бот отвечает и выполняет локальный tool; счётчик облачных вызовов 0.
      Настроенное local auth-none работает без облачных credentials.
- [ ] Source/межпроцессные проверки и живые API проверки на явно предоставленных
      подключениях. Отсутствие ключа отдельного поставщика фиксируется как незакрытый gate.

## Task 5: C. Постоянные права и готовые MCP-инструменты — приоритет 1

**Files:** `packages/application/src/{coding-dispatch,plugin-admission,plugin-session-authority,plugin-turn-tools,tools}.ts`,
`packages/domain/src/{plugin-catalog,plugin-grant}.ts`,
`packages/store-sqlite/src/tool-journal.ts`, новый `packages/integrations-mcp`,
`apps/cli/src/plugin-transport.ts`, release packaging и Desktop plugin settings.

**Interfaces:** сохранить `ServicePluginTransportPort` или согласованно заменить
его SDK-specific части; application не импортирует SDK. Разрешение владельца,
каталог инструментов и транспортная сессия — независимые сущности.

- [ ] Сначала квалификационный прототип public MCP SDK: HTTP/stdio,
      dropped response, refresh каталога и отсутствие скрытого повторного эффекта.
- [ ] Постоянная доверенная область разрешает работу без каждого approval;
      внешняя операция всё равно проходит актуальный допуск и durable claim.
- [ ] Проверки restart/revoke/delayed dispatch; новые tools не получают
      неоговорённый доступ, смена endpoint/account не маскируется под token rotation.
- [ ] Готовый сервер подключается конфигурацией; нет собственного плагина на
      каждый сервис. Реальный GitHub read + stdio server + synthetic write failure.
- [ ] Мигрировать GitHub pilot без расширения прав; удалить Executor SDK/patch
      только после проверки замены и упаковки. Перенести смысл незавершённых
      catalog-lifetime регрессий, не объявлять старый фикс принятым.

## Task 6: D. Автономные задачи и общение ботов — приоритет 1

**Files:** `packages/application/src/{direct-chat-admission,chat-turn-execution,room-broadcast}.ts`,
`packages/domain/src` для поручений/доставок, `packages/store-sqlite/src`
для inbox/outbox/migration, `apps/cli/src/local-runtime` для scheduling.

**Interfaces:** TaskRun — попытка исполнения; CodingTask — coding-процесс;
сохраняемая задача связывает несколько ходов и дочерние поручения. Подробный
план D задаёт минимальный тип задачи, delivery identity и cursor до миграции.
Новая сущность Team не нужна: первая команда — состав существующей комнаты.

- [ ] Добавить адресованные сообщения/поручения с runtime-authored sender,
      idempotency key, parent/root links и квитанцией до пробуждения.
- [ ] A поручает B, B отвечает, A продолжает без человека; ответ приходит в
      правильную задачу/комнату. Ожидание освобождает слот, технические receipts не будят.
- [ ] Повторить для облачного A и локального B: оба используют свои подключения,
      одна доставка поручения/ответа, единая история задачи; restart/повтор квитанции
      не создают дублей и не меняют provider binding. Недоступный B не переключается
      на облако; несвязанная задача A может продолжать работу.
      Недоступность облачного API также не блокирует независимую локальную задачу.
- [ ] Проверить, что область с запретом облачной передачи не позволяет
      делегировать данные облачному боту; смешанная комната явно показывает облачных участников.
- [ ] Общее поручение нескольким ботам допускает последующие переговоры;
      старую конечную broadcast-команду не переопределять молча для старых клиентов.
- [ ] Дубликат, forged sender, чужая комната, отозванный grant и расширение
      через делегирование отклоняются; сохранённая разрешённая очередь переживает restart.
- [ ] Проверить общий бюджет/цикл/stop; параллельные разные ресурсы не блокируются,
      один worktree координируется. Legacy unknown без scope не разблокировать автоматически.

## Task 7: E. Графический чат ботов — приоритет 1

**Files:** текущий `apps/desktop/src/ui` и протокольные адаптеры Desktop;
общие DTO `packages/contracts/src/local-runtime*.ts` и серверные handlers.
UI-дизайн согласовывается отдельным подробным планом E; чужой design-worktree не менять.

**Interfaces:** исключительно Ocean Server: комнаты/история, submit/receipt/run,
наблюдение, очередь/делегирование, решения, grants и provider connections.
В клиентах нет DB/provider SDK, собственных tool loops и скрытого owner lifecycle.

- [ ] Сохранить существующие вложения, vision, историю и восстановление соединения.
- [ ] В настройках каждого бота доступны cloud/local connection и model;
      показывать тип подключения, доступность сервера и capabilities, не запрашивать
      обязательный ключ для local auth-none. Смешанная команда видна в одной комнате.
- [ ] Показывать работу команды, ожидание коллеги, неопределённый исход и нужное
      решение; настройка доверенной области и подключение модели доступны в приложении.
- [ ] Два окна видят одну задачу; закрытие окна не отменяет ход. Два решения
      одного запроса дают одну принятую операцию, устаревшее решение явно отклонено.
- [ ] Реальный установленный GUI: 1024/1280/1920, keyboard/focus, вложения,
      restart и reconnect. Screenshot/source test не заменяет запуск приложения.

## Task 8: F. Приёмка и выпуск приоритета 1

- [ ] Обновить полную карту требований и release ledger. Устранить применимый
      долг test typing; ни удаление SDK, ни docs-only commit не закрывают его автоматически.
- [ ] Frozen revision: `pnpm check`, `pnpm build`, `pnpm format:check` — exit 0.
      Затем native/source-preset shards и лимиты; прежние 2 GiB/256/60 s/32 KiB
      считаются ограничениями текущих presets, не всей автономной задачи.
- [ ] Независимое ревью runtime/auth/migration и полный branch review;
      проверка всех отложенных замечаний прежнего ledger с явным решением.
- [ ] Одноразовая установка, миграция/backup/restore, reboot/device identity,
      обновление/откат; реальные данные и установленный RC2 не fixtures.
- [ ] Живой DeepSeek и поддерживаемые новые API-провайдеры, MCP; credentials
      не логируются. Указать фактические пропуски и пределы квалификации.
- [ ] Реальная локальная модель на Omarchy: offline chat + tool, RAM/VRAM,
      задержка и пределы контекста; затем смешанная цепочка cloud → local → cloud
      и перезапуск runtime. Записать версии backend/model, настройки и результат;
      fake server не заменяет эту приёмку. Без квалифицированного backend gate открыт.
- [ ] Финальный Linux-артефакт, SHA-256, inventory/licenses, установленный GUI;
      сверить опубликованные байты и ревизию. Stable не выпускать по одним старым RC2 gates.

## Task 9: G. Графический клиент проектов — приоритет 2, после F

Использовать существующие project/worktree/changeset/review/apply сервисы,
тот же движок и сервер. Отдельный UX: проект → задание → ход → diff → review →
применение. Точные operation approvals остаются там, где их требует политика
владельца; автономная работа в назначенном worktree не требует каждого окна.
Критерий: полный dev → review → apply, stale changeset отказ, restart и два
клиента, без дублирования runtime. Конкретные UI-файлы — в плане G после F.

## Task 10: H. Два TUI — позднее

Сохранить нынешние команды и ACP совместимыми на A–F. Затем отдельно развить
TUI проектов и TUI ботов поверх тех же контрактов. Не держать выпуск F ради
нового TUI-оформления, новых schedules или маркетплейса.

## Связь с прежним release-планом

| Старое обязательство                                   | Новый владелец                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------- |
| Принятые worktree/changeset/sandbox и recovery         | Сохраняются; затронутые пути перепроверяются в A/C/D/F          |
| Device-id drift исправления                            | Сохраняются; reboot/restore gate в F                            |
| Незавершённый Executor fix                             | C: сохранить свидетельства, перенести требования на замену      |
| Native qualification и preset shards финальной ревизии | F, не списывать как пройденные                                  |
| Desktop и live RC                                      | E/F на новой семантике                                          |
| Backup/установка/откат/публикация                      | F                                                               |
| Старое «один ответ каждого, без переговоров»           | D заменяет для нового team workflow; старый broadcast совместим |
| Прототип Codex/Claude CLI-исполнителя                  | Исключён последним уточнением пользователя; вместо него B       |

## Самопроверка плана

Архитектура и все четыре клиента покрыты A–H. Пять Review Focus закреплены
в указанных этапах. Первый этап использует существующие сигнатуры, без лишнего
engine abstraction; поздние API/миграции/UX получают отдельные подробные планы,
а не произвольную реализацию из этой карты. Приоритеты 2/«позже» не блокируют F.
Реализация и live-проверки этим документированием не выполнены.
Локальные модели и смешанные команды покрыты B/D/E/F; эти gates обязательны
для приоритета 1, а не отложены до второго графического клиента или TUI.
