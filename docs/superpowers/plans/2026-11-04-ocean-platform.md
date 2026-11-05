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

Этап A принят на `1a99fcb` после независимых ревью;
[результаты и ограничения](../../ocean/platform-stage-a.md). B1 принят на `6633439`, B2 — на `ca25fa6`, B3 — на `14a4931`, B4 — на `72afcb3`, B5 — на `fbaa413`, B6 — на `88039a1`, B7 — на `f533252`, B8 — на `039a819`, B9 — на `d42481c`, B10 — на `05d91a8`, B11 — на `26e9a02`; прикладная часть B12 (задача 15.1) — на `caf79ec`. Серверный контракт 15.2 принят на `aa7e7ed`, межпроцессная приёмка 15.3 и весь контракт B12 — на `a42ff73` после двух раундов исправления тестовых доказательств. Настройки Desktop (16) приняты на `b5e7ece` после двух раундов исправления восстановления и асинхронных состояний. Проверка типов 17.1 принята на `4597744`, долговечность и восстановление 17.2 — на `a8d2755` после исправления гонки публикации. Установленная Linux-приёмка 17.3 принята на `652dd56` после двух раундов исправлений проверочной обвязки; исходная ревизия артефакта — `ec1e5d5`. Реальный local backend и живая смешанная команда (17.4) приняты на `de70683` после трёх раундов исправлений проверочной обвязки; исходная ревизия артефакта — `28909ea`. Установленный GUI настроек и нативные размеры (17.5.1) приняты на `ba92b56`; восстановление GUI (17.5.2) принято на `69bdf1e`; совместная работа клиентов (17.5.3) и применимые проверки B приняты на `67a7833`. Этапы C–H пока запланированы.
Полные root gates остаются красными на сохранённых регрессиях Executor;
приёмка A не заменяет их исправление в C и выпускные проверки F.
Пользователь утвердил архитектуру и разрешил реализацию по порядку, commit/push/merge.
A принят. B детализирован ниже; C–F — отдельные подсистемы, для которых
подробные task-by-task контракты будут добавлены перед изменением кода. G/H имеют более низкий приоритет.
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

- [x] Проверить git status/HEAD и сохранить точный diff незавершённых собственных
      изменений отдельно от чужих. Не включать их в новый commit автоматически.
- [x] В одноразовом HOME/XDG запустить `pnpm check`, `pnpm build`,
      `pnpm format:check`; записать каждый exit code и упавший тест.
      Известный предыдущий результат: три SDK catalog-lifetime регрессии и два
      неформатированных незавершённых файла; не называть это зелёной базой.
- [x] Для каждого сбоя решить: исправление сохранённого поведения либо замена
      проверки при удалении старого backend в C. Нельзя просто отключить регрессию.
- [x] Проверить `runTurn`/room/ACP call graph; зафиксировать место admission,
      claim, invocation и publication. Existing tests проходящие не переписывать.

### Task 2: A2. Проверить собственный движок

- [x] В `own-engine.test.ts` добавить сценарий scripted ProviderPort:
      сначала tool call, затем финальный ответ. Проверить ровно 2 model requests,
      1 вызов tool, 1 TaskRun attempt, `outcome.kind === 'completed'`, передачу
      результата tool во второй запрос и запись claim раньше вызова инструмента.
- [x] Добавить неизвестный исход tool: `outcome.kind === 'uncertain'`,
      вызов tool ровно 1, следующего model request нет. Проверить отказ прав до I/O.
- [x] Запустить `pnpm test packages/application/src/own-engine.test.ts`.
      Для найденного дефекта сначала получить FAIL по конкретному утверждению;
      уже проходящий characterization test не требует искусственного RED.
- [x] Исправить только доказанные нарушения в перечисленных application файлах.
      Использовать существующие lifecycle/service, не второй журнал/цикл.
- [x] Повторить focused test: PASS; затем root gates. Сохранить отдельный commit
      с явным списком собственных файлов: `test: pin local engine ownership` либо
      `fix: preserve local engine execution ownership`, если исправление понадобилось.

### Task 3: A3. Проверить независимость от клиентов

- [x] В `own-engine-process.test.ts` поднять runtime с детерминированным
      провайдером на приватном профиле; в PATH нет Codex/Claude. Отправить запрос,
      закрыть первый клиент во время генерации, вторым получить тот же runId,
      ровно 1 итоговое сообщение и счётчик вызова провайдера 1.
- [x] Оборвать ответ после commit admission, повторить тот же requestId:
      исходный runId, счётчик 1. Изменённые данные с тем же ID дают конфликт.
- [x] В отдельном сценарии после durable effect claim аварийно завершить
      runtime: после рестарта исход unknown, эффект не повторён, cancellation
      не подтверждена. Переиспользовать существующие crash fixtures.
- [x] Добавить сценарий старого клиента без новой capability: прежний чат
      доступен, неизвестная операция отклоняется, права не меняются.
- [x] Зарегистрировать файл в processCases. Запускать
      `pnpm test:process apps/cli/src/local-runtime/own-engine-process.test.ts`;
      ожидается PASS всех сценариев, без живых credentials и без внешнего CLI.
- [x] Исправить только выявленные дефекты host composition; root gates и
      scoped review. Commit: `test: qualify shared runtime with the local engine`.

## B. Облачные и локальные модели — подробный контракт

В B приняты хранение/миграция (задача 4, `6633439`) и настройки/ключи
(задача 5, `ca25fa6`), привязки ботов (задача 6, `14a4931`) и признак новой
фиксации команды (задача 7, `72afcb3`), а также журнал вызовов модели
(задача 8, `fbaa413`);
[доказательства и ограничения](../../ocean/platform-stage-b.md). Остальные задачи
ещё не реализованы. Ниже 14 последовательных задач (4–17), с сохранением
принятого этапа A. Это детализация уже утверждённого направления; C–F ещё
потребуют своих подробных контрактов перед реализацией. Новые B-возможности
не объявляются доступными установленному RC2.

Дополнительные точки ревью B: миграция сохраняет модель каждого бота и старые
квитанции; ротация и restore не активируют соседние подключения; отсутствие
usage не подменяет неизвестный исход; новые DTO согласуются отдельно от RC2;
loopback-адрес сам по себе не доказывает локальное вычисление.

## Shared contracts and staging decisions

**Compatibility first:** Keep `Bot`, `BotProfileInput`, `ChatTurn.bot`, old conversation reply types and all historic JSON unchanged. Do not make Bot.modelBinding required or append it to old receipts. New `BoundBot` is `{readonly bot:Bot; readonly binding:BotModelBinding}`; production resolution joins the current Bot with its binding through the transaction port. Only new APIs expose BoundBot. `ChatTurn.activation?:ModelActivationSnapshot` is absent on historical turns and required by the new production admission path, not by every old fixture literal.

**One canonical connection store:** Migrate provider rows into connection-v2 records and immediately route the existing SqliteProviderConnections facade to those records. Legacy provider metadata tables become frozen migration evidence, not a second writable authority. Keep old provider receipt bytes and legacy fingerprint semantics; lookup reads the old receipt before any current state. Legacy new writes persist a legacy-shaped receipt alongside the canonical connection mutation atomically. V2 receipt IDs conflict with either receipt namespace; do not reinterpret an old result as a new DTO.

**Default versus bot model:** `defaultModelId` is for explicit defaults/creation only. Legacy `provider.set({model})` retains its old effect on provider.status.model but never rewrites Bot.model. `CreateBot` still honors its explicit provider/model input, creating a legacy connection binding. A rebind updates only the selected bot's binding and legacy provider/model projection in one transaction. Do not infer that setting a connection default requested a team-wide model change.

**Store ports:** Add `modelBinding(botId:string):BotModelBinding|null` and `putModelBinding(botId:string,binding:BotModelBinding):void` to ConversationTransaction; implement in SQLite and `packages/store/src/conversations.ts` at Task 4. Add `replaceBot(bot:Bot,expectedProfileVersion:number):void` at Task 6; keep existing `putBot` insertion-only. All legacy putBot callers continue to pass unchanged Bot. Bound creation calls putBot then putModelBinding in the same transaction. On current schema, absence of a binding for an existing bot is corruption and refuses production activation; do not synthesize it while reading. Pre-migration fixture stores keep their legacy surface explicitly.

**Identity and limits:** Define the following in domain, exported publicly; do not put provider instances or key bytes here. These names are authoritative for later tasks.

```ts
interface BotModelBinding {
  readonly connectionId: string;
  readonly modelId: string;
}
interface ModelCapabilities {
  readonly tools: boolean;
  readonly streaming: boolean;
  readonly inputModalities: readonly ('text' | 'image')[];
  readonly contextTokens: number | null;
  readonly maxOutputTokens: number | null;
  readonly usage: 'reported' | 'optional' | 'unavailable';
}
interface ModelExecutionLimits {
  readonly maxModelRequests: number;
  readonly requestTimeoutMs: number;
  readonly turnTimeoutMs: number;
}
type ModelExecutionIdentity =
  | (BotModelBinding & {
      readonly source: 'connection';
      readonly providerId: string;
      readonly connectionRevision: number;
      readonly botProfileVersion: number;
      readonly kind: 'cloud' | 'local';
      readonly endpoint: string;
      readonly auth: 'api_key' | 'none';
      readonly artifactDigest: string | null;
      readonly backendVersion: string | null;
    })
  | { readonly source: 'host'; readonly providerId: string; readonly modelId: string };
interface ModelActivationSnapshot {
  readonly version: 1;
  readonly identity: ModelExecutionIdentity;
  readonly capabilities: ModelCapabilities;
  readonly limits: ModelExecutionLimits;
  readonly admittedAt: string;
  readonly deadlineAt: string;
}
```

**Application-only activation:** `ProviderActivation {snapshot:ModelActivationSnapshot; provider:ProviderPort}`. `ProviderActivationPort.resolve(bot:BoundBot, admittedAt:string):ConversationResult<ProviderActivation>` is synchronous, no network. It copies frozen metadata and resolves only local credential storage. Production host must use this port; it must not silently fall into a host/test mode if the binding cannot resolve.

**Host/ACP compatibility:** TurnInput gains optional `activation?:ModelActivationSnapshot`, `clock?:Clock`; missing activation normalizes once to source:'host' with supplied provider.id/model and conservative capabilities (existing usage:true → reported; false → unavailable; unknown image capability false). It contains no connectionId, revision, endpoint or fake bot identity. ACP and explicitly injected test hosts retain this supported mode. provider:null retains deterministic no-provider behavior and emits no model-request events. Production chat always supplies a persisted connection activation; an explicit injected local-runtime resolver supplies source:'host' and remains read-only.

**Default bounds:** 24 model requests, hard maximum 64; request timeout 120000 ms, turn timeout 600000 ms. Existing maxModelRequests remains supported: normalization takes the lower of it and frozen activation limit; clamp legacy host values as today, validate new owner inputs. A connection activation's deadline/limits cannot change mid-turn. Unknown context limit forbids advertising larger contexts; retain current room-context/image byte limits and explicit request/output bounds. Never claim byte size is an exact tokenizer.

## Journal semantics required before adapter integration

`ModelUsageEvidence = {kind:'actual',tokens:TokenUsagePayload} | {kind:'estimated',tokens:TokenUsagePayload,estimator:string} | {kind:'unavailable',reason:'unsupported'|'not_reported'|'interrupted'}`. B adds no estimator. Keep old ProviderEvent usage as actual; add usage_evidence for explicit alternatives. Normalize cumulative vendor reports in adapters, not by adding successive totals in engine.

`ModelCompletionEvidence = {kind:'terminal',stopReason:CompletionStopReason} | {kind:'rejected'} | {kind:'not_sent'} | {kind:'unknown'}`. Define the domain stop-reason vocabulary in the model-dispatch module and re-export it from application/provider.ts to avoid a domain→application import. Terminal means a validated provider finish with complete framing; a provider error or aborted transport alone does not prove it. ProviderError gains optional dispatch evidence (`not_sent`/`rejected`/`unknown`, default unknown); only explicit pre-send refusal or documented non-executing rejection permits the first two. Treat ambiguous 5xx, timeout and lost response as unknown.

`StartModelRequestPayload {attemptId:string, ordinal:number, activation:ModelActivationSnapshot, startedAt:string}`; `SettleModelRequestPayload {attemptId:string, ordinal:number, finishedAt:string, completion:ModelCompletionEvidence, usage:ModelUsageEvidence}`. Stable journal command IDs are `cm_${taskRunId}_model_${attemptId}_${ordinal}_start` and `_settle`; preserve first submitted timestamp/payload on an exact retry. Different replay payload is a conflict, not a second settlement.

Add TaskRunState.modelExecution: `null | {activation:ModelActivationSnapshot; startedRequests:number; lastRequest:{attemptId:string;ordinal:number;startedAt:string;settlement:SettleModelRequestPayload|null}; usage:{knownTokens:number;estimatedTokens:number;unavailableRequests:number}}`. It is derived from the existing event stream only, no extra dispatch table/counter. New `attempt.model_request_started` and `attempt.model_request_settled` are version-1 payloads; existing event shapes/schemaVersion remain unchanged. Checkpoints currently contain event prefixes, not TaskRunState snapshots: preserve/replay them without rewriting old events or inventing old activation evidence.

- Start legal only running, matching active attempt, no unresolved previous request, contiguous turn-wide ordinal, within frozen limits/deadline, identity matches attempt provider/model and prior activation. Snapshot is adopted on first start, immutable thereafter, including across retries; old unsupported turn continuation never adopts today's connection.
- Settle legal running/cancelling/reconciling, only matching started ordinal and active attempt, once. Unknown is a recorded settlement whose completion is still unresolved. Never interpret settled accounting as proven completed inference.
- Actual settlement emits model_request_settled plus existing attempt.usage_recorded atomically, once. Optional/unavailable/estimated usage does not fabricate zero or debit exact tokens. Preserve legacy standalone RecordUsage for legacy runs; refuse it once a new modelExecution exists so a caller cannot double-charge a dispatch.
- If known completion and actual usage exceeds token budget, emit existing budget_exhausted in that same transaction. For unknown completion, record actual usage but keep the reconciliation hold even if over budget; no next request is allowed and known overrun never releases uncertainty.
- Complete, Fail, Retry and CompleteCleanup(completed) refuse while last request has null settlement or unknown completion. Forced cleanup remains explicitly forced, never proof of quiescence; existing room/effect holds still apply. BeginReconcile/RequestCancel remain available. Generic ResolveReconcile does not clear request uncertainty or authorize re-dispatch; B adds no automatic resume of an unknown model request.
- Terminal plus declared unavailable usage can succeed under finite time/request bounds and no finite exact-token budget. Terminal plus missing expected reported usage fails with recorded not_reported; it is known completion with unknown usage, not unknown completion. Interrupted response is unknown completion even when some actual usage arrived. Finite exact-token budgets with optional/unavailable usage refuse before dispatch.
- Cancellation after validated terminal and no outstanding tool effect can complete existing cleanup; cancellation after request start without completion stays cancelling. Timeout is not owner cancellation: record unknown and enter reconciling. No terminal means no tools. Existing tool uncertainty takes precedence over provider/accounting success.

## Execution and verification conventions

Each task's numbered steps are red test → run → minimal implementation → green test → scoped commit. New files are explicitly marked Create; all other listed files already exist. Test commands below are source tests unless explicitly using the process config. All public declarations require corresponding package index.ts exports. Add no source file above 300 physical lines; split along named responsibilities before growth, particularly provider-connections.ts (already 300), domain decide.ts, events.ts and store conversations.ts. Keep cold-source tests in vitest.source.config.ts and built children in the existing process config; never substitute direct source execution for process acceptance. Every task must leave compilation coherent; do not carry unchecked type errors into a later task.

### Task 4: Canonical connection storage and backward-compatible bot binding migration

**Files:** Create `packages/domain/src/model-binding.ts`, `packages/application/src/model-connection-ports.ts`, `packages/store-sqlite/src/{model-connection-schema,model-connection-storage,model-binding-storage,model-binding-migration.test}.ts`. Modify domain/index.ts; application/conversation-ports.ts/index.ts; store/src/conversations.ts; store-sqlite/{schema,schema-migrations,provider-connection-storage,conversations}.ts and its index.ts; modify `apps/cli/src/ocean/restore-origin.ts` and extend existing provider-backup.test.ts; retain schema19 maintenance and add schema20 backup manifest support with future-schema refusal.
**Interfaces:** Produces BotModelBinding/BoundBot, the two transaction binding methods above, ModelConnectionRecord and ModelConnectionStorePort. Record has connectionId/providerId/kind/endpoint/auth/defaultModelId/secretRef/intent/revision/requestId/binding/lastCheck/updatedAt/pendingSecretChange plus legacyEnvironment:boolean and configuredAfterRestore:boolean. Its intent is 'unconfigured'|'active'|'disconnected'|'pending'; revision 0 is reserved for a persisted unconfigured placeholder, never a claimed activation revision. legacyEnvironment denotes eligibility of the designated legacy DeepSeek connection, independently of current intent/secret source. Preserve true for migrated/legacy-written eligible records; pending/disconnected and saved-reference precedence still block fallback. Legacy facade read AND writes refuse persisted false records rather than coercing eligibility; v2 is their explicit configuration route. Pending change is null or `{action:'replace'|'remove',previousRef:string|null,nextRef:string|null}`. Store has list/read/put(CAS)/activate(record,expectedRevision,receipt)/receipt(requestId), using connectionId. `endpoint` and `defaultModelId` are nullable for inert migrated placeholders; active connection admission requires a validated non-null endpoint/model. Known DeepSeek uses its existing canonical origin; unknown vendors have endpoint:null, kind:cloud, auth:api_key and remain inert. Migration sets configuredAfterRestore:false; ordinary non-restored operation does not require that flag, restored activation does. These metadata defaults do not activate a connection or read a key.

- [x] Add migration assertions: different bot.model values survive a shared default, historic ChatTurn/receipt JSON bytes unchanged, active/disconnected/pending intents survive, missing-row placeholders never gain secrets, rollback and rerun are safe. Assert `expect(tx.modelBinding(bot.id)).toEqual({connectionId:'legacy:deepseek',modelId:bot.model})` while `expect(tx.bot(bot.id)).toEqual(originalBot)`.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/store-sqlite/src/model-binding-migration.test.ts` and confirm red.
- [x] Add next free schema version (observed 19 before B; recheck A). Create `ocean_model_connections(connection_id TEXT PRIMARY KEY,payload TEXT NOT NULL)`, `ocean_bot_model_bindings(bot_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,model_id TEXT NOT NULL)` with bot/connection foreign keys, and `ocean_model_connection_receipts(request_id TEXT PRIMARY KEY,connection_id TEXT NOT NULL,binding TEXT NOT NULL,result TEXT NOT NULL)` as STRICT tables; decode/validate the typed JSON connection payload on every read; connection IDs `legacy:${provider}`. Copy actual legacy rows preserving revision; absent row gets unconfigured revision-0 placeholder distinguished by legacyEnvironment only for the existing DeepSeek environment seam. Preserve old provider metadata/receipt tables, but route old read/put/activate immediately to canonical rows; only an eligible revision-0 placeholder projects as null to old CAS callers; false eligibility refuses through the legacy facade. Unknown vendors remain inert. Do not read keys in migration.
- [x] Existing putBot uses synchronous low-level SQL helpers (no nested provider transaction) to insert Bot and its default legacy binding atomically, creating only an inert placeholder if needed. Existing bot()/bots() shapes stay exactly unchanged; no lazy read mutation. Old-schema fixture stores explicitly omit new behavior; production requires migrated schema. Test atomic rollback including auto-binding and secret/receipt backup exclusion. Restore must reset configuredAfterRestore=false on every copied connection in its existing metadata transaction, even if the source backup had true; do not let copied activation flags bypass restored-mode gating. The source profile remains untouched.
- [x] Run focused migration plus existing conversation/provider-connection-migration tests; compile changed packages with `pnpm build`; commit only Task 4 files. Old production behavior remains usable at this boundary.

### Task 5: Connection-scoped settings and recoverable secret publication

**Files:** Create `packages/application/src/{model-connections,model-connection-resolution,model-connection-publication,model-connections.test}.ts`; modify existing provider-connections.ts/provider-connection-ports.ts/provider-connection-state.ts facade and test-fixtures/provider-connection-fakes.ts; extend model-connection storage from Task 4.
**Interfaces:** Consumes Task 4. Produces `ModelConnectionService.set(input:ModelConnectionSetInput):ModelConnectionStatus`, `.check(connectionId,signal?):Promise<ModelConnectionCheck>`, `.disconnect(input:ModelConnectionRevisionInput):ModelConnectionStatus`, `.removeSavedKey(input:ModelConnectionRevisionInput):ModelConnectionStatus`. Revision input has connectionId/requestId/expectedRevision; set adds providerId/kind/endpoint/auth/defaultModelId/key?, with expectedRevision:null only for create. ModelCredentialFactory.catalog(descriptor) is synchronous and returns modelId/ModelCapabilities entries; activate(descriptor,secret) returns an immutable ModelCredential with source saved/external/auth_none. external(descriptor) is a separate method called only after eligibility/intent/secret/restore checks. Introduce domain/model-capabilities.ts now; Task8 consumes it. Local auth-none never masquerades as legacy source none. Keep legacy public DTOs exact.

- [x] Add tests for two same-vendor connections, auth-none with no secret read/header, missing cloud key refusal, revision conflict before secret writes, cross-namespace requestId collision and exact legacy receipt replay.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/application/src/model-connections.test.ts` and confirm red.
- [x] Implement validated metadata, per-connection configuredAfterRestore and explicit legacyEnvironment. Limits: connection/model 256 UTF-8 bytes, provider 64, request 128, endpoint 2048. Reject endpoint userinfo/query/fragment; cloud canonical HTTPS only; first local profile loopback IP only. Key omission retains existing credential; auth-none must be explicit and rejects supplied key. Default model update never mutates bots.
- [x] Persist old/new refs in pending intent before replace/remove, verify publication, activate+receipt atomically. Preserve existing secret-store modes/fsync. Legacy pending without previousRef remains unverified until explicit repair; never infer activation or delete unidentified refs. Slow probe only updates its exact revision. Reconfigure one restored connection without enabling siblings.
- [x] Run new tests plus existing provider-connection-{activation,resolution,boundaries}.test.ts and `pnpm build`; commit Task 5. Legacy service delegates through a compatibility translator preserving old DTO/fingerprint semantics, not a second mutation implementation.

**Replay/composition decisions:** New v2 receipts add optional versioned publicResult:{version:1,status:ModelConnectionStatus}; all newly admitted v2 mutations commit and return that exact public snapshot, including first response. Never expose internal result/secret refs or regenerate replay from current credentials/catalog. Old internal v2 receipts without publicResult refuse receipt_result_unavailable without effects. Legacy receipt bytes and fingerprint tuples stay exact. Use one mutation/publication algorithm with typed legacy/v2 receipt sinks and one canonical transaction. Internal constructor ports may evolve explicitly across typed composition/tests; never emulate durable canonical fields in an old port that cannot persist them. Scope compatibility is the existing client/CLI/TUI/ACP behavior. All persisted enums require strict scalar checks, never String coercion.

### Task 6: Atomic bot creation/rebinding with explicit compatibility projections

**Files:** Create `packages/application/src/{bot-model-binding,bot-model-binding.test}.ts`; modify conversation-ports.ts; store/src/conversations.ts; store-sqlite/model-binding-storage.ts and conversations.ts.
**Interfaces:** Consumes Tasks 4/5. Produces `BotModelBindingService.set({workspaceId,botId,requestId,expectedProfileVersion,binding}):ConversationResult<BoundBot>` and `.create({workspaceId,requestId,handle,name,role,binding}):ConversationResult<BoundBot>`; add replaceBot(bot,expectedProfileVersion) transaction method. Inject read-only connection lookup; no probing or credential activation during profile edits.

- [x] Test same request replay, changed payload conflict, stale version refusal, model validation, two bots sharing one connection with different models, and no sibling changes. Assert old CreateBot receipts remain old Bot shape; new binding receipt stores BoundBot without modifying historic receipts.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/application/src/bot-model-binding.test.ts` and confirm red.
- [x] Implement binding+Bot projection+receipt in one transaction. New creation overrides the temporary legacy binding before commit. Set increments profileVersion, sets Bot.provider/model from selected connection/binding and preserves other fields; reject unknown connection/model, but allow owner configuration of a disconnected known connection without making it executable.
- [x] Verify `provider.set` changes only status default, then explicit rebind changes exactly one bot; legacy CreateBot keeps its explicit model. Replay old room/turn snapshots unchanged after rebind.
- [x] Run new tests and existing `packages/store-sqlite/src/conversations.test.ts`, `pnpm build`; commit Task 6. No new RPC is exposed yet.

### Task 7: Distinguish fresh journal commits from receipt replay

**Files:** Modify `packages/application/src/{command-commit,service}.ts`, `packages/store/src/command-commit.ts`, `packages/store-sqlite/src/command-commit.ts`; extend existing atomic-command.test.ts in both stores; Create `packages/application/src/command-disposition.test.ts`.
**Interfaces:** Produces `CommandCommitResult {receipt:CommandReceipt; disposition:'committed'|'replayed'}`; add optional CommandCommitPort.commitWithDisposition(same args as commit):Promise<Result<CommandCommitResult>> and `TaskRunService.executeWithDisposition(command:AnyCommand):Promise<Result<CommandCommitResult>>`. Keep execute/commit signatures and persisted receipts unchanged.

- [x] Add concurrency test with identical command submitted twice: one committed, one replayed, one event batch. Lookup-hit and inside-transaction race both return replayed; conflicting payload remains conflict. Assert `expect(results.map(x=>x.disposition).sort()).toEqual(['committed','replayed'])`.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/application/src/command-disposition.test.ts packages/store/src/atomic-command.test.ts packages/store-sqlite/src/atomic-command.test.ts` and confirm new assertions red.
- [x] Implement disposition at existing atomic append+receipt boundary, not by post-hoc version comparison. Existing execute maps out receipt; new execute requires atomic commitWithDisposition or fails atomic_commands_required. Do not retrofit non-atomic fake logs into fresh execution authority.
- [x] Run the same tests and `pnpm build`; inspect receipt byte equality and rollback behavior.
- [x] Commit Task 7. This additive API is independently reviewable and is required before fresh start can authorize network I/O.

### Task 8: TaskRun model-dispatch evidence and guards

**Files:** Create `packages/domain/src/{model-dispatch,model-dispatch-decide,model-dispatch-evolve,model-dispatch.test}.ts`; modify domain/{commands,events,state,decide,evolve,index}.ts. Create application/model-activation-types.ts for application-only provider pairing; re-export domain shapes from application/provider.ts/index.ts.
**Interfaces:** Produces exact snapshot/usage/completion/payload/state types and StartModelRequest/SettleModelRequest commands defined above. Domain helpers are `decideModelDispatch(state,command):Result<readonly TaskRunEventDraft[]>` and `evolveModelDispatch(state,event):TaskRunState`; event status transitions are null (hold current lifecycle state).

**Accepted implementation decisions:**

- Unknown settlement from running appends existing `task_run.reconciling` atomically after settlement/accounting; cancelling/reconciling retain their state. The new model events keep null status transitions. Unknown over-budget usage never appends exhaustion.
- Existing `usage_recorded` alone debits exact tokens and updates model knownTokens. Settlement updates estimated/unavailable evidence; first Start seeds knownTokens from the existing budget ledger. Event-prefix replay must not double-charge.
- The unresolved-request guard covers Complete/Fail/Retry/completed cleanup/ResolveReconcile and terminal alternatives ExhaustBudget/DenyPolicy/FailReconcile. Also block Wait/BeginCheckpoint/StartAttempt, which could prevent settlement or replace its owning attempt. Resume/CommitCheckpoint may restore a settlable state. Preserve old replay/source tables and explicitly forced cleanup evidence.
- A terminal result missing expected reported usage is recorded, then must fail: Complete/another Start/Retry refuse. Fail and confirmed cleanup remain possible. not_sent/rejected are known nonexecuting outcomes, not successful Complete; an explicit retry can obey remaining frozen bounds. Finite exact-token dispatch requires reported usage and positive remaining capacity including reservations.
- New commands strictly validate safe integers, real UTC calendar timestamps, complete structural activation equality and detached nested data. `connectionRevision >= 0` permits the existing eligible legacy environment placeholder; `botProfileVersion >= 1`. Requests are bounded to 1..64, turn timeout to 600000 ms, request timeout to positive safe integers <=600000 ms. Validate admitted/start/deadline order and previous finish order; accept late settlement evidence.
- TaskRun cannot infer legacy admission from modelExecution:null. Task10 enforces persisted activation for production continuation; explicit host compatibility remains. No era flag, new table or changed checkpoint format. Preserve exact stop-reason vocabulary: terminal/unknown reason differs from unknown completion.
- Task9 must not append a duplicate BeginReconcile after atomic unknown settlement. Split validation/guards/usage/evolution helpers along these responsibilities to retain the 300-line cap.

- [x] Write state-table tests for first/second start, ordinal gap, changed activation, expired deadline, wrong attempt, double settle, finite budget, cancel-before/after start, unknown completion guards and forced versus completed cleanup. Assert `expect(actualEvents.map(e=>e.type)).toEqual(['attempt.model_request_settled','attempt.usage_recorded'])` for known in-budget actual usage.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/domain/src/model-dispatch.test.ts packages/domain/src/usage.test.ts` and confirm new assertions red.
- [x] Implement journal semantics above. Add old-event replay default modelExecution:null and known-token summary from old usage events; once modelExecution starts, settle owns all new usage. Validate finite nonnegative integer counts and ISO timestamps, preserve existing terminal immutability. Bounds are turn-wide and do not reset on attempt retry.
- [x] Test event-prefix checkpoints with new/old events, unknown completion with actual over-budget usage remains held, generic ResolveReconcile cannot authorize another start. No new table or mutable budget cache.
- [x] Run targeted tests plus existing taskrun-{lifecycle,replay,recovery}.test.ts, `pnpm build`; commit Task 8. Split existing decide usage helpers if needed to keep ≤300 lines.

### Task 9: Engine integration with honest usage and bounded host execution

**Files:** Create `packages/application/src/{model-dispatch,model-activation,usage-evidence.test,model-dispatch.test}.ts`; modify provider.ts/types.ts/round.ts/turn.ts/lifecycle.ts; extend own-engine.test.ts/turn-safety.test.ts; existing ACP/engine compatibility tests stay in scope.
**Interfaces:** Consumes Tasks 7/8. `normalizeModelActivation(input:TurnInput):ModelActivationSnapshot` supports host fallback only at this low-level engine API; `beginModelRequest(input,attemptId,ordinal):Promise<'dispatch'|'replayed'>`; `settleModelRequest(input,attemptId,ordinal,round:ModelRound):Promise<void>`. ModelRound adds completion and usageEvidence while preserving legacy usage nullable during transition.

- [x] Test normalized ACP/injected identity source host has no connectionRevision, provider:null no model event, legacy maxModelRequests clamp remains, reported/optional/unavailable branches differ, and finite token budget rejects unsupported usage pre-network.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/application/src/usage-evidence.test.ts packages/application/src/model-dispatch.test.ts` and confirm red.
- [x] Before stream commit Start with executeWithDisposition; only committed returns dispatch. Replay/unknown commit outcome does not call provider. Combine owner signal with frozen deadline/request timeout; retain current active-turn exclusion. Use persisted startedRequests+1 as the next ordinal, rather than resetting it to the loop counter on a later attempt. Normalize usage and terminal evidence once; persist settlement before tools or completion; do not invoke legacy settleUsage again for the same round.
- [x] Test a provider whose pending iterator.next() ignores AbortSignal: deadlines must stop host waiting with durable unknown/reconciliation, zero tools/new dispatch, and no claimed cleanup. Do not await iterator.return() indefinitely or let late output reset bounds or settle twice.
- [x] Tests: `expect(cloudCalls).toBe(0)` after local failure; terminal optional missing metric records unsupported/not_reported as appropriate with no zero usage event; broken stream records unknown and no tools; pre-send abort confirms no model request; abort after start remains cancelling unless valid completion and tool quiescence are known. Requests over 24 and total deadline over 600000 stop; late output cannot reset bounds.
- [x] After build, qualify existing local-runtime own-engine-process, lost-receipt-process and restart-process tests independently if root check stops at the known source baseline; this task changes the real dispatch path. Use built entry points and private profiles, record exact revision/results.
- [x] Run new tests plus turn-safety/own-engine and `apps/cli/src/engine/{turn,turn-local,agent-loop}.test.ts`, `apps/cli/src/acp/agent-provider.test.ts`; `pnpm build`; commit Task 9. Logs lacking atomic disposition refuse model execution, with an explicit fixture upgrade rather than disabling journaling.

### Task 10: Per-bot activation at durable chat/broadcast admission

**Files:** Create `packages/application/src/{provider-activation,provider-activation.test}.ts`; modify direct-chat-admission.ts/direct-chat.ts/chat-turn-execution.ts/provider-admission.ts/room-broadcast.ts, domain/chat-turn.ts, store-sqlite/chat-storage.ts; modify CLI local-runtime/{provider-settings,host,turns,broadcast}.ts and existing provider-rotation.test.ts. Include room-broadcast-runner/views, selected-model credential resolution, settings-hosts/host-options, public exports and focused storage/host fixtures as needed by the same admission path.
**Interfaces:** Consumes Tasks 4–6/9; produces synchronous ProviderActivationPort above. DirectChatService input supports a resolver alongside deprecated explicit provider injection, with exactly one mode selected; new production host requires resolver. Admission returns in-memory activation paired with persisted ChatTurn.activation.

- [x] Test receipt replay does not call resolver/secrets; admitted turn persists exact connection/bot revision before dispatch; current turn survives unrelated rotation; model/key/endpoint change affects only later relevant admissions. Assert saved snapshot equality after two tool rounds and another connection's rotation.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/application/src/provider-activation.test.ts apps/cli/src/local-runtime/provider-rotation.test.ts` and confirm red.
- [x] Resolve selected BoundBot within existing synchronous room transaction, using only local metadata/secrets. Freeze arrays and fields. Pass persisted model/activation into engine without reading current configuration in modelRound. On restart preserve existing recovery: no redispatch of accepted/dispatching unknown work. Resolve the explicitly bound model independently of connection default; pass the unchanged descriptor to credential/catalog factories. Preserve revision-zero legacy eligibility and saved-key/restore/pending refusal precedence. Production host passes the resolver without reading credentials before receipt lookup.
- [x] Broadcast child creation freezes Bot plus separate `modelBinding?:BotModelBinding`; capture activation on queued→accepted using frozen binding/model, not today's Bot. Historic queued children lacking binding use deterministic legacy mapping only when still same provider/model, today’s binding still selects that legacy connection and the real connection exists; otherwise explicit refusal, never write invented historical revision. Existing dispatched historical turns remain recovery-only. New direct/broadcast writers always persist required fields.
- [x] Compose accurate adapter-owned DeepSeek capabilities without vendor knowledge in application; keep explicit injected providers source:host. Replace host fixture origin override with injected HttpClient for chat and probe: fixture routing asserts canonical URLs and permits only its private loopback server. Production activation records the configured endpoint, with no hidden override or wire routing option.
- [x] Run focused activation/rotation/direct-chat/broadcast tests and root gates. After build, independently run own-engine-process, lost-receipt-process, restart-process and broadcast-process if the known source baseline prevents root process execution. Commit Task 10 with exact evidence; UI remains legacy-compatible while runtime routing is now per bot.

### Task 11: OpenAI adapter and package wiring

**Files:** Create `packages/provider-openai/{package.json,tsconfig.json}`, `src/{provider,wire,stream,tool-assembler,models,index}.ts` and matching *.test.ts. Modify provider-core bounded HTTP/SSE helpers as needed, root tsconfig.json/vitest.config.ts, CLI package.json/tsconfig.json, pnpm-lock.yaml and provider registry composition.
**Interfaces:** `createOpenAIProvider({apiKey,httpClient?,timeoutMs?}):ProviderPort`; bounded `probeOpenAIModels(options,signal):Promise<ProviderProbeResult>`. Reuse HttpClient/SSE through public exports; requestBytes and stream share one serializer.

- [x] Fixtures assert partial frames, indexed fragmented tools, malformed JSON, usage after finish, missing DONE, model mismatch, 401/429/timeout/abort, image byte mapping, body cap and exactly one send. Add no retry/tool runner.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/provider-openai` red, implement the pinned profile below, run green plus provider-core/provider-deepseek regression directories.
- [x] Wire package exports/references/source aliases and CLI dependency in the same task; `pnpm build` must resolve public imports. Preserve supported valid DeepSeek wire behavior and require its tests after shared framing extraction.
- [x] Close the identified legacy DeepSeek evidence gap during adapter qualification: finish without DONE, DONE without finish, incomplete final framing and partial usage must not fabricate terminal/zero evidence. Add regressions before changes; preserve validated actual usage on interruption, no tools for unknown completion, and old stored events unchanged. Verify the vendor-specific final chunk against [DeepSeek’s documented contract](https://api-docs.deepseek.com/api/create-chat-completion/), separately from OpenAI’s usage-only chunk. This is a pending source qualification, not a live pass.
- [x] Commit Task 11 with source/build tests; live OpenAI access remains a separate Task 17 gate.

### Task 12: Anthropic Messages adapter and package wiring

**Files:** Create the same package layout and focused tests under `packages/provider-anthropic`; modify build/test/CLI registry wiring as Task 11.
**Interfaces:** `createAnthropicProvider({apiKey,httpClient?,timeoutMs?}):ProviderPort`; bounded `probeAnthropicModels(options,signal):Promise<ProviderProbeResult>`. Vendor-specific wire/assembler, shared transport/SSE only.

- [x] Fixtures assert pinned API header, system separation, tool_use/tool_result correlation, indexed input_json_delta, cumulative usage, message_stop, documented ping and benign SSE transport extensions, unknown named-event refusal, HTTP/in-stream errors, images, cancellation, missing terminal and one send. Test temperature/fallback unsupported fields never sent.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/provider-anthropic` red; implement the initial thinking-disabled model profile below; run green plus provider-core.
- [x] Treat start/interim usage as private prefix counts, not final actual. Only a terminal message_delta with closed blocks and valid final cumulative output qualifies whole-request accounting. Missing final counts with valid message_stop produce known completion plus unavailable usage; interruption after qualified final usage retains actual and unknown completion. Prefix-only interruption remains unavailable, with no invented complete debit.
- [x] Normalize cache read/write input usage without double counting; do not claim support for thinking models whose signed continuation cannot be preserved by existing ChatMessage. Unknown execution-bearing content fails, never silently discarded before tools.
- [x] Exercise the actual Ocean engine through two Anthropic requests and one native tool effect/result. Its empty reasoning string on continuation is valid neutral state; nonempty unsupported thinking history refuses. Qualify rejection evidence from the documented error envelope without discarding contradictory inference fields.
- [x] `pnpm build`; commit Task 12 including package wiring. Live Anthropic gate remains open without credentials.

### Task 13: Local Ollama adapter with bounded asynchronous preflight

**Files:** Create equivalent `packages/provider-local` package plus src/{qualification,qualification.test}.ts; Create provider-core/src/{ndjson,ndjson.test}.ts; modify HTTP redirects/bounds and registry/build wiring. Add connection qualification persistence in `packages/store-sqlite/src/model-qualification-schema.ts` with the next free migration and focused storage tests, and extend the application connection port/read model. Persist exact backend version, full artifact digest, capabilities and configured context only from explicit owner check; stream preflight cannot update it.
**Interfaces:** `LocalModelQualification {modelId:string;artifactDigest:string;backendVersion:string;capabilities:ModelCapabilities;configuredContextTokens:number}`; `createLocalProvider({endpoint,auth:{mode:'none'}|{mode:'api_key',key:string},qualification,httpClient?,timeoutMs?}):ProviderPort`; bounded `checkLocalModel(options,signal):Promise<LocalModelQualification>` uses metadata endpoints only.

- [x] Fixtures assert auth-none performs no secret lookup/auth header, absent weights/backend refusal, digest/version drift, cloud-proxy metadata refusal, missing tools/vision pre-inference, NDJSON split/error/done, unavailable usage, tool_name roundtrip, no pull/create/process-start or cloud send.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/provider-local packages/provider-core/src/ndjson.test.ts` red; implement native chat and probes; run green.
- [x] Bootstrap via an optional typed `factory.localBootstrap` metadata capability: registered desired local settings may persist active intent with null qualification and unverified status, without catalog placeholders or a dummy ProviderPort. Check uses metadata-only credentials; successful changed evidence atomically publishes qualification and revision R+1 in the existing row, identical evidence keeps R. Check metadata identifies inspected R. Stale results do not rebase; failed rechecks retain previous evidence but every inference still requires matching preflight. Fresh local set/key removal invalidates qualification. Initial scope is one qualified model per connection. Established auth-none paths read no secrets; explicit teardown of a previous API key still verifies deletion through existing recovery.
- [x] Extend ModelConnectionRecord with `localQualification:LocalModelQualification|null`, persisted in its typed JSON payload and decoded as null for earlier B/cloud records; only explicit successful owner check plus matching revision publishes it. Admission uses cached qualified metadata synchronously. After durable StartModelRequest and before every inference POST, adapter performs bounded async version/tags/show preflight against frozen qualification. Mismatch/unreachable probe yields not_sent for inference and no tools. Probe traffic does not count as inference retries; use same request deadline. Do not write qualification from stream; only explicit owner check can update it/revision for later turns.
- [x] Close Task12 review Minor: validate public provider timeout values against the actual supported native timer range before constructing providers; preserve timeoutMs:0 semantics and sanitized invalid_request/not_sent errors. Add boundary regressions for Anthropic and corresponding shared/cloud paths.
- [x] Complete redirect-policy consistency: reuse the accepted OpenAI no-follow HTTP policy for local metadata/inference and existing DeepSeek inference/probe. Refuse every redirect without resending transcript/credentials or claiming an already-dispatched inference was unsent; preserve explicitly configured direct endpoints. Qualify at the fetch seam, not just HttpClient.send counters.
- [x] Document unavoidable external TOCTOU: tag can change after probe; verify returned model identity when available, but do not claim digest pin is atomic. Offline local-only qualification requires external backend cloud disabled, locally present artifact and isolated network; unknown remote-origin metadata refuses. No redirected inference/auth, no implicit cloud fallback, no downloads.
- [x] `pnpm build`; commit Task 13 including package wiring. Candidate remains unqualified until actual full digest/backend version and offline measurements exist.

### Task 14: Room cloud-transfer policy as a reusable admission rule

**Files:** Create domain/{room-model-policy,room-model-policy.test}.ts; application/{room-model-policy,room-model-policy.test}.ts; store-sqlite/{room-model-policy-storage,room-model-policy-schema}.ts; modify conversation ports/stores/migrations and provider activation/bot-binding services.
**Interfaces:** `RoomModelPolicy {roomId:string;cloudTransfer:'allow'|'deny';revision:number}`; `RoomModelPolicyService.set({workspaceId,roomId,requestId,expectedRevision,cloudTransfer}):ConversationResult<RoomModelPolicy>`; pure `admitModelTransfer(policy,identity):ConversationResult<void>`. Separate from existing text_only RoomExecutionPolicy.

- [x] Tests deny cloud membership/binding and dispatch before context transmission, local unavailable makes zero cloud calls, rebind of a bot in any deny room refuses, and setting deny on existing cloud members conflicts without partial write. Add explicit host-identity refusal in deny rooms unless test-only policy supplies local evidence; host source does not prove locality.
- [x] Deny transition also conflicts on durable frozen cloud/unknown work: queued bindings and accepted/dispatching/prepared/uncertain activations, even after current bot rebind or text-only review. Do not use activeChatTurn alone: it omits reviewed uncertainty. A successful policy change never claims cleanup; unresolved cloud work may block deny indefinitely. Add first-send and between-round barriers. No current member-removal API exists; preserve its future obligations without adding it here.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts packages/domain/src/room-model-policy.test.ts packages/application/src/room-model-policy.test.ts` red.
- [x] Implement transactional policy/receipt/CAS and member-room checks, including group creation/member mutation paths. Existing and newly created rooms persist allow/revision 1 (historical behavior), not new grants. Missing policy after migration refuses. Atomic create-with-deny and immediate per-dispatch revocation remain future contracts. Production activation must classify kind from canonical connection, never the display name. D must consume admitModelTransfer for delegation; no D scheduler here.
- [x] Run green plus binding/activation tests and `pnpm build`; commit Task 14. This independently testable policy need not wait for graphical settings.

### Task 15: Negotiated model/binding RPCs and legacy compatibility

**Files:** Create contracts/src/{local-model-connections,local-model-connections.test}.ts, tools-node/src/{local-model-connections-client,local-model-connections-client.test}.ts, CLI local-runtime/model-settings.ts; modify relevant index.ts, existing provider-settings.ts/host.ts/query projections and hello negotiation files found at the final A3 seam.
**Interfaces:** Feature `model.connections-v1`; methods modelConnections.list/set/check/disconnect/removeSavedKey, bots.createBound/setModelBinding/listBound, runs.modelExecution, rooms.getModelPolicy/setModelPolicy. DTO validators mirror exact Task 5/6/14 inputs; only new views carry BoundBot, connection metadata and usage completeness. Neither key bytes nor secret refs appear in output.

- [x] Before editing transport, verify accepted A3 `1a99fcb`: hello.clientFeatures allows at most 16 strings of length 1..64; current marker is plugin.session-authority-v1; legacy sockets receive filtered plugin.* hello/status capabilities and plugin.* is blocked before dispatch. Preserve this per-socket behavior. Do not grow frozen RC2 hello/status beyond 64 or add every B method as a legacy capability; controller verified the frozen RC2 validator against cfa8490 apart from its first comment.
- [x] Create strict validator/old-client regression tests, including one host with concurrent legacy/current/B sockets, alternating status/plugin/B operations to prove negotiation cannot leak across sockets; run `pnpm exec vitest run --config vitest.source.config.ts packages/contracts/src/local-model-connections.test.ts packages/tools-node/src/local-model-connections-client.test.ts` red.
- [x] Implement new negotiation gate before dispatch and bounded DTOs. Legacy provider.* response/request validators remain exact; translate default connection only. New methods absent feature → explicit unsupported; new client against old host disables these controls. Project internal model-dispatch entries for legacy sockets to existing redacted positional placeholders, preserving physical sequence and contiguous pagination; do not remove rows, renumber events or add a cursor to frozen DTOs. New fields remain in negotiated views only.
- [x] Compose BotModelBindingService metadata lookup over the same canonical profile transaction/draft as ConversationStore; no separate database snapshot or mutable catalog authority. Verify through the built runtime entry point.
- [x] Add rooms.getModelPolicy as a scoped metadata read of the actual stored policy and revision, so restarted clients can use set CAS without guessing or mutating to read. Missing policy refuses; keep frozen room DTOs exact.
- [x] New list/read views are metadata-only, with no credential activation/probe. Page connections and bound bots by exact ID (default50/max200 plus frame budget); bind profileVersion and connectionId in one canonical snapshot. runs.modelExecution is a fixed-size workspace/room/run-scoped committed view, separate from old DTOs. Derive usage completeness from request evidence categories, including estimated zero; totals alone are insufficient, and legacy prefix scope stays explicit.
- [x] Persist a versioned keyless original-request envelope with each new pending secret intent, preserving API family, method, exact null/number/omitted expected revision and key presence. Expose a separate recovery projection; recovery uses the same original method/request and matching key re-entry where required. Do not guess historical input, expose stored keys, change frozen receipts or add resumePending/receipt discovery in this first contract.
- [x] Before exposing settings, define owner-visible pending recovery: retain the exact request identity/payload needed for retry across disconnects, disclose when the key must be supplied again, and never treat a fresh requestId as permission to discard pending cleanup. Legacy missing intent needs explicit repair, not invented history.
- [x] Close Task5 review minor: unknown connection disconnect/remove must return `connection_not_found`, not `revision_conflict`; pin both cases before exposing the new RPC error contract.
- [x] Run green plus local-provider.test.ts and final A3 compatibility tests; `pnpm build`; commit Task 15. Process compatibility tests use built normal entry points and process config, not source alias imports.

#### Task 15.1: Durable recovery envelopes and safe application reads

**Parent:** Task 15 stays open until 15.1–15.3 are accepted. This is the first sequential implementation checkpoint, with a fresh worker and scoped review.
**Files:** Application model-connection mutation/publication/validation/types and dedicated metadata/recovery/binding/model-execution read projections; store-sqlite canonical JSON migration and affected backup/schema fixtures; room-model-policy scoped read. No new socket methods, SDK or Desktop changes yet.

- [x] Persist the exact versioned keyless original-request envelope with new pending secret intents, validate consistency, preserve frozen receipt bytes and historical missing-envelope limits; no new resumePending API. Add schema/restore/reopen and two-owner replay/failed-publication regressions.
- [x] Implement metadata-only connection pages and bound-bot reads, room policy read and scoped model-execution projection over one committed event stream. Prove no credential/activation/probe effects, exact profileVersion/binding, real policy revision, explicit unknown usage counts and safe bounded projections. Final wire parsing is 15.2.
- [x] Fix the unknown-connection revision-error ordering. Run focused RED/GREEN, strict tests, required root gates and scoped review; commit this checkpoint. Resolve exact public application projection types before the wire worker starts.

#### Task 15.2: Negotiated wire contract, SDK and runtime composition

**Parent:** Task 15, after accepted 15.1.
**Files:** Public contracts validators, tools-node client, CLI model-settings/read handlers and per-socket negotiation/projection seams identified above. Consume 15.1 application ports; preserve old protocol families.

- [x] Add the exact named methods and model.connections-v1 marker, bounded strict request/reply validators and client wrappers with unsupported refusal before wire use.
- [x] Preserve A3 plugin negotiation and frozen old-client limits; project internal model events to positional redactions for legacy sockets. Scope every request to its authenticated profile and requested room/run; never mutate shared query negotiation state.
- [x] Wire same canonical stores, supervise owner mutations/checks through runtime drain, preserve pending recovery and sanitize legacy provider_unverified status. Run focused RED/GREEN, strict tests, root gates and scoped review; commit.

#### Task 15.3: Process compatibility and recovery acceptance

**Parent:** Task 15, after accepted 15.2. This completes the parent only after all earlier Task15 requirements are covered.
**Files:** Built runtime/client process fixtures and compatibility/recovery tests; product implemented/planned documentation. Source fixes only for demonstrated integration gaps, followed by scoped review.

- [x] Qualify simultaneous legacy/A3/model sockets and old safe/unsafe hosts, exact pending retry across disconnect/restart, two owners answering one original operation, changed-input refusal, paginated exact bindings, room-policy revision refresh and run evidence snapshots. Use real built entry points with synthetic keys/services and effect counters.
- [x] Freeze final evidence, run required root gates and built process suites, reconcile all parent Task15 checklist items and limitations. No live provider or installed GUI claim; those remain separately qualified. Commit and accept parent Task15 only after independent review.

### Task 16: Minimal connection and bot-binding settings UI

**Files:** Modify desktop/src/ui/{ProviderSettings.vue,provider-state.ts,provider-state.test.ts}; Create desktop/src/ui/{bot-model-state,bot-model-state.test}.ts and focused bot-binding component, model-settings-text.ts and its tests; retain provider-text.ts/provider-text.test.ts for the frozen legacy form under the approved small-module split. Connect existing preload/client boundary through public tools-node methods.
**Interfaces:** Consumes Task 15 DTO/client. Produces metadata-only connection selector, explicit Cloud/Local/auth mode, per-bot model selector, check/disconnect and revision-conflict refresh. Existing provider form remains usable when new feature absent.

- [x] Tests two bindings survive refresh, defaults do not mass-rebind, write-only key input clears after submission, auth-none needs no dummy key, restored/disconnected status honest, unknown usage not shown as 0 actual tokens and unsupported capabilities visibly refuse.
- [x] Run `pnpm exec vitest run --config vitest.source.config.ts apps/desktop/src/ui/provider-state.test.ts apps/desktop/src/ui/provider-text.test.ts apps/desktop/src/ui/bot-model-state.test.ts` red.
- [x] Implement bounded settings flow, no model calls/client database access or automatic credential import. Handle stale revisions with explicit refreshed state, no blind resubmission. Keep graphical chat redesign in E.
- [x] Run green and `pnpm build`; commit Task 16. Native UI qualification remains Task 17.

### Task 17: Integrated migration/restart/package and live qualification gates

**Files:** CLI local-runtime/model-connections-process.test.ts and accepted model-recovery-process.test.ts; existing ocean/provider-backup.test.ts and store model migration/restore tests; test-fixtures/model-mixed-* and model-process-* hosts/clients; application projection/snapshot tests and store command-disposition.test.ts. Release/QA files follow 17.3–17.5 below; modify packaging only for demonstrated gaps. Update implemented/planned status in product docs only after evidence.
**Interfaces:** Consumes all prior tasks; fixtures create scratch profiles/private fixture keys only. Process tests execute built hosts/provider packages; filename _process_.test.ts already matches vitest.process-cases.config.ts. Child fixture scripts may run through Node TypeScript support, compile strictly in the Node test context and import production modules from dist. All provider aliases must exist in vitest.config.ts; record source/built provenance explicitly.

- [x] Close the global test-typecheck debt recorded during Task11: use proper Node/DOM test compiler contexts, repair stale test API/literal typing, retain strict flags and coverage. Source/API identity to Task11 BASE only establishes that these errors were not introduced by that adapter; it is not proof that the whole branch is clean. Record reproducible strict test gates alongside production build.
- [x] Complete Task7 review minor: after reopening SQLite, replay the command originally admitted by executeWithDisposition through both APIs and compare exact receipt JSON, in addition to existing unchanged-row checks.
- [x] Tests two clients, lost receipt, same requestId after rotation/restart, distinct cloud/local bot bindings, model start before crash, no redispatch, unknown usage versus unknown completion, restore all connections inert, reconnect one only, raw legacy receipt replay, foreign-key integrity and old binary refusal of newer schema. Qualify known local preflight nonexecution separately from unknown inference: use durable TaskRun/effect facts to report a known refusal without a false uncertainty hold, while preserving real holds. A failed local child must not prevent a separately addressed cloud child from running; it must never cause cloud fallback for the local child. TurnOutcome.kind alone is not proof of terminal state.
- [x] Run `pnpm build` then `pnpm exec vitest run --config vitest.process.config.ts apps/cli/src/local-runtime/model-connections-process.test.ts apps/cli/src/local-runtime/model-recovery-process.test.ts`; run backup test through source config. Expected all assertions pass, including cloud-call counter 0 for local failure. Source/process split must not accidentally skip new cases.
- [x] Package smoke imports new public adapters from installed tree without repository resolution or Codex/Claude CLI. Existing packageRelease requires clean committed tree and Node 26; keep source engine floor and pinned Executor/license checks. Do not stash/reset protected dirty work to manufacture a clean release.
- [x] Run workspace root `pnpm check`, `pnpm build`, `pnpm format:check`; commit only scoped verified work. Qualify native Desktop/installation/rollback separately with scratch profiles; no in-place DB downgrade.
- [x] With explicitly available prerequisites, run local offline text+tool gate and endpoint failure, record backend/full artifact digest, peak RAM/shared GPU/swap, cold/warm latency and tool/usage fidelity. Run each cloud live gate separately with provided credentials. Missing prerequisites are open gates, not passes. Full autonomous A→B→A delivery identity gate remains D/F; B proves mixed direct/broadcast routing.

B acceptance at `67a7833` reconciles the applicable evidence above: the root commands ran with the explicitly retained C catalog3/format2 debt; they are not green. OpenAI/Anthropic live remains user-deferred, not passed. Runtime package imports are qualified; advertised declaration gaps still require F triage.

The following sequential checkpoints close Task17; the parent stays open until all applicable evidence is reconciled. Existing user approval covers these implementation decisions and the preserved SDD method. Native prerequisites are deliberately prepared only in owned isolated qualification paths; installed Ocean1.0/RC2 and real profiles remain separate. OpenAI/Anthropic live remains explicitly deferred, never a pass. Final C/F gates must fix the protected catalog debt.

#### Task 17.1: Strict test compiler coverage and fixture typing

**Files:** modify package.json/tsconfig.tests.json; create tsconfig.tests.node.json and tsconfig.tests.desktop.json; repair only actual diagnostic fixtures identified by fresh compiler output and task-17-test-types-preflight.md. Preserve protected catalog test/rig semantics and bytes until C owns them. No production port weakened for stale mocks.

**Interfaces:** Consumes current public ProviderPort/ProviderEvent/Changeset/ToolJournalPort/TuiApp/ChatRunBook and desktop send signatures; inspect settled16 changes before exact fixture edits. Produces scripts typecheck:tests:node, typecheck:tests:desktop, aggregate typecheck:tests, and root check order production types -> test types -> lint -> source -> built process.

- [x] Capture fresh unmodified aggregate diagnostic command/exit and original TS root manifest; no fixed63 subtraction or grandfathered added diagnostics.
- [x] Partition Node ES2023+node and desktop ES2023+DOM+DOM.Iterable+DOM.AsyncIterable+node roots with the inherited strict flags/noEmit. Preserve source aliases and explicitly resolve public subpaths to source, never stale dist. No global DOM in base, any/ignore/no-check/skipLibCheck increase or test exclusions without ownership in other context.
- [x] Repair complete typed fixtures/callers with existing behavior assertions retained. Run both strict contexts to0. Baseline compiler failure is meaningful RED; no fabricated runtime bug.
- [x] Audit root union covers every original root and runnable source/process test, all fixture/setup/config roots including formerly missing test-fixtures and vitest*.config.ts; report overlap and resolved workspace paths using showConfig/listFilesOnly or compiler API. Vue SFC compilation remains separate.
- [x] Run affected runtime suites, root check/build/format and fresh separate process controls when catalog baseline skips them; source<=300; self-review/owned commit/independent review. Expected strict test types0; remaining catalog/format baseline explicitly disclosed, not green.

#### Task 17.2: Migration, durable run projections and recovery regressions

**Files:** packages/store-sqlite/src/command-disposition.test.ts; application model-execution-reads tests/new focused snapshot test; CLI local-runtime model connection/recovery process cases and fixtures; model/projection code only for demonstrated integration defect. New exact model-connections-process.test.ts can own mixed routing; existing model-recovery-process.test.ts retains accepted15.3 cases.

**Interfaces:** Consumes executeWithDisposition/execute historical receipts, ModelActivationSnapshot/RoomModelExecutionReads and accepted per-bot bindings/canonical settings. Produces stronger regression coverage and truthful known-not-sent versus unknown turn projections, no new engine/authority.

- [x] After SQLite reopen replay same admitted command through both public execute APIs and compare exact retained receipt JSON plus unchanged rows.
- [x] Add delayed journal-load/head-advance snapshot and cross-attempt category regressions without replacing one-materialization fold. Counts/null/legacy prefix and runVersion remain one committed view.
- [x] Prove separate cloud/local direct/broadcast bindings, key/model rotation and same request replay across restart, committed model start before kill/no redispatch, unknown usage versus completion. Restored maintenance owner proves all connections inert and refuses mutations; public application services over restored SQLite prove explicit reconnect of only one at that lower boundary. Full owner-confirmed rebind and ordinary-host reconnect remain 17.3. Backup/foreign-key/raw legacy receipt integrity preserved.
- [x] If known local preflight not_sent is projected as unknown/holding, demonstrate RED and fix from durable TaskRun/effect facts; actual unknown stays held. A separately addressed cloud sibling runs; failed local never falls back to cloud.
- [x] Close deferred15.3 r6 sensitive assertion diagnostics with fixed Boolean comparisons and original denied plugin.catalog read coverage alongside new mutation refusal; no assertion removal/permission relaxation.
- [x] Run strict0, focused source/process+backup gates, root check/build/format; freeze evidence, owned commit and scoped review. Real vendors/native inference remain later.

#### Task 17.3: Exact installed Linux artifact and compatibility

**Files:** apps/cli/src/release/package.ts and related release tests only for proven closure gaps; existing desktop qa/package-native.mjs/current-backup.mjs/installed-tui.py or coherent focused helpers. Product qualification docs record artifact paths/revision/hash.

**Interfaces:** Consumes exact accepted committed revision, packageRelease existing command/installed launchers, public new provider entrypoints and archive backup/rebind paths. Produces isolated candidate archive/inventory/SHA256 and installation evidence. Installed Ocean1.0/RC2 and real profiles untouched.

- [x] Create clean isolated qualification worktree of exact commit; never stash/reset/clean protected source. Reconcile pinned dependencies honestly, run required root/build/format at exact revision (catalog debt disclosed). Build actual desktop web/preload/host and use pinned Node26.
- [x] Resolve pinned Electron45 binary explicitly; validate cached/downloaded official artifact checksum/license before execution. SystemElectron39 is not equivalent. No accidental implicit package import download.
- [x] Package qualification candidate1.1.0-rc.3 without publishing, generate SHA256/inventory/licenses. Prove installed public imports for OpenAI/Anthropic/local from outside repository with no source/global NODE_PATH resolution. Audit TEST_ONLY_MODULE cleanup/fixture exclusion against actual runtime dependency closure; don't blindly ship all test fixtures.
- [x] Install into disposable prefix; offline CLI/TUI/ACP, room/history, restore synthetic1.0 profile, doctor/Python3 socket, sandbox test/typecheck/lint/build presets and resource limits. Run native gates explicitly rather than claiming skipped tests.
- [x] Use archived RC2 read-only binaries/artifacts with scratch HOME/profile for actual older-binary newer-schema refusal and update/backup/rollback. Never execute a real-profile launcher that sources credentials, in-place downgrade DB, or modify real installed release. Verify no mutation on refusal and compatible backup rollback.
- [x] Through the existing explicit owner rebind CLI/TTY decision, publish a fresh restored epoch, stop maintenance owner and start ordinary owner; explicitly reconnect only one model connection while siblings remain inert. No guard deletion, forged ready records or broader maintenance mutations.
- [x] Freeze exact artifact/evidence/commands/exits; code fixes require regression+review. This candidate is qualification input, not stable publication. F repackages after C/D/E changes.

#### Task 17.4: Native local backend and mixed-provider B acceptance

**Files:** bounded opt-in qualification helpers/product evidence docs; provider/application source only for demonstrated native integration gaps with regression and scoped review. Read task-17-native-prerequisites.md and existing controller notes; primary upstream docs/version/digest verified at setup time.

**Interfaces:** Consumes accepted local candidate qwen3:1.7b/qwen3/2.0B/Q4_K_M (actual native parameter count; tag retains its marketing name), metadata version/tags/show and model connections, actual local ProviderPort and same engine. Produces measured native/offline text+tool/usage evidence and mixed cloud/local direct/broadcast proof. Not autonomous A->B->A (D).

- [x] Prepare necessary verified backend/model under isolated qualification paths/ports without changing real services/profiles; existing user full implementation authorization persists. No marketplace/automatic install product feature. Record exact backend version/full manifest/artifact digest and positive local GGUF/tensor/capacity>=4096 evidence. No short digest qualification.
- [x] Bound CPU/memory/time and measure cold/warm response, peak RAM/swap/shared GPU (or explicitly CPU-only), exact think:false/num_ctx4096/num_predict<=512. Existing memory pressure recorded. No unsupported acceleration/peak claims.
- [x] Prove actual offline text and harmless tool round in the existing engine with available local weights/backend and no Internet path; endpoint failure and durable known-not_sent versus unknown separately. No cloud fallback.
- [x] With authorized DeepSeek source only in memory/isolation, run addressed cloud/local mixed team/B broadcast and one failed local child plus independently addressed cloud child, with request counters and exact admitted identities. Synthetic prompts only, no personal transcripts/credential printing/copy to Git. OpenAI/Anthropic live keys remain explicitly deferred, not passes; no CLI credential import.
- [x] Record actual command exits/counters/resources/full digest and precise limitations; regression/full gates after any code fix, owned commit/report and independent review. Missing or failed qualification cannot be marked passed; controller resolves setup/model choice within approved architecture.

#### Task 17.5: Native Desktop model contract acceptance

**Files:** existing desktop qa/provider-settings.mjs and focused helper(s) for negotiated settings; current-window/owner/private proof infrastructure, source only for demonstrated GUI defect. Preserve external design checkout.

**Interfaces:** Consumes accepted16 UI plus exact current installed candidate/pinned Electron45 and isolated runtime profile. Produces real visible GUI proof at1024/1280/1920 and two-client recovery, not only state tests. No StageE redesign.

- [x] Launch actual app using qualified binary/current build with synthetic HOME/all XDG/TMP/userData and absolute Wayland socket. No real profile/D-Bus/key session. Record exact code/artifact revision; rebuild/repackage after any source correction, no stale artifact claims.
- [x] Click through paginated connection selection, explicit per-bot binding/new bot/group/team choices, cloud/local/auth-none, immediate key clearing while pending, explicit check/readiness, conflict refresh/no blind retry and exact original recovery with two owner clients.
- [x] Verify actual legacy supported-host path and unsafe-host refusal; unknown/estimated/actual-zero displays, frozen admitted identity after rebind, disconnect versus cancellation, focus/escape/alerts and composer layout. No secrets in screenshots/console/browser storage.
- [x] Preserve attachments/vision/history, reconnect and closing window during generation; second client sees same run/result. Use synthetic transport for fault boundaries and label it; actual DeepSeek/local scope from17.4 is separate evidence.
- [x] Run exact final source/built/native gates after fixes, record reproducible commands/screenshots/sanitized results and review. Reconcile every parent17 item, current deferred live status and catalog root debt. Then C begins; stable release still requires finalF all-root0/current artifacts/whole-branch review.

##### Task 17.5.1: Packaged Desktop settings and native window baseline

**Files:** reuse `apps/desktop/qa/current-window.mjs`, `desktop-launcher.mjs`, `package-native.mjs`; create focused `apps/desktop/qa/model-native-session.mjs`, `model-native-seed.mjs`, `model-settings-native.mjs`. Modify `apps/desktop/src/ui/ConnectionSettings.vue`, `apps/desktop/src/ui/BotModelBinding.vue`, `apps/desktop/src/ui/ModelBindingPicker.vue` or their owning state/tests only for a reproduced defect.

**Interfaces:** consumes accepted17.4 installed root, packaged Electron45.2.1 executable and artifact manifests, plus `task-17.5-native-preflight.md`. Produce `openModelNativeSession({installedRoot, runtimeRoot=installedRoot, desktopExecutable, root, qualificationParent, resumeProfile, label, ownerHook})` returning `{page, peer, fixture, desktop, inspectMain, dispose, runCase, signal}`; `seedModelSettings(peer, {connectionCount:51, botCount:51})` returns seeded IDs for independent assertions. `peer` uses the installed public SDK entry point, not source dist or NODE_PATH; optional `runtimeRoot` selects a separately verified historical owner and its fresh compatible profile for17.5.2 while the GUI/SDK stay current. Scripts take explicit `--installed-root`, `--desktop`, `--root`; every root is fresh and owned. Later17.5.2/3 reuse this session and its bounded cleanup.

- [x] Record accepted source/artifact hashes; launch actual packaged app with private HOME/all XDG/TMP/userData, absolute Wayland socket and synthetic runtime transport. Reuse actual BrowserWindow inspector/CDP. No real key/profile, D-Bus or external design checkout. Capture actual native preferences and measured window/content/renderer bounds; renderer emulation alone is insufficient.
- [x] Seed51 connections and51 bound bots using public `setModelConnection`, `checkModelConnection`, `createBoundBot`; require final-page IDs appear and can be selected. Click cloud/local/auth-none, metadata-only opening, explicit readiness check, save one binding via `setBotModelBinding`, and verify other bot bindings unchanged through independent SDK reads. Exercise existing new-bot/group/team choices; no new team engine or StageE redesign.
- [x] Pin a discovered GUI/state defect with a failing regression in the owning existing `model-connection-state.test.ts`, `bot-model-state.test.ts` or `model-settings-recovery.test.ts`; verify RED, change only the responsible component/state, then GREEN. If no product defect, keep this a qualification task. Record the prior16 restore/new-bot/team and absent-CID/New affordance observations.
- [x] For each1024/1280/1920 target at height800, record actual native bounds, compositor visibility and screenshot; show details and composer, verify hit-testing and focused input. If the physical compositor constrains a size, record measured facts and controller ruling rather than silently substituting emulation.
- [x] Test session cleanup on launch/readiness failure and an owned surviving child with bounded retirement; unreadable process is unavailable, not gone. Required root/build/format/strict/Desktop bundle and affected process gates follow any product correction; retain C debt honestly. Repackage exact changed source, rerun affected GUI cases, commit/report and independent review.

##### Task 17.5.2: Native model mutation recovery and execution facts

**Files:** reuse accepted17.5.1 session; create focused `apps/desktop/qa/model-recovery-native.mjs`, `model-usage-native.mjs` and bounded transport-fault support. Existing `apps/desktop/src/ui/ConnectionRecovery.vue`, `apps/desktop/src/ui/ConnectionSettings.vue`, `apps/desktop/src/ui/ModelExecutionFacts.vue` and `apps/desktop/src/ui/{connection-recovery-scope,recovery-bytes,model-settings-recovery,model-execution-text}.test.ts` own reproduced defects.

**Interfaces:** consumes accepted session/artifacts. Controlled synthetic transport can delay or drop a real committed RPC response without replacing public runtime state. Two authenticated owner clients observe public `listModelConnections`, `listBoundBots`, `getRun`, `getResult`, `getRunModelExecution`; pending operation is identified by its original method/requestId/payload/revision and owning profile/context. Outputs are exact retained receipts, peer observations and GUI screenshots, not renderer-only mocked DTOs.

- [x] Hold a settings request in flight and assert the key field clears before reply. Drop its committed response, reconnect and explicitly recover the original operation; same request/payload returns the original receipt despite later metadata changes. Different payload is rejected; key resupply cannot silently change original intent. No automatic resubmit or invented completion.
- [x] In the second owner, change connection/binding revision; show conflict in the first GUI, refresh explicitly and confirm no stale write. Change room/bot/profile context and verify late feedback or recovery cannot attach to the new context. Check close/Escape/input clearing and UTF8 model-ID256-byte boundary (128 versus129 Cyrillic characters) at public validation and GUI feedback.
- [x] Render actual-zero, estimated and unknown/unavailable usage as distinct categories using real public application services and controlled provider facts. Admit a held run, rebind its bot, finish it and verify original connection/model/revision in GUI and independent run projection. Never rewrite SQLite or forge a ready epoch to seed facts.
- [x] Connect an actual historical supported host in a separate compatible profile and show the legacy path; an unsafe/unsupported host refuses mutation. Historical binary never opens a newer profile. Label every fault/provider fixture; OpenAI/Anthropic live remain deferred.
- [x] Regress and minimally fix demonstrated source defects, run required gates/repackage/affected real GUI cases as in17.5.1, then record source/artifact/commands/results and independent review. No new actual vendor requests are needed for these synthetic fault boundaries.

##### Task 17.5.3: Desktop/TUI handoff, attachments and parent B acceptance

**Files:** reuse accepted session, `apps/desktop/qa/current.mjs`, `current-assets.mjs`, `layout.mjs`, `window-close.mjs`, installed TUI/PTY support. Add focused `apps/desktop/qa/model-client-handoff-native.mjs`; source changes only for demonstrated regressions in their owning modules. Product evidence in `docs/ocean/qualification.md`; parent plan/stage summary remain controller-owned.

**Interfaces:** consumes exact accepted17.5.2 artifacts and public runtime contract; actual packaged Desktop and installed CLI/TUI share one private owner/profile. Separate client sees the original runId/result after window/client closure. Produces parent17/B gate inventory with explicit implemented/planned and native/live/fixture boundaries.

- [x] Start a held generation in the real GUI, retain committed runId, close the window, attach a second process and release the synthetic provider. Reopen and require the same run plus exactly one final answer/provider dispatch. Separately close installed TUI during a held generation and verify only client detach. Explicit cancellation remains a separate operation; neither disconnect nor process exit is confirmed cancellation.
- [x] Exercise a committed chat message whose reply is dropped; exact requestId replay gives the original receipt/run without second inference. Preserve history across runtime/window restart. This complements settings recovery17.5.2 rather than substituting for it.
- [x] Verify image preview before send/history/enlargement, file/text cards and original export by SHA256, four-files/10MB limits, persistence and reconnect. Use synthetic transport for GUI fault/vision routing and label it; actual DeepSeek/local evidence17.4 remains separate, no claim of real image understanding from fixtures.
- [x] Recheck native1024/1280/1920 with details, long history/draft and attachment chips: composer remains reachable, input focus/Enter/Escape and alerts work. Record actual bounds/compositor evidence and independent peer results; no external design checkout changes.
- [x] Run final required source/built checks after product corrections, package exact source and repeat affected native cases, freeze fresh evidence and obtain review. Reconcile17.5.1–3 plus every parent17 checkbox; old minor observations and C's3 catalog/2 format debt remain explicit. B acceptance does not imply stable release; C follows and F requires all-root0/current artifacts/whole-branch review.

## Minimal adapter decisions and live prerequisites

OpenAI: initial connection endpoint `https://api.openai.com` only (base origin, no proxy fallback); raw `POST https://api.openai.com/v1/chat/completions`, model `gpt-5.6-terra`, bearer auth, stream/include_usage, max_completion_tokens, no temperature/retries. Text+image/tools/streaming are documented; do not infer other IDs from names. Initial metadata: context 1050000, max output 128000. Honor an explicit safe-integer maxTokens in 1..128000; use 4096 only when omitted. The current engine supplies known capacity, so this omission fallback is not a production budget; add no hidden clamp. [Create](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create), [model](https://developers.openai.com/api/docs/models/gpt-5.6-terra).

Anthropic: canonical connection origin `https://api.anthropic.com` only; raw `/v1/messages`, x-api-key with a workspace-scoped key, version `2026-10-21`, initial `claude-haiku-5-5`, `thinking:{type:"disabled"}`, `output_config:{effort:"medium"}`. Unscoped keys need an explicit workspace selector not present in this first contract; do not infer scope from the key or discover a workspace automatically. Advertised context 1000000/max output 128000; explicit maxTokens 1..128000 is sent exactly, omitted uses 4096 (not a production budget). Probe one bounded `GET /v1/models/claude-haiku-5-5` with matching ID; no pagination or inference. This version removes temperature/top_p/top_k; no fallback beta/SDK retries. Native system/tool blocks, cumulative usage and message_stop. Broader signed-thinking support is out of B's first profile, explicitly refused. [Version](https://platform.claude.com/docs/en/api/versioning), [stream](https://platform.claude.com/docs/en/build-with-claude/streaming), [thinking table](https://platform.claude.com/docs/en/build-with-claude/thinking).

Local: initial qualified profile is exact `qwen3:1.7b`; other names are not implicitly supported. Ollama `/api/chat` native NDJSON, explicit auth-none or API key, metadata checks only at /api/version,/api/tags,/api/show. Candidate `qwen3:1.7b` Q4_K_M, think:false, num_ctx4096, num_predict up to512 (default512; larger/invalid explicit bounds refuse, never clamp); tag page lists 1.4GB/short digest 8f68893c685c, not a qualified full digest. Pin actual installed identity/version during live qualification. Metadata must prove capacity >=4096; configured context records the explicitly requested 4096, not observed allocation. Require positive local GGUF tensor metadata and consistent full manifest digest/details, not merely absent remote flags. This trusts the configured backend; offline/cloud-disabled operation is a separate gate. [Chat](https://docs.ollama.com/api/chat), [model metadata](https://docs.ollama.com/api-reference/show-model-details), [cloud caveat](https://docs.ollama.com/api/authentication), [candidate](https://ollama.com/library/qwen3:1.7b).

Observed notebook: i5-13420H, ~15GiB RAM, Intel UHD; no ollama/llama-server in PATH, Ollama inactive, loopback11434 unavailable, no standard model directory found. Backend/weights, full digest/version and live resource/tool/offline evidence were missing in the bounded inventory. With the user’s existing full implementation approval, prepare verified backend/weights and pinned Electron deliberately under isolated qualification paths and ports in 17.3–17.5; preserve real services, profiles and installed releases. This is qualification setup, not an automatic backend installer in the product. Missing or deferred cloud credentials do not become passed live gates. Keep DeepSeek adapter behavior and documented model metadata intact.

Решение пользователя 2026-11-04: живые проверки OpenAI/Anthropic и сбор
отдельных API-ключей пока отложены. Реализация адаптеров и проверки на fixtures
остаются в плане. Отложенная live-проверка не считается пройденной;
в B/F отдельно указать фактически квалифицированные провайдеры.

## Task 18: C. Постоянные права и готовые MCP-инструменты — приоритет 1

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

## Task 19: D. Автономные задачи и общение ботов — приоритет 1

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

## Task 20: E. Графический чат ботов — приоритет 1

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

## Task 21: F. Приёмка и выпуск приоритета 1

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

## Task 22: G. Графический клиент проектов — приоритет 2, после F

Использовать существующие project/worktree/changeset/review/apply сервисы,
тот же движок и сервер. Отдельный UX: проект → задание → ход → diff → review →
применение. Точные operation approvals остаются там, где их требует политика
владельца; автономная работа в назначенном worktree не требует каждого окна.
Критерий: полный dev → review → apply, stale changeset отказ, restart и два
клиента, без дублирования runtime. Конкретные UI-файлы — в плане G после F.

## Task 23: H. Два TUI — позднее

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
