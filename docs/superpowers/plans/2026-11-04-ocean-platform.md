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
[результаты и ограничения](../../ocean/platform-stage-a.md). B1 принят на `6633439`, B2 — на `ca25fa6`, B3 — на `14a4931`, B4 — на `72afcb3`, B5 — на `fbaa413`, B6 — на `88039a1`, B7 — на `f533252`, B8 — на `039a819`, B9 — на `d42481c`, B10 — на `05d91a8`, B11 — на `26e9a02`; прикладная часть B12 (задача 15.1) — на `caf79ec`. Серверный контракт 15.2 принят на `aa7e7ed`, межпроцессная приёмка 15.3 и весь контракт B12 — на `a42ff73` после двух раундов исправления тестовых доказательств. Настройки Desktop (16) приняты на `b5e7ece` после двух раундов исправления восстановления и асинхронных состояний. Проверка типов 17.1 принята на `4597744`, долговечность и восстановление 17.2 — на `a8d2755` после исправления гонки публикации. Установленная Linux-приёмка 17.3 принята на `652dd56` после двух раундов исправлений проверочной обвязки; исходная ревизия артефакта — `ec1e5d5`. Реальный local backend и живая смешанная команда (17.4) приняты на `de70683` после трёх раундов исправлений проверочной обвязки; исходная ревизия артефакта — `28909ea`. Установленный GUI настроек и нативные размеры (17.5.1) приняты на `ba92b56`; восстановление GUI (17.5.2) принято на `69bdf1e`; совместная работа клиентов (17.5.3) и применимые проверки B приняты на `67a7833`. Квалификационный прототип C18.1 принят на `79bbce9`; нейтральные контракты и инертное хранилище C18.2 — на `7bbb502` после одного раунда исправлений. Application/store-допуск и normal coding consumers C18.3 приняты на `b868d32`; production MCP-host C18.4 принят на `b17bf8a`, owner settings C18.5.1 — на `f1547c4`, точные подтверждения C18.5.2 — на `64c9140`, общий клиент C18.5.3.1 — на `925db6f`. Desktop и консервативный импорт C18.5.3.2 приняты на `83c0719` после двух раундов исправления. Настройки C18.5 завершены; установленная MCP-замена C18.6.1 принята на `5450b4d`; удаление Executor C18.6.2 и весь C приняты на `fa91907` после одного scoped исправления тестов. D19.1 принят на `ba6ec5c`, инертное хранилище D19.2.1 — на `698c6ba`, совместимость истории D19.2.2 — на `486df4f`, движок локального завершения D19.2.3 — на `dc78dbf`, локальное долговечное исполнение D19.2.4 — на `c3d7c21`, общий room-task host D19.2.5 — на `0f7435b` после двух раундов исправлений; нативная приёмка D19.3 принята на `62bd51e` после трёх раундов исправлений и независимых ревью; E20.1 принят на `fdb8d2b` без замечаний, исходная интеграция Desktop E20.2 — на `ccf021b` после одного раунда исправлений; установленный GUI E20.3 и этапы F–H запланированы.
Долг сохранённых регрессий Executor закрыт в C18.6: чистые root gates прошли
на квалифицированном `1f31974`; финальные проверки текущего выпуска остаются F.
Пользователь утвердил архитектуру и разрешил реализацию по порядку, commit/push/merge.
A–C приняты. Для D–F подробные task-by-task контракты уточняются перед
изменением кода. G/H имеют более низкий приоритет.
Не превращать этот документ в разрешение одновременно переписать все слои.

Рабочая база — `/home/ryltsevmg/Projects/Ocean-stable`, ветка
`codex/ocean11-stable`, исходная ревизия `438338b`. В исходном каталоге Ocean
и design-worktree есть защищённые чужие изменения. Их не stash/reset/clean.
Исходные изменения `github-session-rig.ts` и `plugin-catalog-lifetime.test.ts`
были отдельно сохранены, перенесены на MCP и приняты в C18.6; старый rig удалён
после приёмки замены. Это закрытая история, а не текущий незакоммиченный долг.

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

- [x] Сначала квалификационный прототип public MCP SDK: HTTP/stdio,
      dropped response, refresh каталога и отсутствие скрытого повторного эффекта.
- [x] Постоянная доверенная область разрешает работу без каждого approval;
      внешняя операция всё равно проходит актуальный допуск и durable claim.
- [x] Проверки restart/revoke/delayed dispatch; новые tools не получают
      неоговорённый доступ, смена endpoint/account не маскируется под token rotation.
- [x] Готовый сервер подключается конфигурацией; нет собственного плагина на
      каждый сервис. Реальный GitHub read + stdio server + synthetic write failure.
- [x] Мигрировать GitHub pilot без расширения прав; удалить Executor SDK/patch
      только после проверки замены и упаковки. Перенести смысл незавершённых
      catalog-lifetime регрессий, не объявлять старый фикс принятым.

### Task 18.1: Qualify the public MCP SDK before product integration

**Files:** create `packages/integrations-mcp/{package.json,tsconfig.json}` (private workspace package `@ocean/integrations-mcp`), `src/{index,prototype,prototype-http,prototype-stdio}.ts` and focused `src/prototype-*.test.ts`/fixture modules. Follow existing adapter package/test conventions; each source <=300 lines. Add only required workspace build/test aliases and the pinned dependency lock. No CLI/runtime import, production routing, authority migration or Executor removal in this task.

**Interfaces:** consumes current `ServicePluginTransportPort` outcome meanings and existing managed sandbox/process supervision, not SDK types in application. Produces exported `qualifyMcpPrototype(input: {root: string; githubTokenFile?: string; native: boolean})` returning a plain report `{qualified, sdkVersion, cases}`. Each case records `name`, `outcome: null | 'not_started' | 'observed' | 'uncertain'`, `status: 'passed' | 'failed' | 'unqualified'`, metadata/business attempt counts and observed synthetic effects. `qualified` requires every applicable HTTP, stdio/native and live GitHub case to pass; unavailable prerequisites remain unqualified. This is a qualification harness, not another plugin runtime or permission engine.

- [x] Verify and pin the candidate [`@modelcontextprotocol/client@2.4.0`](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0) against its full upstream commit, published tarball integrity, exported types and license inventory. The [tagged manifest](https://raw.githubusercontent.com/modelcontextprotocol/typescript-sdk/v2.4.0/packages/client/package.json) exposes root and `/stdio`, Apache-2.0 and Node >=20; compile the actual construction/call code with Ocean strict TypeScript/Node26/pnpm12.16.1. Keep SDK/server fixtures behind this adapter package; no private fields, vendor patches or custom JSON-RPC implementation.
- [x] Write counter regressions before configuring the public SDK: healthy HTTP JSON/SSE, accepted write with dropped response, 401/403/404/protocol/header mismatch, input-required challenge, invalid output and timeout/abort. Count every business dispatch separately from metadata; accepted/drop/timeout must never produce a second business call or a false not_started result. Disable implicit fulfilment, credential/scope escalation, redirects and business recovery using public options only. Include a healthy control, then run RED and configure the minimal client for GREEN.
      Counter assertions include `expect(dropped.businessAttempts).toBe(1)`, `expect(dropped.observedEffects).toBe(1)`, `expect(dropped.outcome).toBe('uncertain')` and `expect(revokedBeforeSend.businessAttempts).toBe(0)`. SDK attempted retries count even if a later host guard blocks their transmission; a guard must not hide an unqualified retry policy.

- [x] Exercise full frozen input/output tool definitions across TTL, list-changed and concurrent catalog publication. An invocation uses its admitted definition or refuses before dispatch; no hidden list/refetch/retry, cross-account definition swap or escaped SDK refresh. A separately owned explicit refresh is allowed. Reproduce the intent of the three protected catalog-lifetime tests without editing/claiming their old Executor fix.
- [x] Qualify actual Linux stdio using public SDK construction and existing containment/supervision: private environment/home/cwd, no profile/owner socket, bounded output, descendant/pipe retirement after abort and parent failure. Gate the final public fetch/stdio-send boundary after all asynchronous preparation with a synchronous current-authority check; revocation before it means zero sends, after it means potentially sent. Use small owned fixtures, record process identities and unknown cleanup honestly; do not build another process framework.
- [x] Read the already authorized `ryltsevmikhail/Ocean` technical issue5 through the real GitHub HTTP MCP endpoint using only the approved private token file, in memory. No live write, token printing/storage, credential/account fallback or real profile mutation. Separately demonstrate metadata restart/reconnect without repeating a completed/unknown business invocation. Record exact source/SDK/protocol versions, commands/exits, counters, native observations and limits under a fresh Ocean-artifacts root; no new seal framework.
- [x] Run root `pnpm check`, `pnpm build`, `pnpm format:check` once on the final worker revision, plus covering prototype/native/live checks. Existing C catalog3/format2 debt remains explicit, not excluded. Report whether the public SDK qualifies before enabling production, commit only owned source/config/proof prose and obtain independent review. If public hooks cannot meet the contract, return the concrete counterexample to the controller; do not compensate with private protocol interception.

**Remaining C sequence after 18.1:** 18.2 neutral contracts/minimal durable schema; 18.3 grant/journal/catalog admission and coding bypass; 18.4 production adapter/host wiring; 18.5 conservative migration and owner/client settings; 18.6 installed replacement/live/package acceptance and Executor removal. Expand the next checkpoint against qualified prototype evidence before changing its code, preserving the five parent18 requirements. Do not freeze speculative schema or mirror the whole MCP API in advance. Schedules, Sources, marketplace and universal OAuth remain outside C.

### Task 18.2: Neutral authority contracts and additive durable storage

**Files:** create domain `service-connection.ts`, `service-catalog.ts`, `owner-scope-grant.ts`, `effect-resource-scope.ts` and focused tests; application `service-authority-ports.ts`; SQLite `service-authority-{schema,storage,rows}.ts` and tests. Export through existing package entries; extend `SqliteStore`/factory, schema/migration checks and fixtures. Split cohesive files only to retain300 lines; no SDK dependency in domain/application and no runtime/CLI/UI activation in this task.

**Interfaces:** domain exports `ServiceConnection`, `ServiceTrustBinding`, `ServiceToolDefinition`, `ServiceCatalogSnapshot`, `OwnerScopeGrant`, `OwnerGrantReference`, `OwnerResourceScope`, `EffectResourceScope` plus strict validators. Application exports `ServiceAuthorityStorePort.atomic(work)` and `ServiceAuthorityTransaction` with `connection/listConnections`, `putConnection(record, expectedVersions|null)`, `catalog/putCatalog`, `publishCatalog(connectionId, expectedVersions, snapshotId)`, `grant/listGrants` and `putGrant(record, expectedRevision|null)`. `SqliteStore.serviceAuthority` implements that port on its existing database connection. Expected connection versions are `{configRevision, trustRevision, credentialRevision}`; initial creation uses null, stale replacement returns `false` atomically; callers must check the boolean result. Read methods return readonly records or null; put/publication methods are synchronous. `OWNER_SCOPE_POLICY_VERSION=2` distinguishes new grants from the legacy policy. Report exact finalized type fields/signatures for18.3, not SDK types.

- [x] Write domain regressions for HTTP versus pinned stdio configuration, secret references only, full tool definitions (input/output schema/annotations), explicit unverified identity, and versioned owner grants. Grants contain owner provenance, workspace/room/bot subject, optional project/task narrowing, explicit coding/service permissions/resources, autonomous or confirm mode, limits and revision/state. Tool policy is exact/current-set/all-including-future (last explicitly selected); default does not grant future tools. No token bytes, SDK/session identity or entire catalog digest as owner authority. Generic narrower resource enforcement needs evidence; declarations alone are not verified account/resource facts.
- [x] Implement these plain bounded contracts/validators. Reuse existing 256-tool/4MiB catalog bounds, moving neutral constants to domain and re-exporting if needed without changing legacy behavior. Resource types cover connection/account, GitHub repository and project/worktree; effect scope additionally has an explicit legacy-global unknown. Missing effect scope never means an empty/no-conflict set. Preserve legacy domain/API types unchanged until their consumers transition.
- [x] Add migration24 after confirming current schema23. Use three new durable tables: `ocean_service_connections` (configuration, trust and credential binding revisions in one record), immutable `ocean_service_catalogs`, and `ocean_owner_scope_grants`. Store bounded validated JSON for the logical policies rather than a table for every concept; no credentials or ephemeral session/PID/readiness. Keep every old plugin/consent/grant/approval/claim row unchanged and create no new active grant from migration. No automatic legacy conversion or metadata permission expansion;18.5 owns that explicit operation. Effect-journal enforcement/migration remains18.3 on the existing journal, not a second ledger.
- [x] Implement transaction-local read/create/CAS operations and immutable catalog publication. Matching config/trust/credential versions plus matching connection are required for a current-pointer update; stale/partial/invalid snapshot leaves it unchanged. Whole-catalog changes do not themselves revoke grants. Grant revisions cannot regress or be overwritten by a stale writer. Callback is synchronous, rolls back on error, and a captured transaction cannot write after it ends; do not create a generic transaction framework.
- [x] Test fresh/open/reopen and23→24 fixture migration, newer-version refusal, unchanged legacy row snapshots and unresolved global holds, foreign-key integrity, two-reader stale CAS, cross-connection catalog refusal, immutable snapshot conflict, rollback and transaction lifetime. Include a grant for a generic third server and one coding permission without GitHub dummy fields; no execution/admission implied. `expect(reopened.serviceAuthority...revision).toBe(2)` and stale revision1 update must refuse without changing either policy or catalog pointer. Test SDK/credential/session changes do not rewrite a stored grant; actual authorization/eligibility remains18.3.
- [x] Run owning domain/store tests RED→GREEN, strict main/test compilers and root `pnpm check`, `pnpm build`, `pnpm format:check` once on final source. Preserve known catalog3/format2 debt and protected files; new failures must be fixed. Record schema/type/port signatures, commands/exits and conservative staging; commit and obtain independent review before18.3. No native/model/GitHub/GUI repeats or production adapter enablement required for this pure contract/storage step.

C18.2 accepted on `7bbb502`: empty dense stdio argv and `env:NAME` credential handles only at this inert stage; concrete safe launcher forms remain18.4. Authority arrays reject holes, refused async callbacks cannot escape as unhandled rejections. Owner decisions and execution remain unimplemented in this store. Root run at787946c recorded3454 passed/4 failures/44 skipped; the fourth architecture assertion was corrected with14 focused passes, and correction7bbb502 has24 covering passes/strict compilers/lint/format. Two review Minors (Unicode canonical key order and churn assertions) remain for whole-branch triage. No new full-root green result is claimed.

### Task 18.3: Current owner authority, scoped effects and coding bypass

**Files:** create domain `service-permissions.ts` and `effect-resource-conflicts.ts`; application `owner-scope.ts`, `service-admission.ts`, `service-admission-types.ts`, `service-catalog-policy.ts` and focused tests. Extend accepted `service-authority-ports.ts`/SQLite adapter and existing `tools.ts`, `tool-journal.ts`/reads/resolutions, coding approval/dispatch/admission/finalization consumers and tools-node dispatch boundary where required. Reuse existing records, ports and transaction helpers; split only cohesive responsibilities to retain300 lines. No SDK/CLI/UI production activation, new journal, task scheduler or generic policy framework.

**Interfaces:** consume accepted C18.2 types and same-DB `SqliteStore.serviceAuthority`. Produce `OwnerScopeService` (trusted-owner create/revise/revoke, no model mutation capability), `ServiceCallAdmissionService.call` (room/bot/task scope + grant reference + connection/catalog/tool/arguments + invocation identity), and plain `ServiceCallTransportPort.invoke` with caller signal/deadline, full frozen tool definition and synchronous `authorizeDispatch():boolean` at the actual send boundary. Reuse existing observed/not_started/uncertain outcomes. Extend the existing journal claim with optional trusted `ToolEffectAdmission` containing `scope:EffectResourceScope`, `effectKind:'observation'|'mutation'`, `grantReference:OwnerGrantReference|null`, `binding:ServiceJson`; add synchronous/asynchronous conflict inspection for admission. Missing legacy metadata stays a global unknown. Report finalized constructor/request/store signatures for18.4; SDK types never cross application.

- [x] Add RED regressions for owner-only issue/revoke, autonomous versus confirm mode, exact workspace/room/bot and task/project intersections, expiry/limits, persisted grant reference and same-id/different-request refusal. New owner scope defaults autonomous only after explicit trusted-owner issuance; absence/revocation is never permission. Model-supplied authors/grants/evidence do not establish authority. Owner RPC/capability/receipt exposure remains18.5.
- [x] Implement per-tool eligibility against immutable approved definitions. Add an optional `baselineCatalogId` to service permission intent (absent legacy/inert v2 is ineligible for exact/current-set until owner issues a baseline); owner issuance materializes exact/current names against the current complete snapshot. Compare only selected full tool definitions plus current trust/resource facts, not the whole catalog digest or SDK provenance. An unrelated tool is neither granted nor grounds to revoke existing rights; changed/missing selected tools suspend only affected eligibility. Explicit all-including-future remains broad opt-in subject to resources/limits/trust. Definition/schema equality is not proof of remote semantic/account continuity.
- [x] Separate current config/trust/credential binding from session readiness. Endpoint/account/resource-scope expansion suspends old eligibility or advances trust; token-reference text alone does not prove continuity. Retain grants during session loss/restart; metadata refresh needs persistent owner metadata permission and publishes matching complete tuples atomically. Failed/stale refresh retains historical data but cannot activate it; frozen calls do not switch snapshots/routes/accounts. Keep trust unverified honestly; no new identity/OAuth proof framework.
- [x] Extend the EXISTING v2 effect journal with validated bounded scope/access/authority-binding evidence, allocating schema25 only after rechecking24 and handling the lazy/absent journal table. Preserve every original id/fingerprint/outcome/resolution; old callers without metadata keep their conservative behavior. Pending/history views keep unknown facts, acknowledgements never create replay permission. Tests cover fresh/reopen/migration/rollback and the source backup/version barriers touched by this addition. No installed/native qualifier now.
- [x] Implement conservative resource conflicts and actual consumers. Known disjoint project/worktree or qualified repository resources can proceed independently; aliases/case and broader selectors must not manufacture disjointness. Absent/unproven scope remains global; resource strings and MCP annotations alone are not enforcement evidence. Only trusted host classification can label a safe observation and permit reconciliation without clearing the original unknown mutation hold. Keep legacy holds and replay protection intact. Do not merely remove global guards from ToolService/coding admission.
- [x] Admit a service call in one immediate transaction: re-read current membership/grant revision/mode/trust/catalog/limits/task scope, persist its immutable binding and durable existing-journal claim, commit, then invoke once. The final synchronous transport guard rechecks current authority after all async preparation; revocation before send gives zero sends/not_started, after send may be uncertain. Close timeout/abort invocation lifetime so no late continuation dispatches. Settlement is durable and never retries an unknown effect; same claim cannot dispatch again across restart.
- [x] Integrate autonomous worktree edits and registered test presets through existing exact coding approval binding/consume/claim/evidence/finalization path. Store the owner grant reference as the decision basis; do not fake a human decision or introduce a second approval ledger. Autonomous mode calls no owner prompt; confirm/no-new-grant retains the existing owner path. Recheck current grant, membership, task capabilities, original/worktree leases, source/toolchain/limits binding and conflicts before consume and the actual worker dispatch boundary after preparation. Review remains read-only/no commands, restored quarantine stays closed; source-project apply keeps its separate exact owner/review/changeset checks. Commit/push/deploy selectors do not silently add executable backends or host access.
- [x] Use grant `maxCalls` as a durable per-TaskRun allowance counted from claims by grant id (revision/credential churn does not reset it); D19 adds shared root/delegation budgets. Bound canonical prepared payload bytes with `maxEffectBytes`, without claiming to bound unobservable remote effect volume. Existing per-turn/output/command/sandbox limits still intersect this allowance. No new counter/queue service.
- [x] Demonstrate with deterministic domain/application/SQLite and small host-boundary fixtures: grant survives reopen/session loss; unrelated catalog growth; current/future policy; stale catalog/trust refusal; two competing claims; suspend-before-send revoke/abort/timeout with0effects; sent/drop uncertain with1effect and no retry; independent qualified scope+safe reconciliation while conflicted mutation blocked; legacy global hold preserved; automatic edit/test with0prompts and exact-binding/grant revocation races blocked; finalization evidence remains valid. Use real disposable store/claim tests where persistence matters, no real profiles/keys/service/model/native/GUI repeats.
- [x] Run covering RED→GREEN and strict main/Node/Desktop test compilers, then root `pnpm check`, `pnpm build`, `pnpm format:check` once on final source. Keep protected catalog3/format2 debt explicit until18.6; fix new errors, do not skip tests. Commit owned source/docs/report and get independent task review before18.4. This checkpoint is application/store/dispatch semantics, not qualification of the not-yet-wired production MCP host.

### Task 18.3.1: Connect normal coding consumers to qualified resource conflicts

**Why required:** C18.3 core correction `af343c6` passed scoped review, but a disposable real-store probe exposed a remaining product gap: after a guarded uncertain write in A, disjoint B has0journal conflicts while normal `CodingTaskService.authorize` refuses and B finalization reports2global holds. Parent18.3 is not accepted until this integration passes. Reuse the current journal/receipt/resource rules; this is not a new feature or authority engine.

**Files:** modify application `coding-service.ts`, add its small `coding-resource-scope.ts` helper, update `apps/cli/src/runtime.ts`; adjust SQLite `coding-finalization-store.ts`, `coding-finalization-claims.ts`, `tool-journal-reads.ts` only as required to reuse accepted effective-admission/receipt checks. Add `apps/cli/src/coding-turn-factory.test.ts`, `packages/store-sqlite/src/coding-consumer-scope.test.ts` and focused lifecycle/finalization regressions in owning fixtures. Keep every source<=300; no SDK, UI, schema, counters or scheduler.

**Interfaces:** preserve `CodingTaskService.authorize(access)` and its `executionEnabled:false` result. Add optional trusted `CodingServiceDeps.projectId(canonicalRoot):string`, composed by the durable runtime with the same SHA-256 UTF-8 canonical-root identity as existing coding admission. An absent ID mapper, conflict inspector, canonical target/lease/worktree facts or invalid mapping retains legacy global fallback. Export plain `codingResourceAdmission(projectRoot, projectId, worktree?:{id,root}):ToolEffectAdmission|undefined` solely as a conflict probe: mutation, null grant reference, known project-wide selector plus the known worktree selector, canonical root facts. It never grants or persists execution authority. Reuse existing effective journal evidence, never infer narrow scope from unguarded claim strings.

- [x] Reproduce RED at the real normal factory/service boundary with actual SQLite/approval/journal and only a scripted platform backend. Guarded A is uncertain after1effect; B has distinct qualified project/worktree facts,0journal conflicts, yet factory/authorize currently refuses. Add an actual finalization-service regression: B preview/owner-confirmed finalization remains blocked only by A today. Record the failure before changing consumers; no native qualifier or second engine is needed.
- [x] Use current resource conflicts in `CodingTaskService` when trusted canonical target facts are available. Check membership, capabilities, policy, restored state and live original/worktree leases as before; authorization still creates no executable capability. The normal `codingTurnFactory` and per-call `CodingTurnTools.admit` must reach guarded B edit/test dispatch rather than failing at a global precheck. A conflicting mutation still sends0, and legacy/unqualified approval paths stay global through request/decide/consume/claim. Do not replace a global gate with an unchecked boolean.
- [x] Apply the same scoped conflict selection to existing start/cancel lifecycle gates where the operation's canonical resource is known. Before project inspection there is no trusted requested-path scope: keep legacy/unscoped holds conservative; a qualified disjoint effect may allow read-only project inspection, but recheck inspected/current scope before owner decision/lease or state mutation and after awaits. Preserve owner reserve/cancel approval, request replay, project cleanliness, lease and unknown-release semantics. If target facts cannot establish independence, refuse conservatively.
- [x] Filter finalization holds using B's current canonical leased project/worktree footprint. Keep B's own provider/approval/review/cleanup/evidence holds. A different task's unquiescent coding claim may be excluded only with its exact guarded receipt and trusted footprint demonstrably disjoint from B, using the accepted effective-admission helpers. Missing/orphaned/contradictory/unguarded/legacy receipts remain global. Never settle, acknowledge, rewrite or erase A to unblock B; no replay or confirmed-cancellation inference.
- [x] GREEN must show through the normal factory: B reads/edits/runs a registered preset and obtains a result without a prompt under its owner grant while A stays uncertain/spent; conflicting B fails with0effects. Show B owner-confirmed finalization disables/releases only B, preserving A bytes/outcomes/claims/allowances/holds. Include same-root/alias/nesting/equal-ID contradictions, lease loss/revoke/restored/review refusal, late conflict after preparation/owner await, and no-inspector/ID-mapper fallback. Reuse existing test helpers and exact receipt rules. Source-project apply retains its separate legacy exact owner/review/changeset path and global fallback; do not add apply bypass/metadata or remote qualification in this follow-up.
- [x] Run covering RED→GREEN, strict main/Node/Desktop compilation and scoped lint, then required root `pnpm check`, `pnpm build`, `pnpm format:check` once on final source. Retain protected catalog3/format2 debt and record process-phase reachability honestly; resolve new failures. No old native/model/GUI or unchanged positive-root loops. Commit explicit owned source/report, obtain independent review, then accept18.3 as a whole and proceed18.4.

C18.3 accepted on `b868d32` after core and normal-consumer independent reviews, one correction round each. Source qualification uses scripted transport/platform/registry with actual SQLite/application; physical sandbox/stdio, live HTTP, owner RPC and installed migration remainC18.4–6/F. Latest actual root run atdcb1982:3584 passed/3 protected catalog failures/44 skipped, process phase not reached; build0/formatprotected2. Correctionb868 has226 covering passes and strict compilers/scoped lint/format0. Source-project apply retains the separate legacy exact owner/review/global-refusal path. Deferred duplicate finalization reads join the earlier Minor list for whole-branch review.

### Task 18.4: Production MCP adapter and runtime host

Keep one Ocean owner and one agent loop.18.4.1 delivers the qualified transport/session/managed-stdio boundary;18.4.2 then connects normal room tools/runtime lifecycle and process contracts. Expand18.4.2 against the accepted adapter interfaces. This split creates no permanent second backend: Executor stays only for the explicit development/migration path until18.5/18.6 replacement, and no invocation falls back between them. Installed replacement qualification and Executor removal remain18.6. Packaging inventory must advance with the first production imports in18.4.2; do not claim an installed MCP artifact while the temporary package exclusion remains, or introduce a universal/multi-backend collector merely to preserve inactive development code.

- [x] Accept18.4.1 production adapter, current-owner send hook and managed stdio, source/native/live qualified within the approved scope.
- [x] Accept18.4.2 normal runtime composition and collision-safe granted tool source; prove real shared execution path with scripted provider/process fixtures.
- [x] Reconcile all source, native and live evidence/limits before18.5 owner/client migration; no broad old-positive-gate repeats or new process framework.

### Task 18.4.1: Production public-SDK transport and managed stdio

**Files:** evolve `packages/integrations-mcp` into private production workspace package `@runnets/integrations-mcp`, root exports only production API and `/qualification` exports the retained prototype. Add cohesive `src/{transport,session,http,stdio,catalog,send,profile}.ts` and focused tests/fixtures as required; reuse/extract accepted public SDK settings and invocation lifetime rather than a second divergent profile. Add only necessary tools-node managed-stdio launch/guardian helpers/public exports and targeted shared-supervision changes. Update manifest/lock/workspace aliases only as needed; preserve SDK2.4.0 and source<=300. No runtime tool-source/UI/schema/legacy migration/Executor removal in this leaf.

**Interfaces:** export `createMcpServiceTransport(options:McpServiceTransportOptions):McpServiceTransport`; the instance implements accepted `ServiceCallTransportPort.invoke(ServiceCallInvocation)` and owns `discover(connection, options):Promise<McpCatalogCandidate>`, `activate(candidate,snapshot,confirmPublished:()=>boolean):boolean`, `disposeCandidate(candidate):Promise<McpCleanupEvidence>` and `close():Promise<McpCleanupEvidence>`. Discovery options carry signal/deadline and synchronous current-owner metadata authorization. Candidate exposes bounded plain connection versions/tools/protocol/provenance, with ephemeral adapter-owned identity; it is not owner authority or persisted SDK state. A candidate activates only after exact durable catalog publication/current tuple proof. Cleanup evidence distinguishes confirmed retirement, never started and unknown; report exact finalized fields/options for18.4.2. Credential leases and Linux handles stay in adapters, never domain/application/SQLite/model DTOs.

- [x] Write RED controls against the production class for default unsafe retry/redirect/implicit refresh behavior and missing activation/send guards. Configure only public client2.4.0 root/stdio APIs: no private fields, vendor patches, custom JSON-RPC/parser or business fallback. Carry the full admitted tool definition, immutable target and credential lease, close each invocation before timeout/abort returns, and call current owner authority at final fetch/stdio writer after all async preparation. SDK attempted retries count even when a guard prevents transmission; never hide an unqualified retry policy behind blocked bytes.
- [x] Implement bounded explicit discovery/session activation. Complete catalogs preserve full input/output/annotations and definition digests; unsupported or malformed metadata cannot masquerade as empty/complete. Calls never initialize/list/refetch/reconnect or switch account in their own invocation. TTL/list-changed schedules only separately owned, bounded/joined metadata refresh; actual refresh composition comes18.4.2. Losing a session suspends readiness, not durable grants. Concurrent candidate publication and credential/endpoint changes cannot activate stale sessions or mutate an in-flight definition.
- [x] Resolve only explicit credential references into immutable private leases; no fallback account/environment sweep/OAuth/input fulfilment. Literal credentials remain refused in config/argv/URLs. Extend inert stdio configuration only for concrete non-secret pinned launcher/artifact/argument/cwd/isolation forms required by the qualified ready-made server. Use private environment at actual sandbox spawn (SDK env alone merges defaults), no profile/socket/host-home/root mount, no secret argv/stdout/stderr/model/log persistence. Client/profile and account/resource trust remain distinct; do not certify account continuity from token/schema/server display name.
- [x] Keep the trusted SDK client and final authority callback in the runtime-owner process; isolate only the untrusted stdio server. Reuse existing Linux namespace/cgroup/toolchain/supervision primitives; a small trusted stream/lifetime guardian is permitted where interactive stdio needs it, not a second authority/process framework or protocol shim. Bound sessions, RAM/processes/time/frames/stderr and observe actual enforcement. Parent death, abort, leader exit and inherited descendant pipes must retire the whole owned tree or report unknown and keep execution disabled. Prove restart/old-owned-unit handling without assuming SDK.close or a missing leader proves cleanup. Do not stop unrelated profile/system units.
- [x] Qualify an actual ready-made stdio package by configuration, not an Ocean service-specific implementation: candidate official `@modelcontextprotocol/server-filesystem@2.2.0` (Node>=24, published license `SEE LICENSE IN LICENSE`, Apache/MIT transition). Verify exact tarball SHA-512/source/provenance facts/license inventory and pinned dependency closure before execution; preserve permissive notices and do not claim MIT-only or an independent signature audit. Use an owned artifact/workspace, offline server profile and explicit allowed directory; read/write/control/escape tests must not touch real user files. Separate synthetic HTTP and stdio accepted-write/drop tests append independent dispatch/effect records to prove one send/effect and unknown with no retry; strengthen exact header-pair coverage from the parked C1 Minor.
- [x] Exercise production invoke through actual SQLite `ServiceCallAdmissionService` for delayed revoke/cancel/deadline0sends, sent/drop/invalid-output uncertain1send, candidate races, catalog growth/TTL, overflow and cleanup-observation failure. Native scenarios use actual new adapter and public SDK, ready-made server plus small owned fault fixtures, private HOME/all XDG/TMP and current Node read-only mount; record unit/cgroup/PID-start observations and measured limits. No hidden wrapper only claiming to test production. Do not repeat unchanged prototype native/live positives.
- [x] Perform one approved production-adapter GitHub read of technical `ryltsevmikhail/Ocean` issue5 using only the approved0600 PAT file in process memory. No token argv/env/copy/log, gh credential fallback, live write, other service/model requests or real profile mutation. Unverified identity stays honest; a test's explicit broad connection grant is not a migration/expansion of old narrow grants. Missing access is live-unqualified, not a synthetic pass; complete independent checks and report the concrete blocker.
- [x] Run covering RED→GREEN and strict main/Node/Desktop compilers, then root `pnpm check`, `pnpm build`, `pnpm format:check` once on final source. Keep protected catalog3/format2 debt until18.6 semantic port; fix new failures, no skips/exclusions. Native proof uses one fresh direct child under Ocean-artifacts with source/dependency/command/result pins and truthful cleanup, no new seal/QA framework. Commit owned source/report and obtain independent task review before runtime composition18.4.2.

C18.4.1 accepted on `165e1c0` after full review and two scoped correction rounds. Production transport/managed stdio are qualified through public SDK2.4.0; the normal runtime is not switched until18.4.2. Official filesystem2.2.0 and the sole production GitHub read retain source18013a3; native fault counters and affected coding controls were qualified at8bb0d38, final numeric literal correctionf6be7d9 has28 covering passes. Unknown cleanup suspends held writers; preflight caller deadlines retain capacity until drainage. Original full-root e744fd7 has3624pass/3protectedfail/44skip/process-unreached/build0/formatprotected2; scoped corrections are not a new root aggregate. M1 credential zero-call assertion andM2 duplicate JSON freezers remain final-review debt. Actual installed replacement/legacy migration/Executor removal remain18.5/18.6.

### Task 18.4.2: Connect MCP to the existing runtime and room tool loop

**Files:** application `src/{service-turn-tools,service-turn-tools-schema,chat-turn-tools}.ts` and focused tests, `chat-turn-execution.ts`/public exports; CLI `src/{runtime,runtime-types,runtime-services}.ts`, `local-runtime/{host,host-options,host-plugin,settings-hosts,broadcast}.ts` and owning process/room tests; production dependency manifest; `release/{bundle,package,installer}.ts` and owning packaging tests; minimal adapter readiness/stdio enrollment and domain configuration additions. Reuse existing service authority, journal, coding factory, client and drain supervision. Keep legacy SDK source/patch and protected2 for18.5/18.6; no UI or owner RPC/migration in this leaf.

**Interfaces:** add application `ServiceTurnTools implements GrantedToolSource` with `forTurn(turn:ChatTurn,signal:AbortSignal):Promise<GrantedPluginTools|null>`. Options receive `ServiceAuthorityStorePort`, `Pick<ServiceCallAdmissionService,'call'>`, trusted owner/time/restored facts, `sha256(text):string`, trusted `subject(turn):OwnerScopeGrant['subject']|null` and `ready(connection,catalog):boolean`. Reuse public `ownerGrantApplies`, `currentServiceCatalog`, `eligibleServiceTool` for projection; current C3 admission remains the only dispatcher/claim/budget owner. Add only `McpServiceTransport.ready(connection:ServiceConnection,catalog:ServiceCatalogSnapshot):boolean` for actual ephemeral readiness, never authority. CLI `composeRuntimeServices(input):RuntimeServices` owns the transport and exposes `tools`, `start():Promise<void>`, `refresh(connectionId,signal?):Promise<ServiceCatalogSnapshot>`, `drain():Promise<'settled'|'uncertain'>` plus existing trusted owner scope service for future18.5 composition. Exact constructor input fields follow the existing runtime stores/options; no raw owner capability is exposed over a client/model channel.

- [x] **RED: normal granted tools.** In owning application/CLI tests, show a real normal `runTurn`/chat path has no neutral MCP tools yet. Use actual SQLite current grants/catalog and a public-SDK HTTP fixture. Two connections with the same raw name must yield separate stable provider-compatible aliases; forged route, absent/revoked/expired/foreign-room grants, unavailable/restored/review-continuation state and changed approved definitions must send0. Exact repeated call identity/payload returns its original outcome; changed payload with that identity refuses. Test before-provider projection while ChatTurn is still accepted: it must not prematurely require the dispatching-only `runMatches` check or create a claim.
- [x] **GREEN: one neutral source.** Read eligible subject/grant/current definitions through ports, freeze selected route/grant reference/tool facts, and pass only bounded tools to the existing loop. Alias is `mcp_` plus the first56 lowercase hex digits of trusted SHA256 of canonical `[connectionId,rawToolName]`; explicitly refuse a hash/name collision rather than first-wins routing. Derive invocation ID from a stable hash of the real taskRun/attempt/call identity, not model authority fields; do not truncate IDs into collisions. Parse bounded JSON object arguments and call C3 with frozen route/current run context. Reuse16 per-turn calls and32KiB model output bounds; durable per-grant allowance stays in C3. Unknown outcomes and claim/settlement ambiguity retain uncertainty and stop the existing loop; a refused current claim does not prove an earlier effect never started. No second journal, provider cycle, model approval or automatic effect retry. Generic account/resource classification stays conservative unless a trusted enforcing fact exists; no account proof from labels/annotations.
- [x] **Combine coding and service tools.** Replace the current either-coding-or-granted conditional with one small existing-loop composition. Retain coding preparation/role/worktree/lease checks; a coding refusal cannot fall back to service-only execution. Broadcast children still get no coding authority. The same turn can read its assigned worktree and invoke an explicitly granted service without an extra owner prompt; coding review continuations retain immutable-artifact-only execution. Check duplicate visible names and exact invocation identity across constituent sources. Trusted subject resolution uses the actual workspace/task/project, matching existing SQLite `runMatches`; never select a grant's project/task fields as the source of actual context.
- [x] **Bind ephemeral readiness and durable stdio target.** Implement the small adapter ready query from current active usable session/tuple/route, with no I/O and no grant semantics. Add optional plain absolute `workspaceRoot` to the stdio configuration, included in exact validation and canonical route/trust revision checks. Old inert rows stay valid but normal production host refuses stdio without explicit enrollment. Actual production workspace derives from the frozen durable configuration. Preserve the qualified fixture mapping only as an explicit host injection and refuse contradictions; never silently pick a profile/home/host directory. Use the existing native canonical-path/pin protections and fixed mount targets. No new table, mount list, registry or credential manager.
- [x] **Own metadata in the existing runtime.** Construct transport after profile ownership/store opening; recover existing claims/turns before external discovery. Only the long-lived shared host explicitly calls start: generic profile readers/direct ACP must not gain discovery side effects from opening a profile. Startup/reconnect and TTL/list-changed refresh use previously granted current metadata trust, a bounded/coalesced per-connection owner job, and begin/publish/current tuple helpers; no discovery in forTurn or invoke. Confirm actual persisted snapshot content/current metadata authority in a synchronous owner transaction before activation. Publication races dispose the candidate truthfully. Metadata failures expose unavailable readiness, leave grants unchanged and never retry a business effect. Session/candidate capacity refusals stay explicit, with no unbounded queue, eviction of an admitted call, new instance fallback or hidden account change.
- [x] **Lifecycle and compatibility.** Direct chat and broadcast use the same source/runtime; the authenticated server remains the only owner for simultaneous clients. Join metadata, calls and transport cleanup through existing drain supervision before closing SQLite. Startup failure/stop during preflight must not discard pending work or call cleanup confirmed without evidence; blocked OS I/O can keep stop incomplete. Owner socket/client disconnect never cancels a service invocation by itself. Legacy plugin metadata/history remain available; legacy SDK execution survives only an explicit dev/test path and cannot run or reconnect as fallback. Neutral owner config/grant/confirm RPC and old-grant migration remain18.5, so confirm-mode calls retain explicit confirmation_required/0send here. ACP and ordinary no-plugin CLI behavior must remain compatible; no new wire raw-store/transport authority.
- [x] **One production bundle.** With first CLI imports, make `@runnets/integrations-mcp` the single active packaged adapter; pin public SDKclient/core2.4.0 and existing Rolldown1.2.16, preserve dependency/license/hash inventory, builtin/first-party external guards and standalone installer checks. Exclude dev-only legacy SDK/qualification entry/server SDK/bundler/fixtures from installed runtime, not through a universal collector or dual backend. Move inactive legacy composition outside shipped imports where necessary; retain source/patch for later migration qualification/removal. Historical Executor archives must still pass their exact supported installer validation for rollback; accepting a historical artifact is not a runtime fallback. Add bundle/inventory/isolated import and tamper controls. Installed full replacement/live/upgrade qualification remains18.6/F; do not ship broken dependency references meanwhile.
- [x] **Prove the normal process path.** Use fresh private profile, actual shared runtime/socket, independent client process and scripted provider: granted HTTP and isolated stdio calls reach the same C3/SDK path, persist a claim before receipt/effect, return a bounded result and produce one final answer. Include a prepared held call whose grant revokes, sent/drop uncertainty with no second business or model attempt, a catalog refresh while the original call is held, runtime stop/failed startup with joined metadata, and restart seeing the existing unknown journal without replay. Test ordinary CLI same-profile refusal/connection behavior and ACP. Use owned synthetic fault servers; one affected native normal-host stdio control against retained pinned server inputs is sufficient, plus changed enrollment/cleanup negatives. No unchanged B/C native matrix or real GitHub/model requests.
- [x] **Verify and commit.** Run covering RED→GREEN, strict main/Node/Desktop and scoped lint, then one root check/build/format on the final implementation before review. Preserve protected catalog3/format2 debt until18.6 semantic port and report exact process-phase reachability; fix new failures. Run affected release/process checks separately if root stops at protected source failures. Source files<=300. Record final public API/normal-host and packaging proofs, original source pins/limits, remaining18.5/18.6 scope; commit owned files/report and obtain independent review. Source qualification is not stable-release acceptance; continue in order.

C18.4.2 accepted on `d35e28a` after full review and two scoped correction rounds.
Normal runtime/tools, metadata, joined lifecycle and one MCP bundle are qualified.
Native normal-host evidence retains `f604249`; process corrections `1e6d6ca`,
standalone `a060c24`, final source-only helper correction `b17bf8a`.
Archive SHA-256: `53e1500796920333c52dcaf880a51f66b797bc062071e3b7538f55c584de04b9`;
it predates `b17bf8a` and is not a final installed-release candidate.
Root remains3654pass/3protectedfail/44skip/process-unreached/build0/format-protected2
at its recorded earlier pin, not a new aggregate. Deferred M1–M4 go to F.
Parent18.4 is complete within this scope.18.5 owner/client settings, exact
confirmation and conservative migration follow;18.6 owns installed/live/removal.

### Task 18.5: Owner settings, exact confirmations and conservative migration

Keep one neutral authority and the existing authenticated owner socket. Three
reviewable deliverables:18.5.1 usable owner configuration/grant API;18.5.2 exact
service confirmation through current durable decisions;18.5.3 thin clients and
legacy migration. No second credential manager, permission engine, journal,
marketplace, arbitrary package installer or universal OAuth. Do not remove
Executor/protected2 until18.6. E still owns autonomous-team GUI, not this settings
surface. Each child expands only against its predecessor's accepted interfaces.

#### Task 18.5.1: Durable owner service settings and credential binding

**Files:** application `service-owner-settings.ts`, focused connection/request/view
helpers and tests beside existing `owner-scope.ts`, `service-authority-ports.ts`;
domain `service-connection.ts`; SQLite service-authority storage/schema and
migration/restore tests; contracts `local-services.ts` plus validators/exports;
CLI `local-runtime/services.ts`, existing server/settings composition,
`runtime-services.ts` and owning socket/process tests. Reuse tools-node private
`createProviderSecretStore`/0700-0600 persistence and existing injected SHA256.
Do not generalize or rename the provider credential subsystem to do this.

**Interfaces:** application `ServiceOwnerSettings` owns trusted owner/time/hash,
existing service authority and the private secret-store port. It exposes keyless
`connections()`, `grants()`, `receipt(requestId)`, `setConnection(request)`,
`disconnect(request)`, `refreshConnection(request,signal?)`, `setGrant(request)`
and `revokeGrant(request)`. Refresh consumes the existing host metadata port.
`RuntimeServices` exposes this owner-only facade and its existing explicit
`refresh(connectionId,signal?)`; never serialize stores/transport/OwnerScopeService.
Advertise `service.authority-v2`. Owner methods are `service.connections`,
`service.grants`, `service.receipt`, `service.connection-set`,
`service.connection-disconnect`, `service.connection-refresh`,
`service.grant-set`, `service.grant-revoke`. Exact request validators reject extra
keys. Mutations carry requestId and expected current connection version tuple
or grant revision (null only for creation); runtime injects owner identity.
Connection-set is `{requestId,connectionId,expectedVersions,name,configuration,
metadataPermission,key?,removeKey?}`; key and removeKey=true are exclusive and
stdio accepts neither. Disconnect/refresh use
`{requestId,connectionId,expectedVersions}`. Grant-set is
`{requestId,expectedRevision,intent:OwnerScopeIntent}`, revoke is
`{requestId,grantId,expectedRevision}`, receipt query is `{requestId}`; list queries
are empty objects with existing frame/page bounds. Refresh is a receipted explicit
metadata operation; lost reply replay must not start a second discovery.
It never accepts client asserted
verified identity/resource evidence. Grant-set takes existing OwnerScopeIntent;
reuse OwnerScopeService's current policy/materialization in the same transaction,
without copying policy or nesting BEGIN. New explicit issuance defaults autonomous.

- [x] **RED owner operations.** Through actual SQLite plus authenticated socket,
      prove neutral settings unavailable before implementation. Assert owner mutation
      receipts survive lost reply/restart: same request/payload returns the original
      snapshot, changed payload refuses, concurrent expected-version writes have one
      winner. Invalid/foreign/restored/maintenance/old-client mutation sends0 and
      changes no grants. Reads expose only bounded keyless metadata. Use actual
      mutation counts, not always-refusing stubs.
- [x] **Implement atomic settings/receipts.** Extend the existing service authority
      transaction with owner receipt read/write, using one additive bounded receipt
      table in the next actual schema version (currently25). Keep existing rows,
      journals and historical schemas intact. Mutate connection/grant and completed
      receipt atomically. A route/workspace change advances configuration and trust;
      a credential replacement/removal advances credential revision and cannot claim
      account continuity. Recheck exact current versions, subject membership and
      baseline. Disconnect removes readiness through current-authority checks before
      async cleanup; revoke keeps history and never resolves an unknown effect.
- [x] **One existing private secret path.** Raw key <=512 characters uses the
      existing private store outside profile/backups; client responses, SQLite,
      receipts, logs and model context never contain it. Use fresh opaque saved
      references for owner replacements and a trusted SHA256 binding of material.
      Extend neutral references to saved handles without changing SDK APIs. Optional
      legacy binding metadata may remain absent/inert; production must refuse a
      credential handle whose actual material no longer matches its owner binding,
      including env:NAME changed under the same name across reconnect/restart.
      Current env-only declarations are not account proof. Owner supplies new material
      explicitly; no ambient token/account lookup. No trusted continuity callback is
      inferred from equal endpoint/name/schema. Reuse current SHA256/keyDigest and
      private-store ports rather than invent cryptography/identity infrastructure.
- [x] **Persist intent before private writes.** Reuse the existing provider pending
      request pattern in the owner receipt: prepared intent contains only exact
      request binding, new opaque reference and expected versions. Only after that
      durable record may the private write occur, then current state/receipt commit.
      Crash/failed publication must leave no active broadened grant or falsely
      completed mutation. Prepared operations after restart are visible as requiring
      explicit recovery and are never automatically resubmitted; a different payload
      cannot adopt them. Unused private entries are not execution authority. Test
      before/after secret publication and before final SQLite commit using synthetic
      keys; corrupt/insecure/missing private state refuses without env fallback.
- [x] **Wire through the sole host.** Add owner dispatch/typed DTO validation and
      explicit capability; old clients/ACP retain their existing contract and cannot
      silently operate the new rights. Maintenance permits safe keyless reads and
      refuses mutations/discovery. Normal connection-refresh alone may call existing
      coalesced metadata work, after its current durable permission; no business
      invocation is a settings method. Join owner mutations/refresh with existing
      drain. Owner disconnect must not cancel active admitted business work or
      falsely confirm cleanup; current dispatch guards still enforce revocation.
- [x] **GREEN acceptance.** Actual owner API configures an anonymous synthetic
      HTTP service and an enrolled stdio declaration, refreshes metadata and issues
      a bounded neutral grant. Normal scripted chat uses the existing SDK/admission
      path with one durable claim and one effect. Revoke before held send gives0;
      old/current-set/new-tool policy retains accepted behavior without regrant on
      restart/TTL. Rotate synthetic key A→B: old grant cannot send as B; same-handle
      byte changes refuse on reconnect/restart, no credential bytes in SQLite/wire.
      A second owner client observes original receipt and current independent state.
      No new native/live/ready-server matrix or UI is required in this child.
- [x] **Verify and commit.** Run owning RED→GREEN, strict/scoped checks and root
      pnpm check/build/format once on final implementation. Preserve the protected
      catalog3/format2 debt exactly until18.6, record process reachability; fix new
      failures, no exclusions. Run only affected socket/process controls separately
      if root stops earlier. Source<=300. Report interfaces/schema/receipt/credential
      crash semantics, commands/output/pins/limitations; commit owned paths and obtain
      independent review. Then refine18.5.2 exact decisions, not client UI in this task.

C18.5.1 accepted on `4798c95` after full review and one scoped correction round.
Owner API, schema26 receipts, existing private-store credential binding and
runtime-owned refresh are implemented; clients/exact decisions remain next.
Critical shared-secret loss and three Important findings are closed at`ec187e0`.
Actual SQLite/private-store near-limit and failure/recovery witnesses plus
186 covering/1 process checks passed; strict main/Node/Desktop/scoped checks0.
Last root is the earlier implementation:3689pass/3protectedfail/44skip,
process-unreached/build0/format-protected2; no fresh correction aggregate claimed.
M1 list cost, M2 generic lost-reply timing and N1 absent-file remove write are
retained for F. Explicit key operations now refuse corrupt shared private bytes
rather than reset unrelated credentials; no automatic private-state repair.

#### Task 18.5.2: Service confirm mode in existing durable owner decisions

**Files:** application `service-admission{,-types}.ts`, cohesive internal
`service-admission-prepare.ts`/`service-confirmation.ts` and owning tests as
needed for300 lines; `owner-decisions.ts`; CLI `runtime-types.ts`,
`runtime-services.ts`, `local-runtime/{host,decisions,settings-hosts}.ts` and
owning socket/process fixtures; contracts `local-runtime-decisions.ts`,
capability/compatibility, tools-node local decision client/hello tests. Reuse
C3 claim/dispatch guards and RuntimeOwnerDecisions; no second approval table,
permit engine, SDK wrapper, lifecycle manager or UI in this child. If host.ts
needs room, extract cohesive routing into existing settings-hosts, not minify.

**Interfaces:** add optional trusted `confirmation:ServiceCallConfirmationPort`
to `ServiceCallAdmissionOptions` and `RuntimeServicesInput`; expose it as
`RuntimeOptions.serviceConfirmation` for the trusted host composition.
`confirm(operation:ServiceCallConfirmation,signal:AbortSignal,
current:()=>Promise<boolean>):Promise<DecisionOutcome>` is runtime-only.
Operation carries `request:Omit<ServiceCallRequest,'catalogId'>`, full frozen
`configuration:ServiceConnection['configuration']`, full frozen
`definition:ServiceToolDefinition` and `effect:ToolEffectAdmission` with only
`catalogId` and `configRevision` removed from its JSON binding. This effect is
an exact semantic preview/comparison fact, never the admission passed to claim.
All other scope, effectKind, grant reference, resolved IDs and binding facts
remain. No credential bytes/references or model-provided permit flags enter it.
The host adapter is `RuntimeDecisions.service(operation,signal,current)`;
reuse its existing owner instance and preview/digest helpers. Add decision kind
`service-call`, feature `LOCAL_SERVICE_CONFIRMATIONS='decisions.service-v1'`.
Existing decision list/get/preview/resolve methods remain the sole wire path.

- [x] **RED exact confirmation.** Actual SQLite/admission and normal host with
      mode=confirm must initially refuse confirmation_required. Then show pending
      owner decision before any business claim/send; two authenticated clients read
      identical operation/preview/digest and concurrently resolve once. Require one
      claim before responder receipt, one business request/effect, one final answer;
      scripted provider must verify the actual returned result, not emit fixed
      success on a tool error. Autonomous mode still gives0 cards and the same flow.
- [x] **Implement the live exact-operation port.** Keep C3 validation, membership,
      run/attempt, grant limits, scoped conflicts and claim/settlement policy. No
      SQLite transaction spans owner await. Absent port retains confirmation_required
      with0 claims/sends. Freeze the semantic descriptor above and require current
      equality before owner allow, after await in the actual claim transaction and
      at the existing final SDK dispatch guard. Owner response is a fact delivered
      to this one live call, never a new autonomous grant or a caller-supplied boolean.
      Deny/expiry/invalidated/abort do not create authority; reuse unknown/claim-refused
      handling and do not report a possibly earlier effect as not_started.
- [x] **Separate metadata lifetime from permission.** An unchanged-definition TTL
      refresh during the owner wait may select the current published catalog for
      the eventual claim only after every semantic descriptor fact still matches.
      Build the final request/admission coherently from that current tuple; journal
      catalog/config fields must match the actual snapshot. Route/trust/credential,
      definition, scope, grant revision or actual request changes invalidate with0send.
      No discovery inside confirmation or business invoke, no definition/account swap.
      Preserve the existing post-claim/pre-send refresh guards and autonomous behavior.
      The300000ms owner card lifetime is independent of the30000ms business deadline;
      start the latter after approval/claim, not while waiting for the owner.
- [x] **Reuse durable owner decisions.** Stable decision ID is a trusted digest of
      workspace/room/run/attempt/invocation identity, never a truncated model ID.
      ownerPreview contains the full exact operation with reversible controls;
      bindingDigest is SHA256 of that full preview. createdAt/expiresAt use the
      existing owner clock and fixed300000ms expiry. Existing version/CAS/current
      checks and live waiter decide once. Duplicate ID cannot replace preview or
      mint another waiter; stored allowed/interrupted rows after restart are only
      facts and cannot authorize another call. Join existing stop/drain/abort paths;
      client detach never cancels a waiting operation. No new receipt or decision DB.
- [x] **Version the new kind safely.** Current shared LocalRuntimeClient advertises
      decisions.service-v1 and validates the new kind/full chunked preview. Identity
      projection independently masks it for historical clients. Pass the negotiated
      support through the existing runtime context to decision dispatch. A legacy
      list/get/preview/resolve that would expose or operate service-call must explicitly
      refuse service_confirmation_upgrade_required, never coerce it into write/test
      or silently hide it as an empty list. Old kinds/ordinary rooms/ACP keep their
      existing behavior. Current TUI uses its generic complete-preview panel; Desktop
      IPC/view remains18.5.3 (it currently exposes pending IDs, not a decision UI).
- [x] **GREEN failure and recovery controls.** Test exact-repeat/changed-ID payload,
      concurrent owner replies, stale version/digest/wrong room/run, deny and clocked
      expiry, revoke/limits/definition/credential changes while waiting, same-definition
      refresh success, abort/stop and allow-then-revoke during SDK preparation. Require
      0send when denied, and no model self-approval. Use actual socket/SQLite for owner
      races, existing injected clocks and bounded seams for narrow fault boundaries.
      One affected interprocess control keeps its observing HTTP peer alive across
      both owners: after approval and durable claim, observe one accepted effect,
      SIGKILL owner before result commit, restart and have independent clients see
      original decision/run/journal identity and unknown outcome. Re-resolving the
      old allowed card gives no new permit/effect/model request or confirmed cancel.
      Record metadata separately from actual receipts/effects, both stop outcomes,
      and exactly when the peer sees the durable claim. First owner records its actual
      SIGKILL exit/signal and absence of a confirmed stop; second records its observed
      stop response. No real service/model/key use
      or unchanged native/ready-server/GUI matrix is needed.
- [x] **Verify and commit.** Run meaningful RED→GREEN, owning/affected source and
      process checks, strict/scoped checks, then root pnpm check/build/format once on
      final implementation. Keep protectedcatalog3/format2 debt explicit until18.6;
      no skips/exclusions, fix new errors and record process reachability. Source<=300,
      report API/semantic binding/claim boundary/decision lifetime/recovery/capability
      evidence with exact files/commands/exits/pins. Commit owned source/report and
      get fresh independent review before18.5.3. Installed/live/current full release
      gates remain18.6/F; shared-runtime qualification is not a GUI acceptance claim.

C18.5.2 accepted on `cea61a4` (source`7b95d58`), full independent review approved,
0Critical/0Important/2Minor. Trusted live confirmation reuses the existing owner,
exact semantic/private snapshots, current preclaim tuple and final SDK guard;
stored decisions never become reusable permits. Final frozen source root:
3740pass/3protectedfail/44skip/process-unreached/build0/format-protected2;
affected process2pass. Initial admission RED preceded implementation; normal-host
unwiring was a later negative control, not an observed BASE host RED. Two recovery
proof Minors (readiness-timeout child cleanup; whole journal/counters after exit)
remain F. Current shared client/TUI contract supports service-call; Desktop
view/IPC and owner-settings typed client are next18.5.3, not GUI-qualified here.

#### Task 18.5.3: Thin clients and conservative legacy migration

Two reviewable deliverables:18.5.3.1 shared typed owner client plus the read
projections needed after reconnect;18.5.3.2 Desktop settings/decisions and
conservative legacy configuration import. Neither creates another authority,
secret manager, client database or execution engine. Current prepared creation
may have no connection row, while receipt(requestId) requires the lost client's
UUID; expose recoverable keyless intent from the existing runtime-owned receipts.
Actual session readiness is read from the existing MCP port, not inferred from
an active durable connection or catalog pointer. Expand UI details after the
shared contract is accepted. Project/coding GUI remains G; TUI UX remains H.

##### Task 18.5.3.1: Shared owner client and recoverable settings projections

**Files:** contracts `local-services.ts`/`local-service-views.ts` and exports;
pure domain `service-owner-operations.ts` and exports; application
`service-owner-{settings,receipt,views}.ts` and owning tests; SQLite
`service-owner-receipts.ts`/`service-authority-storage.ts`/public ports and tests;
CLI existing runtime-services and owner service dispatch/read capability;
tools-node `local-service-client.ts`, current LocalRuntimeClient and tests;
CLI read-only client example/docs. Reuse existing rows, immediate transaction,
metadata helpers, frame bounds and validatedParams. No new table/schema version,
provider/credential mutation behavior, model/tool permissions or SDK changes.

**Interfaces:** add methods to the existing shared LocalRuntimeClient:
`serviceConnections()`, `serviceGrants()`, `serviceReceipt({requestId})`,
`setServiceConnection(request)`, `disconnectServiceConnection(request)`,
`refreshServiceConnection(request)`, `setOwnerScopeGrant(request)`,
`revokeOwnerScopeGrant(request)` and `listServiceOwnerOperations(query)`.
The first eight consume accepted methods/DTOs; advertise service.authority-v2
in the existing hello. Add one read method `service.owner-operations` with
exact query `{after?,limit?,state?}`: after is an opaque request ID, default
limit50/range1..100, state absent/prepared/completed. Return `{items,next}`,
ordered by requestId, owner-filtered in SQL before limit; next is the last
returned ID only when more may exist. Reuse400000 canonical-character page
budget and existing2MiB frame. This is settings intent/history, not business
ToolEffect history or an endpoint to execute/retry anything.

Public output DTOs/validators belong to contracts and reuse domain record guards;
application must not import contracts. A connection view is the existing
ServiceConnection plus tools names and readiness:
`ready|disconnected|metadata_required|unavailable|unknown`. Add an optional
trusted read-only `ready(connection,catalog):boolean` to owner settings options;
normal composition supplies existing transport.ready with current lifecycle
restriction. No discovery/claim or permission follows from this view. Older
v2 responses lacking readiness normalize to unknown, never ready. Existing
receipt replies retain their current shape and original keyless result snapshot.

Operation items carry requestId/method/state/recovery, targetId|null and
operation|null. The optional persisted operation is one of
`{method:'service.connection-set',input:Omit<ServiceConnectionSetRequest,'key'>,
requiresKey:boolean}` or
`{method:'service.connection-refresh',input:ServiceConnectionRequest,
requiresKey:false}`. Capture it before the external/private effect in the
existing prepared receipt JSON; exclude key even when supplied, preserve the
original requestId/expected versions and exact keyless intent. Historical rows
without it remain valid and explicitly unknown; never fabricate their input.
Completed grant/disconnect target IDs may come from their validated result;
legacy prepared rows without parameters have null target. No raw secret/reference
from prepared private storage enters the operation view. Existing receipt bound
131072 bytes and binding semantics remain. No input from this read view is itself
execution authority.

- [x] **RED consumer contract.** Use current actual authenticated runtime and a
      second shared client to demonstrate missing typed operations/read discovery.
      A prepared new connection has no live connection row. Close/reopen the client
      and owner; the second client must find its original UUID/target/keyless intent
      without the first GUI's memory. Require0 automatic private writes/discovery/
      business/model calls from reads. Test completed snapshots separately from
      current state, unchanged request replay and changed-payload refusal.
- [x] **Implement bounded runtime projections.** Persist validated optional keyless
      operation metadata in existing receipts and add owner-only read dispatch/capability/
      maintenance-read allowance. Add bounded owner-filtered receipt iteration through
      current ServiceAuthorityTransaction; no unknown effect is replayed. Also resolve
      C5.1M1 in this touched read path: optional bounded owner metadata queries for
      connections/grants apply SQL limit/owner filter before row expansion, and the
      owner view stops before further catalog reads after its output bound. Existing
      no-argument core grant/connection enumeration semantics stay unchanged. Test
      actual SQL bounds and no discarded-row catalog expansion, not just array size.
- [x] **Implement one validated client.** All input/output validation and request,
      target, method/profile correlation use public contracts; do not import application
      or duplicate authority policy. Preserve original historical receipt on replay,
      refuse malformed/foreign frames, and never turn absent/prepared into completed.
      Verify capability before new calls; absent service.owner-operations support
      gives explicit service_operations_upgrade_required. Existing decisions.service-v1
      and old client/ACP behavior stay compatible. No secret bytes in logs/cache/DTOs.
- [x] **GREEN recovery and readiness.** Actual SQLite/private-store publication
      failure creates a discoverable prepared intent; owner restart never resubmits
      it. Second client reads same original intent/receipt, then a new explicit request
      with material/current versions may recover; the old prepared fact is not rewritten
      as completed. Cover metadata refresh intent, old rows lacking metadata, paged
      owner/state filtering and stable non-skipping cursor, current session retirement
      versus stale durable active state, and secret-field rejection in public intent.
      Readiness itself grants nothing; actual C3 still decides execution.
- [x] **Verify and commit.** Add a small read-only independent-client example using
      the public existing client entry, with reproducible start/connect/read commands.
      Run owning RED→GREEN, strict/scoped and one final root check/build/format;
      protectedcatalog3/format2 remain until18.6, no skips/exclusions. Run affected
      process controls if root stops first. Source<=300. No GUI/native/live/package
      matrix here. Report exact API/views/compatibility/recovery bounds, files,
      commands/exits/pins and protected state, commit owned source/report and obtain
      fresh independent review before expanding18.5.3.2. Installed TS/package debt F.

C18.5.3.1 accepted at925db6f after full independent review and one scoped
correction round (I1 field-origin rules, I2 contradictory wire facts, I3 legacy
metadata budget). One shared client and bounded existing-receipt reads are
implemented, including prepared-intent discovery and live readiness. Original
root atbfe198a:3758pass/3protectedfail/44skip/process-unreached/build0/
formatprotected2; correctionce00760 has37 owning/3 process passes and strict/
scoped/build0, not a new full-root aggregate. The exact-budget negative is
explicitly post-implementation, not a BASE RED. Desktop/import remains next;
installed/native/live/current-release acceptance remains18.6/F.

##### Task 18.5.3.2: Desktop settings, service decisions and legacy configuration import

**Files:** Desktop `service-protocol.ts`, `host/service-settings-client.ts`,
existing protocol/host dispatch; `ui/PluginSettings.vue` as the existing toolbar
wrapper with cohesive service form/grant/operation/decision components and state;
existing legacy plugin/history views with explicit read-only mode. Reuse model
settings IPC detachment/context patterns, existing bridge and shared client.
Update `provider-text.ts`, `dom.ts`, model hint callers/tests using existing
status.code. Relevant Desktop tests and minimal `qa/service-settings-*.mjs`
entry/peer helpers may reuse existing native launcher/window/session utilities.
Keep Desktop.vue<=300, preserve external design checkout. No new server/table,
permission engine, secret store, model loop, generic UI/lifecycle/QA framework.

Corrective scope includes the existing application `service-owner-connections.ts`
plus its owning SQLite/runtime tests when needed to preserve disconnected state
on isolated key removal. Ordinary config save still explicitly activates a
connection; no new endpoint, schema or permission component is introduced.

**Interfaces:** delegate settings IPC to the accepted nine LocalRuntimeClient
methods from18.5.3.1. Reuse public request/output validators and legacy readiness
normalization; never duplicate backend permission policy. Add thin owner-decision
IPC for existing listDecisions/getDecision/decisionPreview/resolveDecision only,
using existing guards and full SHA-verified preview. Native host chooses the
profile/client/workspace, never renderer-supplied authority. Both current service
features and historical supported fallback use explicit capability negotiation;
unsupported or failed negotiation is visible, never silently treated as no data.

- [x] **RED consumer behavior.** Add regressions for typed service IPC/host delegation,
      secret clearing before await, lost response with original receipt lookup,
      close/reopen discovery of prepared intent, late feedback after context change,
      grant version conflicts, and exact decision preview/second-owner resolution.
      Cover malformed IPC/output and historical support/refusal. Keep tests about
      actual observable behavior, not implementation snapshots or fake ready DTOs.
- [x] **Service settings and scope.** Use the existing Plugins toolbar entry/dialog
      for current service connections, actual readiness, published tools and owner
      scopes. HTTP URL and optional private key; pinned Node stdio uses only the
      existing executable/hash/optional packageJsonSha256/workspaceRoot/args fields,
      with no key/env/command installer or arbitrary npm/git/OAuth setup. Give
      explicit owner actions for save, metadata permission/refresh, disconnect and
      key removal; pass exact current version triples/request IDs. Selecting a view
      never performs discovery. Display recorded permission and actual readiness
      separately, including unknown/unavailable/metadata-required/disconnected.
      New service scopes bind current room/bot (project/task null), exact tool
      selections/current-set/all-future via existing policies. Default autonomous;
      confirm and future-tools are explicit owner choices. Proposed editable limits
      maxCalls1000/maxEffectBytes1048576/expiresAtnull, validated by public guards.
      Show group visibility and the actual resource breadth before saving; connection
      scope means all resources of that connection. Account/repository text is not
      verified enforcement. Preserve actual tool names (no CSV splitting). Revoke
      uses current grant revision; backend handles current catalog/trust/scope policy.
      Advanced coding/project scope editing remainsG, no new client policy engine.
- [x] **Recover settings without retry.** Clear key fields before awaiting IPC and
      on close/Escape/selection; pending UI metadata stays keyless. After lost reply,
      query the ORIGINAL request receipt; show its original result separately from
      current metadata. Absent/prepared/unknown is never success or automatic resend.
      Discover prepared operations through bounded runtime pages after reopen or in
      another client. Recovery is explicit owner action with a NEW request ID,
      current versions and required resupplied material; retain the old prepared fact.
      Old rows without intent remain read-only unknown, not invented prefill. Guard
      late room/bot/connection/window/profile feedback with existing context epochs;
      don't write a new client database or persist credentials in browser storage.
- [x] **Exact owner decisions.** Show current pending service-call cards with owning
      room/run, executor/status/result facts and full plain-text verified operation.
      Enable allow/deny only for the complete current version/digest/context; never
      truncate the operation or render it as HTML. Use existing backend decision
      IDs/version/CAS/lifetime. Two clients resolving one card see the same fact;
      stale resolution cannot mint another permission. Allowed is a decision fact,
      not proof the effect completed. Reload after reconnect; disconnect/closing a
      window never cancels a run or resolves a card. No new decision table/waiter.
- [x] **Conservative legacy import and accurate hints.** Current-runtime historical
      connections/grants/unknown operations remain clearly read-only, including no
      acknowledge/install/enable/grant mutations presented as current execution.
      A supported older runtime may keep its explicitly historical UI fallback.
      Prefill only available known declarative HTTP or pinned Node configuration,
      with key blank, metadataPermissionnone, no inherited grant. Stable legacy
      identity/generation prevents silent duplicate overwrite. Existing legacy rows
      lack durable material continuity: label/schema/identityBool do not prove
      current account/resource enforcement. Preserve old tool/repository/visibility
      facts in the archive; unsupported or missing data requires manual setup.
      Explain that a newly approved wider connection scope is a NEW grant, not an
      active migration. Do not call inert import migrated permission. No universal
      account/OAuth probe solely to make unqualified legacy rows active. Existing
      ProviderStatus/ModelConnectionStatus.code already carries corrupt/insecure
      key-store reasons: correct providerKeyHint/dom/model hints accordingly. A
      missing valid reference may need explicit resupply; corrupt contents are
      preserved and require separate safe repair, never delete-all/reset advice.
- [x] **Actual Desktop qualification.** Use one owned current-source Desktop entry
      (one provisional package if necessary), matching current public client/runtime
      pins and synthetic provider/MCP peer; retain real launcher/process ownership.
      Drive actual UI for connection/metadata/scope, prepared publication failure,
      lost committed reply/reopen plus second independent client process, original
      receipt/new explicit recovery, one full service card visible to two clients
      and exactly one accepted effect, stale reply rejection, close/reconnect during
      a held run and accurate inert legacy import. Require counted metadata/business/
      model calls and actual persisted facts, not renderer-seeded DTOs. Check1024
      width composer/focus reachability. Use existing native helpers; no real key,
      vendor service/model, released profile/install/launcher/user-unit changes or
      repeated unrelated model/asset/native matrix. Preserve failed proofs and
      unknown cleanup honestly; process exit alone doesn't prove descendants gone.
- [x] **Verify, document and commit.** Run owning RED→GREEN, strict production and
      Node/Desktop tests/scoped lint, then one root check/build/format on frozen final
      source. Keep protectedcatalog3/format2 until18.6; no skips or weakened assertions.
      Run affected process/native cases separately if root stops at protected source.
      Every source<=300. Report exact API/UI/import limitations, commands/exits/pins,
      actual GUI evidence, secret/context guards and cleanup. Update implemented/
      planned docs; commit owned paths/report, get independent review before18.6.
      This is current settings/decision GUI qualification, not installed/live/F release
      acceptance. C5 parent stays incomplete until its child requirements reconcile.

C18.5.3.2 accepted at83c0719 after full independent review and two scoped
correction rounds: five original findings plus I6 are closed. Source905e1e9
has original root3793pass/3protectedfail/44skip/process-unreached/build0/
formatprotected2. Correctionde9cccf has302 owning/2 process passes and an
exact-source targeted real GUI credential proof; correction47b691d adds25
scoped passes/strict/build0 for one local feedback clear. These are separate
proofs, not a new final full-root/native aggregate. Bulk GUI and1024 delta
retain their original working-source/bundle pins. Three original Minors and
N1 diagnostic retention remain F. Parent18.5 is complete within owner settings,
exact decisions, thin clients and conservative inert import; parent18/C remain
open until18.6 installed/live/package replacement and Executor removal.

### Task 18.6: Installed MCP replacement and retirement of Executor

Two dependency-ordered deliverables finish C: first port the unfinished regressions
and qualify the installed replacement; then remove the unused SDK and patch.
Reuse existing admission, owner settings, receipts, packaging and native helpers.
Do not create another backend, agent loop, policy/identity layer or QA framework.
D–H remain ordered after C; this checkpoint does not complete the release.

#### Task 18.6.1: Port catalog regressions and qualify the installed replacement

**Files:** existing CLI catalog-lifetime test and fixtures; current service-turn
projection/admission tests only if an actual failing regression requires a fix;
existing MCP session/transport owner-refresh scheduler if a normal admission RED
shows a dropped eligible hint; existing release packager/tests/native fixtures and implementation-
status docs. No SDK removal in this task. Preserve historical tests and migration/
archive handling until18.6.2.

**Interfaces:** production public MCP SDK2.4.0 uses cacheTTL0 and the exact frozen
public callTool.toolDefinition. Runtime-owned metadata refresh is distinct from
business invocation: current persisted metadata permission and a new durable
refresh generation precede discovery. Settings/client contracts from18.5 remain
unchanged. No raw secrets in logs, argv, model context, SQLite or Git.

- [x] **Preserve and port the unfinished regressions.** Take ownership of the two
      previously protected catalog files only here. First save their exact raw
      diff/bytes, SHA256 and index state in this plan's private proof directory.
      Port all three semantic cases to the production MCP adapter with actual
      SQLite admission and independently counted peer traffic: expired SDK cache,
      tools-changed notification, and delayed stale initialization must not cause
      hidden SDK discovery or a late background initialization/list outside owned
      work. The published selected definition remains frozen and the business call
      count stays exact. Distinguish legitimately authorized owner refresh from
      hidden discovery: preserve permission/generation-before-I/O assertions, not
      a false blanket prohibition on metadata. Use a small cohesive new fixture
      if needed, never a permanent dual-backend abstraction. Register, format and
      commit the port; do not skip/delete these behaviors or claim the old SDK fixed.
- [x] **Exercise the normal waiting-model route.** Hold an actual normal provider
      after its tool snapshot, perform owned metadata refresh and then return its
      selected tool call. Prove whether unchanged full selected definition survives
      the catalog generation change. If RED shows a stale-route defect, make the
      smallest bounded projection correction before existing C3 admission. Require
      the original full selected definition including provenance and current
      configuration/trust/credential/grant facts; refuse changed selected definition,
      endpoint/account/key/grant and ungranted new tools. The final request/claim
      tuple must be coherent. No hidden discovery, relaxed final guards or new API.
- [x] **Reach actual root GREEN.** Run owning RED→GREEN and strict relevant test
      compilers, then root pnpm check/build/format:check on final source. Reach the
      process phase and fix newly exposed failures without exclusions/skip changes.
      Every source file<=300 physical lines. Save exact commands, exits and pins.
- [x] **Qualify one clean exact-source installed candidate.** Commit the qualified
      source, create a clean isolated checkout and run actual pinned pnpm frozen
      install/check/build/format (a direct tsc or linked-source fallback is not
      successful installation). Package a private prerelease archive, record source
      revision, SHA256/inventory and install into a disposable prefix. Check actual
      installed CLI runtime start/status/stop, offline CLI/TUI/ACP and current public
      client connection/history/owner reads. Verify the advertised public client types
      resolve from installed bare imports; ship emitted first-party declarations if
      the archive advertises them, retaining product exclusions and the bundled MCP
      adapter's explicit JS-only contract. Reuse existing packaging/tamper checks;
      no change to released installs, real profiles, launchers or user units.
- [x] **Qualify production MCP through that installation.** Use the installed sole
      host, saved owner settings and public client. A scripted ProviderPort is fine
      and avoids unrelated model API calls. Run one autonomous exact-granted business
      call with no decision card, one accepted/drop or SIGKILL unknown recovery with
      a separate surviving peer and exact model/business/effect/claim/receipt counts,
      and a pinned ready filesystem stdio server with native isolation/cleanup facts.
      Reuse current helpers and readonly ready-server inputs; do not repeat the old
      full fault matrix. A bounded actual GitHub issue_read uses the already approved
      restricted private PAT for ryltsevmikhail/Ocean issue5 through ordinary saved
      HTTP configuration, not a test-only GitHub transport override. Keep material
      private; no DeepSeek/OpenAI/Anthropic key reads. Close the technical issue only
      after successful qualification. If a live/native gate fails, retain evidence
      and fix the demonstrated issue; never relabel prototype evidence as installed.
- [x] **Report and review.** Update implemented/planned documentation and report
      exact artifacts, commands, counters, source/dependency pins and honest cleanup
      limits. Get independent task review before18.6.2. Keep Executor/patch present
      until this replacement/package gate is actually accepted. Final current native
      shards, whole-branch review, full install/rollback and release remain F.

C18.6.1 accepted at5450b4d after independent spec/quality review0Critical/
0Important; two Minors remain F (exact named binding assertions and optional
connection-fact copy simplification). Controller audited retained original hashes,
actual clean root3819+158/build/format0, installed artifact sourceffeb3d3/SHA256,
public bare-import declarations, independent peer counters and native retirement.
SDK invocation/final claim guards remain unchanged and were checked at their
existing boundaries. The SIGKILL effect remains uncertain. This accepts replacement
qualification only; SDK removal, parent C and the full release remain incomplete.

#### Task 18.6.2: Remove the retired SDK after replacement acceptance

**Files:** retired packages/integrations-executor and patches SDK artifact;
CLI explicit development plugin-transport and SDK-only fixtures/tests;
root/CLI package, TypeScript and Vitest graph, pnpm workspace/lock configuration;
existing release historical fixture/tests and implementation-status docs; current
MCP http.ts serialized-request byte guard plus owning HTTP tests for the demonstrated
under-cap arguments/over-cap JSON-RPC envelope gap. Keep the remaining current
MCP adapter, admission, owner settings and clients intact unless a concrete
removal regression requires a small compatible correction. No new API/table/engine.

**Interfaces:** accepted18.6.1 sourceffeb3d3 and installed candidate prove the direct
MCP replacement. Modern package already omits Executor; remove its unshipped source
and dependency graph now, not the historical records or neutral ports still read
by old profiles. Existing supported historical archive validation must not weaken.

- [x] **Inventory before deleting.** Map every retired SDK-specific test family to
      current qualified MCP behavior or explicit nonproduct retirement. Preserve
      semantic coverage for dispatch/claims/401/no retry/drop/deadline/denial/bounds/
      credentials/catalog and frozen selected definitions. Old SDK pins/internal
      policy hooks and OpenAPI producer qualification are retired mechanisms, not
      claimed migrated features. The three protected catalog behaviors were already
      ported/accepted; keep them. Do not silently delete or skip product regressions.
- [x] **Remove only the retired graph.** Delete Executor workspace/code, its vendor
      patch, CLI development composition and obsolete SDK-only producer fixtures;
      update package/tsconfig/Vitest references and lockfile. Remove Effect overrides
      and msgpackr build settings only after verifying no remaining consumers. Keep
      public MCP SDK2.4.0 and current bundler pinned. Preserve LICENSE/NOTICE and
      required third-party notices. No inactive fallback or vendored old SDK blobs;
      do not delete shared caches or retained external qualification inputs.
- [x] **Keep historical operations honest.** Preserve legacy history, inert import,
      needed owner reconciliation/unknown holds and existing installer validation.
      Replace obsolete SDK-built historical test inputs with small structural archive
      fixtures exercising the same existing manifest/hash/tamper rules without SDK
      dependencies. Label these as installer structural tests, not a real historical
      runtime boot qualification. Do not relax validation to accommodate the fixture.
      Current MCP inventory/tamper/standalone controls remain active.
- [x] **Verify the removal revision.** Actual pinned pnpm install --frozen-lockfile,
      strict relevant tests, root pnpm check/build/format:check exit0; no source>300
      lines or exclusions to hide failures. Produce one clean exact-source private
      archive/disposable install: inventory and dependency closure contain no Executor
      or patch/dev code, current public-client imports/types and CLI/offline lifecycle
      work; existing installer controls cover modern and supported historical formats.
      Compare unchanged MCP/runtime code inputs with accepted18.6.1 proof; rerun native/
      live only if changed behavior or new evidence justifies it. No repeated unchanged
      positive full matrix, real install/profile/key change or credential read here.
- [x] **Document and review C.** Record removed dependencies, coverage map, exact
      commands/exits/source/archive hashes and qualification limits. Reconcile all
      five parent18 requirements against accepted children and retained evidence;
      obtain independent task review before marking C complete and expanding D.
      All deferred Minors/Rulings remain mandatory F; SDK deletion/docs do not close
      unrelated typing/native/device/restore/release gates. No schedules, marketplace,
      Sources, universal OAuth or CLI agents.

C18.6.2 accepted atfa91907 after full independent review and one scoped
correction round: response/catalog bounds now have valid padded under/over controls
and guard-loss negatives. No blocking findings remain. Qualified source1f31974 has
clean frozen install/root3691+165/build/format0 and standalone archive SHA256
`5fdcd2b6eba91554cc0dd78bb856fabd3873c0dd5630f244a619b23a2d017d2c`.
Correctionfa91907 has62 covering passes/strict/scoped checks and changes only tests/
report; it is not a new root/native/artifact aggregate. Parent C is complete within
its five requirements. Historical installer structure is qualified, not historical
runtime boot. Generic service-workspace independence is still D; F retains all
Minors/Rulings, current native/restore/device/release gates. Full A–H goal remains.

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

### D delivery sequence

Reuse the current engine, TaskRun, SQLite, receipts and runtime scheduler. One
owner-authored root holds the mandate/budget; bot tasks are its initial children.
There is no implicit leader or authority derived from recipient order, and no Team
entity. Owner root start plus selected room members authorizes local communication.
Selected C grant references authorize external operations only after the current
mandate/ancestor/executor intersection; zero references never grants external I/O.
Do not add a separate communication permission/editor just to talk within this root.

19.1 delivers a pure addressing projection/decision.19.2 adds durable tasks/delivery,
then the common engine/host, recovery and shared budget through independently tested
leaves expanded against accepted interfaces.19.3 proves actual managed workspace
independence, including startup/idle writers, before D is accepted. No second loop,
broker, generic workflow/identity framework or E/G UI expansion.

### Task 19.1: Pure bot-task addressing and stable operation identity

**Files:** create `packages/domain/src/room-task.ts`, `room-delivery.ts` and
`room-delivery.test.ts`; modify domain `index.ts`; document the narrow implemented
scope in `docs/ocean/platform-stage-d.md`. No application/store/adapter/client change.

**Interfaces:** readonly `RoomTaskAddress` projects only addressing facts:
`id, workspaceId, roomId, rootId, parentId, assigneeBotId:string`,
`members:readonly string[]`, `grantReferences:readonly OwnerGrantReference[]`,
`status:'ready'|'waiting'|'paused'|'completed'|'stopped'`, `lastDeliverySeq:number`.
Only bot tasks enter it: id differs from rootId, parentId is present and nonself;
parent may be the owner root or a delegating bot task. Actual persisted joins,
full mandate/budget, revisions and current grant authority belong to19.2.
Members is a dense unique1..32 bot-ID ceiling containing the assignee; grant refs
are dense0..32, valid current C reference shapes and unique by grantId. Use
`validOwnerGrantReference` from existing `owner-scope-grant.ts`. Empty refs allow
only local communication under owner root, never external authority. Cursor is a
safe integer>=0. These are projections, not grants or a complete persistence schema.

`RoomDeliveryAddress` has readonly string fields
`id, workspaceId, roomId, rootId, toTaskId, recipientBotId, causeId, requestKey,
messageId`, nullable string `fromTaskId, sourceTurnId, senderBotId`,
`kind:'start'|'message'|'delegate'|'result'` and positive room history `seq:number`.
This projects deliveries to bot tasks. Owner start has null source/sender/fromTask;
other kinds refer to their causal bot turn/task. A result to an initial owner root
is progress/publication, not a delivery that wakes a root bot. No runtime validator
or persisted receipt format is frozen for this type in19.1.

`RoomAgentRequest` is exactly `{kind:'message'|'delegate',toBotId:string,text:string}`.
Trusted `RoomDeliveryOrigin` is `{task:RoomTaskAddress,botId:string,turnId:string,
deliveryId:string,attemptId:string,callId:string}`. Source callId is the engine's
round-qualified invocation ID from tool-round.ts, not raw model JSON. Data IDs use
existing validConversationText UTF-8 validation with128-byte bound; this compound
callId has512-byte bound so valid attempt+round+provider IDs are not truncated.
Text uses the existing16384-byte bound. Current membership is a dense unique array
of0..32 valid bot IDs; an empty current list makes a valid old route ineligible.

Export `decideRoomAddress(origin:RoomDeliveryOrigin,request:unknown,
currentMemberIds:readonly string[]):Result<RoomAddressDecision>`; the readonly
result is `{senderBotId,recipientBotId,text,kind,requestKey,binding}` with kind
message|delegate. Return err(DomainError.invalidArgument(...)) for malformed JSON
data/projection/membership; err(DomainError.invariant(...)) for otherwise valid
ineligible routing; ok on success. Do not throw domain errors as control flow.
Require ready task, origin bot equal assignee, different sender/recipient, both
selected and current members. No model asserted sender/root/grants/result/wake.
Key is exactly `canonicalJson(['room-agent/v1',turnId,attemptId,callId])`;
binding exactly `canonicalJson([workspaceId,roomId,rootId,task.id,deliveryId,
botId,kind,toBotId,text])`. Preserve text, do not normalize the receipt payload.
Later durable receipt lookup precedes fresh routing checks and may hash this
internal key using the existing trusted SHA256 port; it cannot repeat execution.
This pure decision performs no identity allocation, authority grant, I/O or state mutation.

- [x] **RED addressing behavior.** Add positive A→B message/delegate cases with
      zero and multiple refs; assert derived sender and exact key/binding, stable
      replay identity, changed text/recipient/kind changes binding only, distinct
      room bindings. Include compound callId>128<=512 and exact UTF-8 boundaries.
      Add a minimal temporary contract stub if needed to make positive cases fail
      behaviorally; report missing-export RED separately, not as per-case behavior.
- [x] **Implement the minimal decision.** Reuse existing Result/ok/err, canonical
      JSON, Unicode text and C grant-reference guards. Validate plain request with
      exact own keys, bounded dense arrays, IDs/refs/cursor and actor eligibility.
      No new validator/policy framework, schema, engine, capability or endpoint.
- [x] **GREEN refusals and immutability.** Reject forged sender/root/grants/result,
      missing/extra keys, malformed/empty/oversized/NUL/surrogate text/IDs, sparse or
      duplicate/oversized members/refs, bad reference revision, null/self parent,
      owner root presented as bot, unsafe/negative cursor. Reject current removal,
      outsider, self, stale assignee and waiting/paused/completed/stopped routes as
      ineligible when otherwise well shaped. Accept parent=root and parent=bot.
      Prove inputs unchanged; no mocks that merely refuse everything.
- [x] **Verify and report.** Run owning domain RED→GREEN and strict test typing;
      root pnpm check/build/format:check once on final source through private runner,
      source<=300. Update implemented/planned docs and commit exact owned paths.
      Obtain independent task review before19.2 detail. No native/live/key requests
      or repeated C matrices: this does not yet execute or persist autonomous tasks.

D19.1 accepted atba6ec5c after independent spec/quality review0Critical/
0Important/0Minor. Actual behavioral RED→GREEN,35domain files278passes;
frozen root3707source+165process (44/36configuredskips), build/format0.
Only pure addressing projections/decision and status docs are implemented.
Parent D, persistence/authority/engine/hosts and native/live remain incomplete.

### Task 19.2: Durable team work through the common engine and server

Expand the next persistence leaf after19.1 acceptance. One root coordination row,
one bot task per owner-selected initial assignee, one shared user message/receipt
and one inbox/outbox delivery row per target; source author is runtime-authored.
Owner-start edges use mandate plus recipient selected grants; bot-originated edges
also inherit every actual delegating ancestor under that ancestor's own subject.
Never wake an independent broader task from a peer message or discard revoked refs.
Keep old taskId=coding semantics/direct room holds/finite broadcast and migrations
byte-safe. Adapt the actual history constraints that presently require bot author
and target to match and a single message per turn. Receipts precede wake; replay
and altered payload differ. Actual joins/state/current authority, not19.1's shape
projection, authorize action. Restore/quarantine remains binding.

Then add host send/delegate/state tools to the existing executeChatTurn/runTurn;
durable delegation yields without a held Promise, transaction or execution slot.
Finalize only proven local steps; unknown model/effect never replays. Results wake
only recorded parents and publish once; per-delivery state preserves earlier queued
messages while matching results unblock waits. Freeze B's per-bot identity and
current privacy/current grant checks at the actual dispatch boundary. Owner stop
fences all future starts, client disconnect leaves runtime alive. Root shared limits
start at2 concurrent/32 total bot slices/64 provider starts/64 tools; use existing
budget reservations, unknown usage never zero. Pause before third identical
sender/recipient/kind/trimmed-NFC-text handoff without verified new result, once.
Exercise one-slot A→B→A, unrelated task progress, both mixed-provider outages,
privacy/revoke/stop/budget/receipt/restart races; qualify real mixed providers
separately. Detailed interfaces follow the accepted earlier leaf, not guesses.

### Task 19.2.1: Persist room tasks and addressed messages

Detailed leaf frozen after19.1 acceptance at `4c85da7`. The observable result is a committed owner start or bot send,
a scoped history entry and a retrievable receipt. Fresh admissions leave queued records inert. Two new tables suffice.

#### First leaf and file map

- `packages/application/src/room-task-persistence.ts` defines `RoomTaskPersistence.start` and `.send`, constructed with `ConversationStore`, trusted `ownerId`, `Clock`, `nextId` and the existing C-style `sha256:(text:string)=>string` dependency.
- `packages/application/src/room-task-records.ts` defines the v1 records, input, receipt and narrow synchronous `RoomTaskTransaction` below.
- `packages/application/src/room-task-start.ts` validates the owner intent and constructs the root member pins. `room-task-send.ts` validates the causal path and constructs a child.
- `packages/application/src/conversation-ports.ts` adds optional `roomTasks?:RoomTaskTransaction` to `ConversationTransaction`. Fresh D work requires it. Public exports in `application/src/index.ts`.
- `packages/domain/src/room-delivery.ts` factors the accepted strict request test and key/binding derivation into pure reusable helpers for receipt replay. Existing decision outputs stay byte-identical.
- `packages/domain/src/chat-turn.ts` adds optional `roomDelivery:{version:1,taskId:string,deliveryId:string}` for a bot execution attached to an admitted delivery.
- `packages/store-sqlite/src/room-task-schema.ts`, `room-task-history-schema.ts` define v27 migration/constraints. `schema.ts`, `schema-migrations.ts` install and verify v27.
- `packages/store-sqlite/src/room-task-storage.ts` implements transaction reads/writes, `room-task-origin.ts` performs immutable and live origin resolution. Integrate in `conversations.ts` for current-schema transactions only.
- Reuse `chat-storage.ts`, `model-connection-storage.ts:14` (`readModelConnection`), `service-authority-rows.ts:37` (`readAuthorityGrant`) and `restore-origin.ts` in the same DB transaction. Avoid nested store transactions.
- `application/src/{direct-chat-admission,room-broadcast,room-model-policy}.ts` and `store-sqlite/src/chat-storage.ts` adapt the scoped admission/barrier reads described below.
- `domain/src/profile-backup.ts`, `store-sqlite/src/maintenance.ts` and new `store-sqlite/src/room-task-maintenance.ts` cover schema bounds and held-room summary. Maintenance is already 299 lines.
- Add focused SQLite tests `room-task-start.test.ts`, `room-task-send.test.ts`, `room-task-migration.test.ts`; put shared real profile/actor construction in `packages/store-sqlite/test-fixtures/room-tasks.ts`.
- Update existing migration/backup test expectations which pin the _current_ schema. List below. No new client DTO, wake API, native test or provider fixture is needed here.

#### Inputs and transaction surface

`start(input:RoomTaskStart):ConversationResult<RoomTaskReceipt>`. The caller is the private owner host. No owner ID, authorship, model metadata or root/task IDs in the request.
`RoomTaskStart={workspaceId,roomId,requestId,text,initialBotIds,participants,mandate}`. IDs ≤128 UTF-8 bytes, text ≤16384. Accept opaque valid text, including attachment-like markers. Reject binary/attachment fields. Persistence never opens an asset; before any later transfer, the engine must validate asset ownership, capability and privacy.
`participants:readonly {botId:string,grantReferences:readonly OwnerGrantReference[]}[]` is a unique dense list of 1..32 actual room members. Refs are unique by grantId, 0..32 per bot.
`initialBotIds` is a nonempty distinct subset of participants. Each initial bot gets its own task parented by the coordinating owner root, including single-bot starts.
`mandate={projectId:string|null,codingTaskId:string|null,permissions:readonly OwnerPermission[]}`. Validate the exact owner C permission shapes (0..256), bound whole canonical intent ≤256 KiB.
For a plain null/null mandate, derive each effective C subject from the stored workspace: `{workspaceId:workspace.id, roomId, botId, projectId:sha256(workspace.root), taskId:null}` (`apps/cli/src/runtime-services.ts:193–202`). A supplied project without a coding task must equal that same stored-root digest.
For a coding selection read the actual `CodingTask` in the same transaction. Match its id, workspace and owning room, derive `projectId=sha256(task.projectRoot)` and compare any supplied project. For a dev-scoped ref require its reserved task and dev bot as in `runtime-services.ts:203–214`. Reject unsupported assertions. Participants with zero refs gain local communication only.
Use the accepted fixed root limits `{concurrentSlices:2,totalSlices:32,providerStarts:64,toolCalls:64}` in v1 storage. Per-request lowering/accounting can be introduced with execution.
`send(actor:{turnId:string,taskRunId:string,attemptId:string,callId:string},request:unknown):ConversationResult<RoomTaskReceipt>` takes the first argument only from the runtime.
`callId` is already round-qualified by `tool-round.ts:23`, max 512 bytes. Only `{kind:'message'|'delegate',toBotId,text}` is model input. Extra own keys (including symbol/hidden keys) fail.
`RoomTaskReceipt={version:1,workspaceId,roomId,rootId,messageId,seq,deliveries:readonly {botId,taskId,deliveryId}[]}`. Return immutable facts in original initial-recipient order.
Use one `ocean_receipts` row per owner start or tool invocation. Reuse `{kind:'message',data:ConversationMessage}` with exact canonical binding; join deliveries by receipt key + message ID for task IDs.
This follows `room-broadcast.ts:158` and avoids a new receipt discriminator or parallel journal. Decode immutable receipt/message/target links and fail closed on missing/mixed/corrupt joins.
Receipt queries never depend on mutable status, current model, grant revision, history tail or clock. Existing legacy `receipts.get` compatibility must not interpret D as new execution authority.
The following application types specify the projection of the two rows. `kind` is derived from root/assignee nullability. Use readonly fields throughout.

```ts
type RoomTaskMandate = Readonly<{
  projectId: string | null;
  codingTaskId: string | null;
  permissions: readonly OwnerPermission[];
}>;
type RoomTaskMemberPin = Readonly<{
  botId: string;
  grantReferences: readonly OwnerGrantReference[];
  identity: Extract<ModelExecutionIdentity, { source: 'connection' }>;
}>;
type RoomTaskRootPayload = Readonly<{
  ownerId: string;
  mandate: RoomTaskMandate;
  members: readonly RoomTaskMemberPin[];
  limits: Readonly<{ concurrentSlices: 2; totalSlices: 32; providerStarts: 64; toolCalls: 64 }>;
}>;
type TaskRow = Readonly<{
  version: 1;
  revision: number;
  id: string;
  workspaceId: string;
  roomId: string;
  rootId: string;
  status: RoomTaskAddress['status'];
}>;
type RoomTaskRoot = TaskRow &
  Readonly<{
    kind: 'root';
    parentId: null;
    assigneeBotId: null;
    lastDeliverySeq: 0;
    waitingChildId: null;
    rootPayload: RoomTaskRootPayload;
  }>;
type RoomTaskBot = TaskRow &
  Readonly<{
    kind: 'bot';
    parentId: string;
    assigneeBotId: string;
    lastDeliverySeq: number;
    waitingChildId: string | null;
    rootPayload: null;
  }>;
type RoomTaskRecord = RoomTaskRoot | RoomTaskBot;
type RoomDeliveryRecord = RoomDeliveryAddress &
  Readonly<{
    version: 1;
    position: number;
    sourceAttemptId: string | null;
    state: 'queued' | 'claimed' | 'consumed' | 'held';
  }>;
type RoomTaskOriginFacts = Readonly<{
  root: RoomTaskRoot;
  task: RoomTaskBot;
  input: RoomDeliveryRecord;
  turn: ChatTurn;
  liveRun: TaskRunState | null;
}>;
interface RoomTaskTransaction {
  task(id: string): RoomTaskRecord | null;
  deliveriesForReceipt(key: string, messageId: string): readonly RoomDeliveryRecord[];
  origin(
    turnId: string,
    runId: string,
    attemptId: string,
    live: boolean,
  ): RoomTaskOriginFacts | null;
  grant(id: string): OwnerScopeGrant | null;
  modelConnection(id: string): ModelConnectionRecord | null;
  codingTask(id: string): CodingTask | null;
  restored(): boolean;
  roomHold(roomId: string): boolean;
  pendingTransfer(roomId: string): boolean;
  putTask(row: RoomTaskRecord): void;
  putDelivery(row: RoomDeliveryRecord): void;
  waitFor(taskId: string, childId: string, expectedRevision: number): void;
}
```

`modelConnection` returns the existing application `ModelConnectionRecord` (`model-connection-ports.ts`). Only the projected identity is persisted. `origin(...,false)` returns immutable joins with null liveRun. The replay caller verifies the attempt against the outgoing row from `deliveriesForReceipt`. `origin(...,true)` requires a verified liveRun or returns null. CAS mismatch in `waitFor` throws.
All methods are synchronous. Each public operation enters exactly one `ConversationStore.atomic`; validate first, then write. After a first write any failure must throw through `withImmediateTransaction`,
which commits on a normal return even if it contains `err(...)`. Map expected errors outside rollback. SQLite constraints/CAS are the final arbiter across two writers.

#### Two-table schema and old history

`ocean_room_tasks`: STRICT, `id TEXT PRIMARY KEY, workspace_id,room_id,root_id,parent_id,assignee_bot_id,status,version,revision,last_delivery_seq,waiting_child_id,root_payload`.
`version=1` is record format, `revision>=1` is mutable CAS, `last_delivery_seq>=0`. Text IDs and positive integers use SQLite CHECK/NOT NULL, with exceptions below.
Root row has `id=root_id`, null parent, assignee and waiting child, cursor 0. Status initially ready. Bot rows have distinct `id/root_id`, non-null nonself parent, assignee, null root_payload.
Root payload contains trusted ownerId, immutable mandate, fixed limits and one member pin per selected bot, including the exact supplied references. Keep one copy per root.
Task `status` uses accepted `RoomTaskAddress['status']`. Bot `waiting` requires its exact `waiting_child_id`. Protect identity, ancestry, root payload and room against update.
FK `(workspace_id,room_id)` to room and `(workspace_id,assignee_bot_id)` to bot. Retain historical task/actor identity after live membership changes. Task/delivery/member pins must not FK to the live roster; join bot rows and recheck current membership on every fresh route.
Composite UNIQUE `(workspace_id,room_id,root_id,id)` serves scoped parent/wait/target FKs. Root reference resolves to the self-root in this scope. An inserted bot parent must already exist.
Enforce same root/room, actual root shape and direct child for a wait target using scoped FKs plus insert/wait validation. Index `(workspace_id,room_id,root_id)` for holds and ancestry.
`ocean_room_deliveries`: STRICT, accepted `RoomDeliveryAddress` columns snake_case + `version=1, position, source_attempt_id, state`. Start/peer rows inserted as `queued`.
`position` is receipt-target order 0..31. `state` in `queued|claimed|consumed|held`. Execution gate owns claim/consume/hold transitions and contiguous cursor advancement.
Immutable ID, room/root, target/source, request key, source attempt, cause, message and seq. PK id, UNIQUE `(request_key,position)`, `(to_task_id,message_id)`, index `(to_task_id,seq)`.
Scoped target/source task FKs as above. Verify target bot matches task assignee and source bot/parent match the source task. `start` has null source fields and targets a direct root child.
`message|delegate` targets a new direct child of the originating bot task; non-null source turn/attempt/bot/task and cause ID of originating input delivery are mandatory.
Limit DDL to these three producible kinds (or explicitly reject unimplemented `result` on insert in this leaf). Reserve the v1 addressing union for later parent result publication.
Bind to actual message `(room_id,seq)` AND its `id` using unique `(room_id,seq,id)` + composite FK. Use DEFERRABLE INITIALLY DEFERRED FK to message and `ocean_receipts(request_id)`.
Start causeId equals its coordinating rootId, with null bot/source fields. Peer causeId is the originating input delivery ID. Start permits multiple delivery rows for the one user message. Peer operations require exactly one target/position 0. Restrict duplicate recipient per request. Rows reference existing same-room source ChatTurn.
No ChatTurn or TaskRun is created by fresh start/send. On later execution one marked turn owns one incoming delivery. Use UNIQUE partial expression index on `$.roomDelivery.deliveryId` in chat payload.
Validate the marked turn against target task, workspace/room, bot, inboundMessageId/seq on insert, and make marker/identity immutable on update (old direct turns cannot acquire the marker).
This avoids scheduling or creating placeholder model attempts while providing a durable reverse join for bot actors. No third link table.

`group-schema.ts:19–30` currently requires author=target and `UNIQUE(turn_id)`. Preserve all ten physical message columns so existing positional inserts/row readers continue to work.
Use author/target relation as the discriminator: user branch keeps its old check, ordinary final bot row has author=target, addressed peer bot row has both present and different.
Partial UNIQUE `(turn_id) WHERE author='bot' AND author_bot_id=target_bot_id` preserves once-only ordinary publication. Preserve `UNIQUE(room_id,seq)`, membership/turn FKs and the direct-target trigger.
Guard addressed inserts with a trigger requiring a matching previously inserted delivery with source turn, author, recipient, room, sequence and message ID plus that turn’s marked input lineage.
Preserve the historic `(room_id,target_bot_id) -> ocean_members` FK on history: a bot already targeted by a retained message cannot literally be deleted from this roster while that row exists. Do not add an author-to-current-members FK.
Prove member disappearance using a group’s shared target-null start: remove a still-queued bot with no targeted history, or remove a sender before its ordinary final reply when only peers have been targeted. Historical root pins/deliveries and receipts survive; fresh routing fails. No roster-management feature is needed.
Store delivery first, addressed history next, then receipt, all under one lock. The deferred FK closes the cycle. Regular final replies keep `reply_<turn.id>`, addressed IDs use separately allocated message IDs.
Preserve current `messageRow` and `LocalMessage` shape (`local-runtime-queries.ts:42`). `room-context.ts:72,93` keys attribution by `authorBotId`. SQLite result read uses both `turn_id` and `reply_` ID.
Critical wire gate: `tools-node/src/local-room-client.ts:126` and the frozen RC2 client fixture both reject a bot whose author differs from target. Desktop’s independent Zod guard accepts separate IDs.
Exercise SQL/application history in this private leaf. Before any host can produce D deliveries, the next wire gate must negotiate truthful addressed-history reads or explicitly refuse with an upgrade requirement when a client cannot represent them. Keep ordinary v26 frames/sequence behavior and the frozen RC2 fixture. Do not send such frames to RC2, drop rows from its contiguous pages, or rewrite authoritative author/target.
`room-context.ts:121` treats its _current_ input as user data. Do not feed a peer delivery to that method in this leaf. Later execution must label peer input explicitly. Historical peer reads already preserve identity.

#### Fresh write and replay rules

Validate intent shape and bounds before receipt reads. For owner start use the supplied globally scoped owner `requestId`; bind `canonicalJson(['RoomTaskStart/v1',ownerId,workspaceId,roomId,text,initialBotIds,participants,mandate])`.
Keep array order stable and bind every caller-selected field. Never include allocated IDs, current auth/model metadata, generated deadlines or current time in this binding.
For send derive the accepted `canonicalJson(['room-agent/v1',turnId,attemptId,callId])` from trusted invocation identity before eligibility checks. Use it as logical requestKey.
For the SQL receipt/delivery key use `'room-agent/v1:'+sha256(logicalKey)` with a trusted UTF-8 SHA-256 implementation and exactly 64 lowercase hex digits. Preserve the accepted logical key and canonical binding.
The global owner request ID may intentionally equal this derived key. Compare exact operation kind, canonical binding, source and scoped delivery rows on replay. Any cross-kind collision returns `request_conflict`; never adopt the other receipt or allocate a replacement key.
On a hit use immutable source joins (including source turn’s original taskRunId and delivery’s recorded source_attempt_id) to construct the exact 19.1 binding with the supplied request bytes.
Compare receipt kind, binding and scoped rows. Match returns original receipt, mismatch `request_conflict`; existence alone confers no authority. Do not call the ready-only `decideRoomAddress` on replay.
On a miss, prohibit fresh admission when restored/quarantined (`restoreOriginStore(db).origin()` in the same transaction; corrupt evidence fails closed). Prior receipts can still be inspected.
Fence fresh autonomous work under the existing room `text_only` recovery restriction. For this inert leaf, exclude a source turn linked to a continuation review. The later engine must admit legitimate coding reviewers to local communication while limiting coding access to the immutable artifact, with no commands or writes. Coding rebind never reauthorizes copied D work.
Owner start checks workspace, room, current selected membership and legacy holds, then validates every requested ref via `readAuthorityGrant`, `ownerGrantApplies` and exact owner/revision/subject.
Reject an invalid initial selection before writes. Capture each selected bot’s profileVersion and B connection identity from `tx.bot`, `tx.modelBinding`, `readModelConnection`:
project the connection form of `ModelExecutionIdentity` (connectionId/modelId, providerId, revision, kind, validated endpoint, auth mode, artifactDigest/backendVersion for qualified local model).
Match bot.provider/model with selected B metadata. Require a configured stable record (active intent, valid endpoint; for local require qualification matching selected model). An unreachable configured endpoint can still queue.
Do not call `ProviderActivationService.resolve` here: `provider-activation.ts:39` uses a credential factory/secrets. Copy no secretRef, pending change, credentials, host-provider fallback or per-turn deadline.
Check `admitModelTransfer` under current room policy for selected members. Start writes root and bot tasks, one user message (target null for group; the room bot for direct), deliveries and one receipt.
On fresh peer send verify the stored facts described below. Apply pure `decideRoomAddress` to the reconstructed projection + actual current room membership. On `delegate` CAS sender ready→waiting for this child.
Check sender and recipient are current selected members. For the sender, require the persisted ChatTurn activation and settled Core run activation to match each other, and their identity to equal the sender’s immutable root pin. Owner edits after settlement do not invalidate this local tool call.
For the recipient, compare its current B metadata identity with its root pin and apply current room transfer policy before writing text. A mismatch refuses a fresh send with zero writes. A subsequent new slice for either bot must match that bot’s pin before activation.
Look up child’s ref list by recipient in immutable root pins; retain parent links and every originally captured ref. Never replace a changed revision, add a new grant or edit down a saved list.
Local send itself needs no physical-operation grant. Revoking one selected C grant does not freeze safe local conversation, siblings, or separately permitted operations.
At the later external boundary, authorization needs a valid matching captured ref for the concrete operation at **each** actual delegating level + recipient and the root mandate.
A revoked/expired/ref-revised grant can never serve as that witness. Another unchanged selected grant can authorize its own eligible operation; no union of partial grants or implicit reselection.
Confirm-mode/deny precedence remains C’s. This persistence leaf cannot dispatch any physical operation or promise that a pinned grant remains usable.

#### Author proof and durable holds

For a fresh peer operation `origin(...,true)` requires actual joined incoming delivery claimed, marked dispatching chat with null continuation review ID (this leaf), root ready, ready bot task, current memberships.
Check JSON/SQL identity cross-consistency as in `service-run-scope.ts:6`: workspace, room, turn, run, bot, source message/seq, task/delivery and pinned recipient. Reject legacy/broadcast turns.
Rebuild the run synchronously from the same locked DB using existing `event-record.ts` decode + `domain.replay` (or reuse `SqliteEventLog.loadAfter(runId,0)`); check contiguous sequence, aggregate identity/type.
Require `status='running'`, no terminal/cancellation, exact activeAttempt, `cv_<room>`/`ws_<workspace>`, exact bot model/pinned activation. Require a settled terminal tool-call round for this attempt/ordinal.
The accepted call ID is constructed as `${attemptId}_r${ordinal}_${providerCallId}`; require that prefix and nonempty suffix. Event settlement records the round, not individual provider call IDs.
The trusted in-process tool callback supplies that suffix. A string from a client/model cannot grant tool invocation. No external RPC or production claim constructor exists in this leaf.
Test with real queued rows from `start`; a test-only transaction attaches one matching marked ChatTurn and transitions the delivery to claimed. Commit real TaskRun create/admit/schedule/start/model-start/settle commands for that run via SQLite event log; no provider call.
The positive path must use the exact production join/replay verification. Merely inserting a dispatching turn, passing `RoomDeliveryOrigin` to the service or supplying a mocked permission callback is insufficient.

Old open/paused broadcast returns `batch_open`; old accepted/dispatching/prepared returns `room_busy`; unresolved old uncertainty returns `recovery_required` on new D starts. Preserve review-release semantics.
Conversely a ready/waiting/paused D root holds its room against **legacy executing** direct/broadcast admissions; check after receipt-first replay, before new legacy effects. Direct unaddressed group notes keep their existing path.
D roots can coexist in one room. The legacy unique room hold keeps its `review_id IS NULL` predicate and excludes marked turns. The separate unique D hold covers each marked task in accepted/dispatching/prepared/uncertain status regardless of `review_id`. A continuation review must never admit a second active D slice.
Before allowing legacy work after a root stop, include all marked accepted/dispatching/prepared/uncertain turns in the D hold read, including review-linked rows. Stop is not proof of cleanup. Pending queued rows under stopped roots are inert.
Count pending nonlocal/unknown D transfer pins in the old policy→deny barrier even after a user rebinds that bot local. A mismatched binding cannot silently repin a D task. Inspect older-schema transactions without querying D tables.

#### Acceptance, compatibility and limits of this leaf

- [x] File-backed SQLite, two handles, identical start race/reopen: one owner root, N sibling tasks, one user message/receipt and N queued deliveries. Changed valid payload conflicts. Swap A/B order under separate root IDs and prove recipient authority is identical.
- [x] From real persisted A attempt send twice with different call IDs to B. Two peer messages, A author/B target/actual source turn, one subsequent ordinary final reply; reject second final and unbacked cross-author SQL insert. Peer text stays attributed in SQL/application history/context. Marker-like text round-trips as text without asset I/O. Old wire frames for old histories remain unchanged.
- [x] Lost peer receipt after wait/stop/revoke/member removal returns original IDs and seq with no new row. Same ID altered target/kind/text conflicts. Preoccupy the bot key with an owner start and try the converse: both cross-kind reuses return `request_conflict` with no writes or authority changes. Inject trigger failure at final receipt write, reopen and compare counters/sequence/links before retry. Race independent processes or worker threads, bounded busy timeout.
- [x] Reject forged sender, wrong run/attempt/ordinal, absent or unknown settlement, legacy turn, wrong room/parent, reviewed/stopped source and removed current membership. Empty refs allow communication. Keep both refs after one revokes; replacement grant/revision absent in stored child. Reject stale initial grant. Accept a workspace-scoped grant whose projectId equals the hash of the stored workspace root for a null/null mandate; reject a different project hash.
- [x] Prove old holds both ways, independent D roots, duplicate active D slice rejected even with a non-null continuation review, group note, legacy finite broadcast and `taskId=coding` unchanged. After A’s tool round settles, rotate A’s key/model or bot profile while B stays pinned. A→B succeeds with A’s persisted identity. Rotate B before a distinct fresh send and assert refusal, zero writes and intact pins. Privacy denies before writes. Check allow→deny barrier with a queued cloud pin after member rebind. Restore-origin blocks fresh rows while identical archived receipts remain readable.
- [x] Migrate a genuine disposable v26 snapshot with bot reply, reviewed/uncertain turn, batch, receipt, grants and attachment metadata. Compare logical row bytes before/after, `foreign_key_check`, old lookup/once-final index/trigger behavior. Interrupt v27 publication and prove original v26 intact.
- [x] Advance `SCHEMA_VERSION` and profile manifest cap to 27. In `maintenance.ts:35` explicitly retain 26 in historical maintainable schemas. For v27 `heldRooms` counts distinct rooms with legacy holds OR D holds; keep old-schema summary exact. No pending receipt counted as model run/effect. Inspect/backup/reopen/restore a disposable archive and reject unsupported future 28.
- [x] Adjust current-version asserts/publication-failure triggers in store-sqlite `{broadcast,provider-connection,model-binding,model-pending,service-authority,desktop-capability,tool-admission,plugin-operation}-migration.test.ts`, `room-model-policy.test.ts`, `service-owner-receipts.test.ts`, `plugin-schema.test.ts`, `model-qualification-storage.test.ts`, domain `profile-backup.test.ts` and CLI `local-runtime/desktop-binding-migration.test.ts` as applicable. Simulated downgrade fixtures must recreate their actual predecessor DDL/remove v27 objects explicitly; genuine older-schema bytes remain fixtures.
      Run `pnpm check`, `pnpm build`, `pnpm format:check` for the eventual implementation. Tests assert no provider/secret/service factory is available; no model dispatch, root execution, transport contract or scheduling is qualified here.

- [x] Record meaningful behavioral RED→GREEN for start/send and migration guards, focused strict typing, final root check/build/format and exact proof/source pins. Update `docs/ocean/platform-stage-d.md` with implemented versus planned behavior; self-review and commit exact owned paths. Independent task review is required before the next leaf.

Keep this change limited to persistence and existing admission compatibility. Do not add engine scheduling, a transport endpoint, UI, a generic workflow/policy registry or another event journal. Additional focused files are allowed only when needed for the300-line limit; report the concrete split before introducing it.

19.2.1 accepted at `698c6ba` after full review and one scoped correction round:
I1–I6 and the actual format-2 D archive proof are closed. Root `pnpm check` passed
3761 source/165 process tests (44/36 configured skips), build/format0; source<=300.
Two nonblocking review minors remain mandatory F triage: synchronized race release
and the archived provider-ID predicate. This is inert storage, not autonomous execution.

### Task 19.2.2: Negotiate truthful addressed history before host execution

**Files:** modify `packages/contracts/src/local-runtime-queries.ts` (existing public
index re-exports it), `packages/tools-node/src/{local-runtime-client,local-room-client}.ts`,
`apps/cli/src/local-runtime/{client-compatibility,server,capabilities,queries}.ts`;
update existing `client-compatibility.test.ts` and tools-node
`local-plugin-compatibility.test.ts`; add tools-node `local-room-client.test.ts` and
CLI `addressed-history-process.test.ts`; update `docs/ocean/platform-stage-d.md`.
Exact-count compatibility maintenance also touches existing CLI
`model-negotiation.test.ts`, `plugin-compatibility.test.ts` and non-frozen
`test-fixtures/model-process-negotiation.ts`, `model-process-old.test.ts`.
The new process filename already matches vitest.process-cases.config.ts; no redundant
registration or extra protocol/client service. Frozen RC2 fixtures remain unchanged.

**Interfaces:** export `LOCAL_ADDRESSED_HISTORY = 'room.addressed-history-v1'` from
existing query contracts. Keep protocol1/LocalMessage shape and existing room methods.
Reuse hello clientFeatures and add optional `RuntimeWireContext.addressedHistory`;
undefined/default means false. Runtime capabilities include the feature, but hello
and status expose it only to clients requesting it. Extend the current identity
filter/context; preserve independent plugin/model/service negotiation, the first
status/stop capability positions and bounds80modern/64frozenRC2. Features grant wire
support only, never owner/bot/tool authority. Current connectDescriptor appends this
feature after its existing four features. An old runtime may ignore it: ordinary
history continues working without the returned feature.

The tools-node history decoder permits authorBotId!=targetBotId only when the returned
identity advertises the feature. Both IDs must be valid and non-null for any bot row;
turn ID remains required. Preserve ordinary/user frame rules, scope, contiguous seq,
strict base64/UTF-8 and byte bounds. A peer frame without negotiation is invalid_frame.
Keep getResult restricted to an ordinary final bot reply even for a modern client;
peer history is not a completed run result. No new body/attachment/asset interpretation.

On history.list, inspect returned candidate rows before producing a wire response.
If a client lacks support and its requested page contains a peer bot message, return
`client_upgrade_required` through the known query-error mapping. Never serialize that
peer frame, remove rows, skip sequence positions or rewrite author/target. Ordinary-only
pages keep their existing bytes. Modern pages use the existing wirePage budget and
continuous sequence. runs.result continues using the backed ordinary reply selector.
Inspect any other actual message-bearing read only for this concrete representation
risk; no general protocol rewrite or new event redaction system.

- [x] **Behavioral RED→GREEN and decoding.** Exercise current client hello feature,
      negotiated peer history, ordinary fallback against an older runtime, and explicit
      legacy refusal. Test no-feature peer rejection; null/missing/invalid bot targets,
      wrong scope/seq/base64/UTF-8; unchanged user and ordinary frames. A modern
      getResult must reject a peer row and accept the ordinary final response.
- [x] **Actual shared socket and independent client.** Reuse normal built runtime and
      existing local process fixtures; seed only synthetic accepted persistence/history.
      Connect current and frozen RC2 clients. Both read ordinary history unchanged;
      current reads exact A-author/B-target and final rows while RC2 gets an explicit
      upgrade error at a peer-containing page. Multiple small modern pages recover all
      consecutive rows; a legacy error creates no dropped-row cursor. Hello/status
      feature/cap bounds remain valid for modern/legacy/unknown-feature clients.
      At least one client runs in an independent process against the real socket;
      no model/provider/service call, task dispatch or fabricated new author schema.
- [x] **Verify without expanding delivery.** Owning focused tests/strict test typing,
      root pnpm check/build/format on frozen source through private runner, source<=300;
      commit exact paths and obtain independent review. Existing finite broadcasts,
      taskId=coding, receipt and cancellation semantics remain intact. No task-start
      endpoint, scheduler, model tools, GUI or native/live qualification in this leaf.

19.2.2 accepted at `486df4f` after independent spec/quality review0Critical/
0Important. Actual root3785source/166process (44/36 configured skips), build/format0;
16exact paths/max267 and all8frozenRC2 bytes independently verified. Normal built
runtime and independent clients prove the shared-socket history contract; no autonomous
execution or native/live acceptance is implied. Inherited fixture stdout noise is
recorded for F. Next19.2.3 engine details follow the accepted storage/wire interfaces.

### Task 19.2.3: Finalize a proven delegated execution slice

#### One run per execution slice

The room bot task owns the assignment and its wait. Each claimed delivery owns one
ChatTurn and one TaskRun. A model response can request several tools. A successfully
committed local delegation is the last action of that slice, even in mid-batch.
A's TaskRun succeeds at that local step; its assignment is still waiting for B.
There is no final assistant answer from A at this point.

Do not issue core Wait/Resume, retry or checkpoint. Wait keeps activeAttempt;
Resume returns to running, which beginAttempt rejects. The first model start also
pins the activation and deadline to that run. Neither changing the deadline in
place nor pretending the child result is a retry preserves those facts.
A verified result delivers new input to the _same_ A task, with a new ChatTurn,
TaskRun, attempt and bounded activation window. Keep the root member identity pin;
recheck current binding/privacy. Never reselect a replacement model on resumption.
The delivery records distinguish B's result from A's original assignment. Build
the continuation context from bounded committed room/task history through its input,
not an old in-memory messages array or a saved half-executed assistant tool batch.

#### First leaf: stop and finalize the local slice inside runTurn

Observable: feed the common engine a scripted, settled tool-call round and an
in-process tool returning evidence of a committed delegation. It skips the suffix,
commits exactly one TaskRun success for the local step, and resolves as yielded
without another provider request, answer preparation or a child-completion promise.
This is an engine contract exercised with test doubles. No production room source,
send endpoint, runnable host job, or permission to claim deliveries in this leaf.

**Files:** production and focused tests below are under `packages/application/src`; also update `docs/ocean/platform-stage-d.md` with the narrow implemented/planned boundary. No gratuitous index edit.

Implementation map:

- New `room-slice-handoff.ts`. Define a readonly `RoomHandoff` with string
  turnId, taskRunId, attemptId, childTaskId, deliveryId (outbound) and callId
  (fully qualified engine invocation). Check each with validConversationText,
  capped at 128 UTF-8 bytes for IDs and 512 for callId. expectedRunVersion is a
  positive safe integer whose successor must also be safe for Complete.
  Internal `committedRoomDelegate(proof: RoomHandoff): ToolResult` validates and
  freezes a copy of just those fields. Create a fresh frozen ToolResult with
  isError=false and fixed output "Room delegation committed". A module-private
  WeakMap<ToolResult, RoomHandoff> associates that exact object with the proof.
  Internal `roomHandoffOf(result: ToolResult): RoomHandoff | undefined` reads it.
  A clone, ordinary field or identical text cannot create the association. Keep
  the factory out of the barrel. The future local delegate source calls it only
  after durable admission. The first leaf uses it only in tests.
- Same file: `finishRoomHandoff(input: TurnInput, proof: RoomHandoff):
Promise<YieldedRoomSlice>`. Submit Complete once via executeWithDisposition:
  commandId = 'room-handoff-complete/v1:' + proof.turnId, taskRunId = input.taskRunId,
  actor = RUNTIME_ACTOR, expectedVersion = proof.expectedRunVersion, payload =
  {attemptId:proof.attemptId, summary:'Room delegation committed'}. Reuse domain
  guardModelDispatch for unresolved requests and missing required provider usage.
  A lost/throwing commit response permits one lookupCommand of that unchanged
  command. Require committed or replayed receipt (or exact lookup) with matching
  commandId, taskRunId, version = expectedVersion+1, exactly one task_run.succeeded
  at that sequence, same aggregate type/id, causationId, actor and exact payload.
  Read actual state: same run, head version, succeeded terminal summary and active
  attempt. A missing/conflicting receipt or mismatch yields uncertainty. Never
  issue a new-head Complete, call beforeComplete or re-enter the model loop.
- `types.ts`: add `YieldedRoomSlice = {readonly kind:'yielded'; readonly
handoff:RoomHandoff}`. Keep the existing TurnOutcome and ACP StopReason.
  In `turn.ts` declare the room overload first: runTurn(input, room:{readonly
  turnId:string}) -> Promise<TurnOutcome | YieldedRoomSlice>. Declare the ordinary
  overload last: runTurn(input) -> Promise<TurnOutcome>. Use one implementation,
  exclusion set, finally and private loop. Static tests must assert ordinary calls
  AND Awaited<ReturnType<typeof runTurn>> are exactly TurnOutcome, and the opt-in
  call includes YieldedRoomSlice. Check ACP can still access outcome.stopReason.
- `tool-round.ts`: change executeTools' result to a union with dispositions
  continue / uncertain / delegated(proof). For a WeakMap match check exact
  context.run, attempt and generated call id at the invocation site. Before any
  later call, append tool history entries for skipped calls with the existing
  provider call IDs ("Not executed: delegated"); ordinary calls still run serially.
  Uncertain/rejection wins, even if accompanied by handoff-like fields. A genuine
  carrier with contradictory identity/error stops uncertain rather than continuing.
- `turn.ts`: preserve settlement-before-tools, admission limits, normal failure and
  cancellation-before-invocation behavior. On delegated, require the opt-in turnId
  to match before calling finishRoomHandoff. A misplaced genuine carrier stops
  uncertain, never executes another tool. Process the recorded delegation before
  acting on a later signal; it cannot be undone by cancellation. A conflicting
  committed cancellation/version prevents success. Any unproven exit after a
  possible effect uses existing uncertain handling; no model/tool retry. Existing
  history sink gets the bounded completed/skipped batch, never a synthetic final.
- New `room-slice-handoff.test.ts` using test-fixtures/model-turn and real in-memory
  TaskRunService. Reuse combineChatTools for test routing. Preserve existing
  public exports and existing hosts' types; no production edits to chat execution,
  domain, SQL, tools broker, provider adapters, CLI, or owner protocol this leaf.

The approved cap split adds `packages/application/test-fixtures/room-slice-handoff.ts`.
The review fix adds a pending-notification abort regression to the existing
`packages/application/src/turn-safety.test.ts`, with a post-notification signal fence.

Transactions in the first leaf: existing model-start and settle command transactions;
the test's trusted producer stands in for the future already-committed send below;
then a distinct version-bound Complete events+command-receipt transaction. No
nested store.atomic/tasks.execute, cross-store transaction promise, or child wake.
The downstream source/storage integration must provide the postcommit evidence
and crash repair below _before_ any producer is reachable in the host.

RED -> GREEN behavioral cases (target the common engine, not just type helpers):

- [x] Provider requests [delegate, physical sentinel]. Return the registered result with
      the real running attempt/version; never resolve a child result. Assert one
      provider start+settlement, no sentinel, skipped suffix history, no beforeComplete,
      one local Complete receipt/event, no answer text, immediate resolved yield.
- [x] Plain tool output containing identical delegate text/JSON, including a forged
      disposition and IDs, stays ordinary. Test an ordinary local send too: following
      calls and the normal model answer are allowed. Composition still rejects collisions.
- [x] Unknown model settlement -> no tool. First tool unknown/throw -> no delegate,
      no following call, no Complete. Cross-run/call/turn proof or stale pinned
      version -> no success or redispatch. A host without opt-in cannot yield.
- [x] Signal before invocation -> no admission. Signal after known commit -> truthful
      local completion if the version still matches; a committed cancellation wins
      its CAS. Matching lost Complete reply is provable by exact receipt, never by
      re-entering the model loop. Keep existing tool/deadline/usage/overlap tests green.

- [x] Run focused behavioral RED→GREEN and strict node test typing; literal root
      pnpm check/build/format on frozen source through the private runner; source<=300.
      Preserve old overload/ACP/ordinary tool/deadline/usage/overlap behavior. Self-review,
      commit exact paths and obtain independent spec/quality review before the next leaf.

Later leaves, expanded only against accepted interfaces, add durable claim/handoff
repair before generic chat recovery; versioned parent-result lineage and once-only
publication; guarded runtime tools/host/current physical C ancestry/root limits and
actual mixed qualification. The wire representation of yielded slices/final results
must preserve old clients or explicitly require upgrade before any producer. In
particular current getResult is ordinary-only and turnStates is closed. No such new
status, addressed final, schema or host producer is introduced by19.2.3. Full D and
its native19.3 gate remain incomplete; this engine foundation does not replace them.

19.2.3 accepted on `dc78dbf` after one scoped correction round. Final root gates:3819 source/166 process passed; build/format0. The initial independent review found a synchronous pending-notification cancellation gap; the four-line invocation fence and behavioral regression were independently accepted. This remains an engine foundation, not production autonomous execution.

### Task 19.2.4: Durable room slices, result delivery and local recovery

Detailed next leaf frozen after D19.2.3 acceptance at `dc78dbf`.
Binding: canonical Task 19.2/19.2.3, plan Global Constraints verbatim, AGENTS.md, spec §§5/6/8/10/11.
Acceptance is a real SQLite application trace with scripted providers using executeChatTurn → runTurn.
A committed start addressed to A drives three slices: A delegates, B publishes, A reads B and finishes.
Each invocation handles at most one delivery; no waiting Promise, polling worker or second model loop.
No production room producer, job, RPC, startup auto-dispatch, physical tools or native qualification here.

#### Storage and public meaning

Keep the two v27 tables, existing run events, command receipts, messages and conversation receipts.
Keep ChatTurn.roomDelivery v1 immutable. Add optional sibling roomHandoff: {version:1, ...RoomHandoff}
and roomSliceDisposition?: 'yielded' only on marked turns. Migrate existing rows byte-for-byte, including
JSON payloads. Both optional fields stay absent until a new lifecycle write supplies evidence.
roomHandoff is a saved local intent, not success; disposition is set only on verified completion.
For yielded slices store status='completed', disposition='yielded', text='', preparedVersion=null;
stopReason's legacy default is not a model stop for this path. No final message, decision or reply ID.
Here completed means the slice's local run succeeded; A's bot task still says waiting(child).
Do not add 'yielded' to the closed ChatTurnStatus / contracts turnStates or overload codingTaskId.
packages/store-sqlite/src/room-runtime-reads.ts (run) and packages/application/src/chat-receipts.ts
(readChatRun) currently synthesize reply_<id> from completed alone. Both must return resultMessageId=null
for completed/yielded and getResult returns null. Reject malformed dispositions before projecting a final.
Ordinary completed turns still require their exact final, including B's self-targeted reply below.
Production producers stay disabled until the negotiated task view and observers can expose the waiting
child/disposition truthfully and old/new run lists, receipts, capabilities and clients pass compatibility.

Bump schema.ts to 28; add v28 step after migrateRoomTasks in schema-migrations.ts (fresh/v26 pass via v27).
Use the existing owner-absent, transactional rebuild and foreign-key check. Save/drop triggers referring
to deliveries on OTHER tables (ocean_addressed_message and ocean_room_turn_insert), then rebuild only
ocean_room_deliveries with the same columns, FKs, bounds, v1 rows, state vocabulary and uniqueness.
Copy named columns verbatim before new INSERT guards; replace the table and reinstall its indexes,
target/immutable triggers and both external triggers. Do not regenerate v27 histories, proofs or waits.
Keep the v27 forward predicate unchanged for start/message/delegate. Add result to both kind CHECKs;
one result per delegated assignment (unique from_task_id WHERE kind='result'), position=0, nonnull origin.
Result cause_id = original delegate delivery ID, NOT necessarily B's last input. Join that edge P→B,
B.parent_id=P.id, P.waiting_child_id=B.id, equal workspace/room/root/assignees; source turn's marker
must instead join its own claimed input on B. This permits B to finish on a grandchild's result.
Insert ordinary B final BEFORE result delivery in the same transaction. Result INSERT must find exactly
that final by reply_<sourceTurn>, seq, room/workspace, author=target=B and producing turn, plus P's
previously yielded delegate slice. No change to ordinary final unique index or peer-message predicate.
Extend decodeRoomDelivery/strict marker decode; reject bad state, version, missing keys, contradictory
status or foreign marker; preserve legal v27 rows. Protect immutable proof, one-way yielded disposition
and immutable full room activation (not just identity), validation on actual INSERT/UPDATE including
chatStorage's INSERT ... ON CONFLICT; permit the existing valid old snapshot on an upsert.
In packages/store-sqlite/src/maintenance.ts add 27 to historicalSchemas when SCHEMA_VERSION becomes 28.
Doctor/backup/restore must recognize an unmigrated v27 snapshot and preserve its hold and owner checks.
Historical conversation reads use the existing legacy-schema mode. Only current v28 gets lifecycle writes.
A v27 wait without an original proof stays inert; migration cannot reconstruct authority from a later head.

#### Claim one committed delivery

Internal claimRoomDelivery(deps, deliveryId) → claimed(turn, provider, messages, parentRunId) | existing | held.
The delivery ID is a selector only. Resolve target from stored joins, require exact original receipt,
binding, history, seq, kind, sender/recipient, positions and parent/root; never authorize by request IDs alone.
In one synchronous store.atomic (BEGIN IMMEDIATE), require root and recipient task ready, exact member
and owner scope, no review/restore/quarantine, ordinary room/batch hold or active marked turn for this task.
Do not call roomHold(roomId) as a blanket veto: it includes this ready root. Do check activeChatTurn,
broadcast and scoped pending effects (including unscoped legacy). Independent marked tasks may progress.
Start may claim its selected owner edge; message may claim its own allocated child solely from committed send;
delegate may claim only after its sender's exact yielded repair, consumed input and waiting-child join.
Result may claim only the named parent after the committed child completion / matching wait release.
Select the matching queued result first; otherwise earliest eligible queued (seq,position,id). CAS exact
id/state; never use lastDeliverySeq as a threshold. Advance it monotonically as a summary at consumption.
Check fixed 2 concurrent / 32 total slices under the claim lock using marked turns joined to root; count
active uncertain/held work conservatively, never reclaim capacity on process disappearance alone.
Require current roomTaskIdentity equal immutable root pin, exact current binding and current room transfer
policy. Use bound activation resolver/clock, freeze a fresh bounded snapshot, providerAdmits, never null
or fallback; a continuation may start after A's first deadline. Reject altered identity, expired activation.
Keep this narrow leaf local communication only: fail closed on unsupported physical/coding scope;
scripted fixture can use empty selected refs/permissions. No legacy codingTools or grantedTools on marked turns.
Build bounded context from stored history through the claimed seq, no future messages, input exactly once;
reuse room-context attribution/byte limits. Current peer/result is attributed bot data, never passed through
finishContext as owner text/attachment authority. Bind user-start attachment resolution to its actual input.
CAS queued→claimed AND insert one accepted ChatTurn with new IDs, tr_<turn>, exact roomDelivery and input
message/seq, immutable bot/binding/activation. No new owner message/receipt. After first write throw on
every failure for rollback. A duplicate returns existing linkage without authority to dispatch.
Parent run for start=null; message/delegate=sender source turn's run; result=P's prior yielded run on the
original delegate, not B's final run. Derive from joins; TaskRun.parentTaskRunId is lineage, not authority.

#### Execute and commit the handoff

Inside packages/application/src/chat-turn-execution.ts add one optional third module-internal argument
to executeChatTurn(deps, input, room?): Promise<ChatTurn>. RoomSliceExecution is a readonly pair
{parentRunId: TaskRunId | null, tools: GrantedPluginTools | null}. The trusted claim caller supplies both
from committed joins and its scoped local source. Existing input carries turn/messages/provider/signal/emit.
Require room and turn.roomDelivery together. Use room.parentRunId in Create and combineChatTools(room.tools)
for marked preparation. Choose the marked runTurn overload and call concrete room publication/repair functions
using deps.store/tasks/clock. The ordinary caller keeps its current two arguments. No callback registry.
Keep one CreateTaskRun → preparation → dispatching → runTurn → publication path. Reuse chat-create-<id>
with identical expectedVersion=0 and payload on replay, including parent; separate command, no SQLite
transaction across await. Fresh slice uses ordinary finite activation limits, not a refreshed old run.
Only the winner of accepted→dispatching CAS may enter runTurn; test contend across two connections.
Recovery of accepted can reuse the same IDs only with unique ownership and proven absent or exactly-created
run, no attempt/model start/effects, unchanged activation, authority and budget. No new IDs on restart.
Revalidate pinned activation/deadline before taking the executor CAS; a missed deadline is not replayable.
Separate discovery of eligible unstarted claims from execution; legacy recoverChats never starts a model.
Use combineChatTools with one call-identity map; one internal room delegate source is sufficient here.
No tools offered to a text-only B. No room tools on legacy turns. execute closure captures stored turnId;
engine supplies taskRunId/attemptId/fully-qualified call.id. Model may supply only target/text.
Extend persistRoomTaskSend with an internal result for delegate {receipt, proof}, preserving inert API's
receipt shape and original start/message/receipt replay. Trusted wrapper requests this variant, not the model.
Inside the SAME send transaction use origin(...,true)'s dispatching turn, claimed input, ready task/root,
owned attempt, exact settled terminal tool_calls and ordinal prefix, matched activation/member/privacy.
Check required usage/zero unresolved scoped effects. Any core tool budget reserve/settle must PRECEDE this
head capture; never settle or release a core reservation between saving expectedRunVersion and Complete.
Write child+outbound+wait+message+receipt as already implemented, plus immutable roomHandoff to source turn
with liveRun.version and outbound delivery ID. On receipt-first replay validate binding AND ORIGINAL saved
proof joins, actor/call, child and input. Missing proof = inert historical receipt only, no execution carrier.
Return from atomic before invoking internal committedRoomDelegate(proof); never export factory or synthesize
a newer expected version. A committed delegate is the last tool of this slice; queued child cannot yet run.
Use runTurn(input,{turnId}) only for the marked path. Handle yielded BEFORE ordinary answer/failure; use
saved state, not stale captured dispatching ChatTurn (updateChat currently compares status/review only).
On any uncertain/exception after admission, re-read marker before cancellation/generic failure handling;
a stale put must never erase a committed handoff or misclassify it as a normal final/failure.

#### Local completion, result and repair

repairRoomHandoff reads full durable joins and exact command identity; reuse finishRoomHandoff's command
construction and receipt/head predicate internally. Do not fabricate a TurnInput/provider just for repair.
If local Complete not recorded, only submit the SAME pinned command on proven matching running head,
settled model, no unknown effects and authority still valid; optimistic version must match. For a lost reply
look up the identical command; conflicting/missing evidence or a different head never authorizes a rebase.
Inside store.atomic reread proof, outbound delegate/receipt, input claim and exact waiting pair. Add one
synchronous RoomTaskTransaction.completeEvidence(command: Command<'Complete'>): RoomCompleteEvidence | null.
RoomCompleteEvidence = Readonly<{run: TaskRunState, headEvent: TaskRunEvent, receipt: CommandReceipt | null}>.
Outer null means inconsistent binding, invalid/missing run or unavailable evidence.
For unstarted-claim recovery expose a separate locked run-evidence read that distinguishes
a proven absent aggregate from unavailable/invalid evidence; only proven absent or
exactly created (zero attempt/model/effect) can re-enter the same accepted execution. Inner null means this
valid run has no receipt for that command ID. Reuse SQLite command-commit.ts's synchronous request-bound
lookup by extracting it for both callers. Replay actual contiguous events on this connection, returning
their decoded last event and created run. Compare receipt event with headEvent in full before release.
Extract the existing finishRoomHandoff receipt/head predicate as a pure internal helper shared with repair.
Validate turn/root pinned activation against run.modelExecution, exact attempt and ordinal, terminal tool_calls
settlement and required usage for delegate (terminal model stop matching prepared final for ordinary reply).
Reuse the predicates from room-task-origin.ts for shared identity/settlement checks independently of live status.
tx.chatFailureEvidence(run.id) must match run.version and report zero related/unscoped pending effects.
Every read and put uses the caller's same write lock. No async service.state as publication authority.
Consume old input, advance task cursor/revision and mark turn completed/yielded together. Parent remains
waiting; child becomes eligible by these facts alone. Replaying verifies all immutable facts, no second wake.
If effects/restoration/contradictory joins or stop prevent repair, retain a scoped hold, original proof and
truthful core evidence. Failures, cancellations and uncertain model/tool outcomes never create result/wake.
Recovery routes marked turns to room repair BEFORE publishKnownChatFailure/generic recoverChats logic;
a room turn must not fall through even if no valid handoff is found. Unstarted claims classified separately;
a dispatching turn without affirmative local finalization proof stays held, never runs again automatically.
For a normal marked final keep beforeComplete→prepared with exact version/text/stop, then normal core Complete.
For a prepared room final use the ordinary executeStep Complete identity cm_<run>_Complete_<preparedVersion+1>
and lifecycle.completeRun's summary (trim, first 200 characters, empty fallback) in live and repair paths.
Extract shared command/summary construction as needed. Verify attempt, actor, settlement and exact success
receipt/head via completeEvidence before publishing. Legacy recoverChats uses a different recovery command.
Use the common final message builder and one transaction for B's ordinary reply, completed turn, consumed input,
and advanced cursor. When B's assignment drains, also complete B, insert the inverse result delivery/receipt
and CAS P waiting(B)→ready, clearing waiting_child_id. Share this path between live publication and restart.
Result request key e.g. room-result/v1:<sha256(original delegate id)>; binding canonically includes original
delegate, root/P/B, final producing turn/run/attempt, final id/seq and exact content (or its digest).
Immutable result receipt reply is that very message. Compare original receipt/final/edge/turn and contents on
replay even after P advances; no second seq, message, delivery or wake. Mismatch rolls back, never overwrites.
Only a delegate-created task returns to its original waiting parent. Start/message-created tasks publish
normal finals without a parent wake. Close root when all assignments are finished and no queued/held/unknown
work remains. Queue ruling: consume exactly the current input. Earlier queued rows keep their original seq
and state. Keep B ready and P waiting until B has drained its inputs, then return exactly one assignment
result referencing its terminal slice's final. Exercise persisted rows through the existing delivery port.

#### Owned changes, evidence and release boundary

packages/domain/src/chat-turn.ts owns optional persisted fields and the structural handoff shape.
Under packages/application/src: room-task-records.ts, room-task-send.ts, room-delivery-claim.ts and
room-slice-publication.ts own the lifecycle and transaction ports (delivery/nextInput, claim/consume CAS,
advanceTask(expectedRevision), completeEvidence). chat-turn-execution.ts, direct-chat-publication.ts,
room-slice-handoff.ts, lifecycle.ts, commands.ts, room-context.ts and chat-receipts.ts adapt common paths.
conversation-ports.ts already declares tx.chatFailureEvidence. Its SQLite implementation is conversations.ts.
Under packages/store-sqlite/src: room-task-slice-schema.ts, schema.ts, schema-migrations.ts, maintenance.ts,
room-task-storage.ts, room-task-origin.ts, command-commit.ts, chat-storage.ts and room-runtime-reads.ts.
Group added SQL in room-task-slice-storage.ts to meet the 300-line cap. Add focused regression fixtures
and document implemented/planned scope in docs/ocean/platform-stage-d.md during implementation.
Independent acceptance scenarios (temporary on-disk SQLite; assert committed rows/events, not callbacks):

1. One slot, scripted A delegate with suffix, text-only B final, fresh A final after A1 deadline. Exactly
   three runs/turns, same A task, expected parent IDs, no A1 reply, no B tool definitions, result only once;
   contexts include attributed B text exactly once; unrelated work progresses while A waits.
2. Two claimers same delivery; crash after claim and exact Create, before/after committed model start.
   Only proven unstarted eligible; no duplicate request. History/inputs survive close/reopen.
3. Crash after delegate transaction, after Complete before yield, after yield before child claim, after
   child Complete before publication, after result commit before response. Repair twice, assert all joins,
   one receipt per operation, no new provider/tool calls; failure injected mid-transaction rolls back.
4. Alter payload, proof/head/receipt, cause, child/parent/task/run/attempt, peer final, member or pin;
   restore, revoke, stop, unscoped unknown or unrelated scoped effect. Only proven affected work holds.
5. Nested P→B→C→B→P uses original delegate despite B's different final input; message-only child never
   wakes sender. Seed an earlier queued row via storage, verify exact consumption, one eventual assignment
   result only after draining and no extra admission API. Raw SQL rejects inverse forgeries.
6. Populated v27→28 and older supported chain: byte-compare prior rows, replay inert receipts, FK check,
   backup/restore hold, direct/broadcast/old-client history and final reads unchanged; no migration wake.

Future production gate: connect send/delegate/state, scoped state reads and existing runtime jobs/controllers;
recheck pins/privacy/stop/restore at every actual committed start; intersect mandate + every selected current
C grant under executor and each actual delegating ancestor; no physical widening or reviewer write/command.
Enforce 64 provider starts/64 tools at actual commit, root concurrency/total across all producers, unknown
usage never zero, pause once before third identical normalized handoff without verified progress. No host
enablement until those races, one-slot restart/disconnect/two-client proof, mixed outages/no fallback and
separate native/live cloud→local→cloud/offline gates pass. This leaf alone does not complete Task 19.2.

**Concrete test and integration map:** new `packages/store-sqlite/src/room-slice-lifecycle.test.ts`,
`room-slice-recovery.test.ts`, `room-slice-integrity.test.ts`, `room-task-slice-migration.test.ts`;
shared `packages/store-sqlite/test-fixtures/room-slices.ts`, reusing existing room-tasks construction.
Preserve existing room-task start/send/replay/context/holds/lineage, direct/broadcast and
room-runtime-reads regressions. Add only necessary public application service/type exports
in `packages/application/src/index.ts`; never export the evidence factory.
`packages/domain/src/profile-backup.ts` must explicitly admit28; current27 historical
maintenance remains supported. Genuine populated27 fixture must come from committed
BASE schema, with provenance/pins, not a current-schema downgrade labeled as old.
Expectation-only current-schema/count changes in existing tests are permitted only
when inventoried and reported; no frozenRC2 fixture edits, weakened guards or silent scope.
Split concrete lifecycle SQL/fixtures if physically required for300 lines; no generic framework.
The single sequential application executor proves no held wait, not runtime scheduler
fairness or native containment. Those remain the later host/19.3 gates.

- [x] Implement the coherent claim/handoff/result/repair path with scripted providers
      and real on-disk SQLite through the common executeChatTurn/runTurn.
- [x] Prove the six scenarios above, actual behavioral RED→GREEN, exact durable
      receipts/events/lineage, transaction rollback and close/reopen recovery.
- [x] Preserve old admission, history, read, backup and profile semantics; no host producer.
- [x] Run focused/strict tests, final frozen root check/build/format, physical≤300;
      self-review, exact-path commit and independent spec/quality review.

19.2.4 accepted at `c3d7c21` after one scoped correction round: all six Important
findings and the genuine27 archive/replay evidence gap were independently closed.
Final frozen root gates:3899 source/166 process passed,44/36 configured skips,
build/format0. The scope is the local SQLite/application lifecycle; Task19.2/D and
host/native/live qualification remain open.

**Accepted additions to the file map:** concrete application helpers
`room-delivery-evidence.ts` and `room-slice-result.ts`; narrow existing
`direct-chat-admission.ts`, `turn.ts` and `tool-round.ts` evidence/observer handling.
The cap splits add `packages/store-sqlite/src/room-slice-claims.test.ts` and
`room-slice-publication.test.ts`, moving existing cases without duplicate registration.
`packages/store-sqlite/test-fixtures/room-slices-v27.json` is normally formatted
synthetic BASE schema/row data; `room-slices-v27.ts` shares its read/seed helper.
`apps/cli/src/ocean/room-task-backup.test.ts` proves source-deleted genuine27 restore
and exact inert receipt replay. The nonfrozen
`apps/cli/src/local-runtime/addressed-history-process.test.ts` constructs an exact
prepared/Core-confirmed synthetic final; its client/history/result assertions are
unchanged, and it remains wire evidence rather than autonomous engine qualification.
`room-task-holds.test.ts` and `room-task-transfer.test.ts` reject an unproved
completion before using a synthetic terminal phase for their unchanged hold/privacy
assertions. This does not qualify Core cancellation or cleanup.

Current-schema expectation maintenance also covers domain `profile-backup.test.ts`;
store `broadcast-migration`, `plugin-operation-migration`, `plugin-schema`,
`provider-connection-migration`, `room-task-migration`, `desktop-capability-migration`,
`model-binding-migration`, `model-pending-migration`, `model-qualification-storage`,
`room-model-policy`, `service-authority-migration`, `service-owner-receipts`,
`tool-admission-migration` tests; CLI `desktop-binding-migration.test.ts` and the
backup test above. Only current schema/publication/future expectations changed.
`test-fixtures/room-task-v26.ts` removes the three new trigger dependencies before
its existing reconstruction. Genuine26/27 and all eight frozen RC2 fixtures remain
unchanged. The full accepted range has59 paths; modified code/test helpers stay≤300.

Deferred: configured generic recovery digest forwarding belongs to the next host
integration; inherited test stdout and the marked-run prior-history scan belong to
F triage. These minor items do not qualify the remaining production gates.

### Task 19.2.5: Execute owner room tasks through the normal runtime

IMPLEMENTED source leaf, accepted at `0f7435b` after two scoped fix rounds and clean independent review. No installed release enablement.
Final root check/build/format: exit0; 4018 source and172 process tests passed,44/36 configured skips remain separate qualification gates.
Base: accepted lifecycle c3d7c21; acceptance HEAD 79edcaa. Parent Task 19.2, its remaining
production gate, Global Constraints verbatim, AGENTS.md and autonomy spec §§5/6/8/10/11 bind.
One owner submits to a group; A delegates, B answers, a fresh A slice sees B’s attributed result.
Two independent clients read the same root, tasks and three runs; A1 yields without a final.
One B final backs one result delivery; A2 publishes its own answer once. No waiting process.

#### Owner contract and eligibility

- Add one negotiated capability/hello feature `room.tasks-v1` for four methods, not four caps.
  Require it AND addressed-history support, authenticated owner socket and eligible durable host.
  Filter hello AND status; enforce on every method even for raw callers. Missing: client_upgrade_required.
  78+1 ≤ modern 80; existing negotiation ≤16 strings of ≤64; old modern/RC2 (≤64) frames unchanged.
- `roomTasks.start(RoomTaskStart) -> RoomTaskReceipt`: same explicit workspace, room, requestId,
  text, initialBotIds, participants/selected grant refs and mandate; no actor, provider or task IDs
  supplied by owner other than existing mandate.codingTaskId. Bind owner from profile/exclusive runtime.
  Share RoomTaskPersistence.start transaction with new startHosted(input), which requires tx's bound scope
  and stamps it on fresh root insert. start(input) stays inert (NULL). Replay never stamps a root.
  Read bound receipt first; same input returns original immutable IDs/order even after stop/rotation;
  altered body, participants, order, room, operation or selected revisions conflict; no wake on replay.
- `Scope={workspaceId,roomId,rootId}`; `roomTasks.get(Scope & {page?:string})->RootView`;
  `roomTasks.stop(Scope & {requestId,expectedRevision})->StopReceipt`;
  `roomTasks.observe(Scope & {cursor?,waitMs?})->{kind,cursor,instanceId,view:RootView}`.
  StopReceipt = scope + requestId, expectedRevision, committed root revision and status:'stopped'.
  First stop CAS on root revision/status; exact prior receipt returns even if revision advanced;
  distinct stale request conflicts; completed root is terminal. No claim on get/observe/receipt replay.
- RootView = scope, root status/revision, fence reason or null, counts {active,slices,modelStarts,
  toolCalls}, rows:Row[], nextPage:string|null. Rows discriminated by `type`, tagged task{id,parentId,botId,status,waitingChildId},
  delivery{id,kind,fromTaskId,toTaskId,causeId,state,messageId,seq}, slice{taskId,deliveryId,runId,
  turnId,turnStatus,taskStatus,version,disposition:'yielded'|null,resultMessageId,pendingDecisionIds}.
  Include a bounded enumerable hold code per affected row (unknown/unproved if evidence missing);
  queued is queued, stopped is a fence, reported completion uses actual prepared/final + Core/head.
  Join exact workspace/room/root, task/turn/slice/input and decision/run facts; fetch large text only
  through existing history/result APIs. Never emit resultMessageId for yielded/unproven responses.
  Order by tag (task,delivery,slice) then binary ID (turnId for slice). First page omits page; bound to
  50 rows AND MAX_FRAME−1024 serialized bytes including envelope/cursor, ≤200 decision IDs/slice.
  Sign nextPage over purpose, instance, scope, full projection hash, last tag/ID; changed view returns
  resync_required. Observe returns first page and own wait cursor. SDK validates scope/typed bounded rows and follows nextPage.
- Extend RuntimeObservers' signed instance/scope mark with rootId and hash of complete durable
  projection (incl. child/decision changes), existing wait limits and detach signal. No execution wake.
  Snapshot on initial attach, resync on foreign/expired mark or restart; fresh get for pages at new mark.
- No new meaning of turns.submit.taskId, ACP, broadcasts, rooms.history, runs.cancel or runs.result.
  Eligible ordinary durable source runtimes advertise and serve this feature by negotiation. The sole
  test scheduling override is trusted host capacity 1. Maintenance/quarantine and ephemeral hosts refuse.

#### Host, scheduling and shared tools

- Compose a small RuntimeRoomTasks in startLocalRuntime beside RuntimeBroadcasts; use runtime.chat's
  task service, conversation store, digest, clock, scoped tool providers, provider.resolver and images.
  Supply executeChatTurn(deps,{turn,provider,messages,signal,emit},
  {parentRunId,tools}); retain runTurn, settled-request-before-tool ordering and branded handoff proof.
- Coalesce wake after eligible commits (new admission, send/result, finish, readiness change) and startup.
  Scan eligible ready roots round-robin, stable input ordering per existing claim; do not spin on held
  work, or let a blocked first root starve later ones. Claim again under lock, not from scan results.
  Only 'claimed' executes; 'existing' does not attach a new executor; 'held' skips that delivery.
  Reserve host slot synchronously before claim; register controller/promise by run before yielding;
  on settlement finally remove both, release slot, schedule next. No parent promise waits on child.
  Distinct root or independent task can progress between A1 and A2; keep accepted direct/batch holds.
  Wire external run controllers into RuntimeTurns.attachControllers alongside broadcasts; use existing
  assertRuntimeDrained. Runtime stop closes new starts first and joins actual jobs before DB close.
- Split roomTools out of room-delivery-claim: room_send/room_delegate({toBotId,text}) and
  room_state({taskId}); closed schemas, no actor/root/room/grant fields. Runtime builds RoomTaskActor
  from captured turn.id, ToolEffectContext and expanded attempt/round/call.id. Use persistRoomTaskSend
  with exact binding; delegate alone returns committedRoomDelegate, skips suffix and closes A1;
  send creates its own constrained message child, never a waiting sender or a peer's independent task.
  State only for own/actual ancestor/descendant by verified edges in same root+room, live actor,
  minimal task/slice status and published result reference; no arbitrary sibling/other-room history.
- In marked executeChatTurn select combineChatTools(room.tools, scopedService, scopedCoding); resolve
  ONLY if frozen activation supports tools. Text-only gets undefined tools including no schemas or
  sandbox setup; still executes assigned provider. A null/unavailable resolver holds before dispatch;
  never normalize to null-provider deterministic text, switch backend, inherit legacy grants or retry.
  New slice gets a new deadline for the same pinned identity. Recovered claim reuses original deadline.
  Check current binding/profile/connection/qualification, membership, explicit transfer policy and
  restored/text-only quarantine at claim, prepare and each actual model start (including later rounds).

#### Current authority and exact effect boundaries

- Replace fail-closed physical/coding clauses of roomSliceAuthority and marked executor together.
  Build one pure per-candidate decision over transaction-supplied facts. From stored turn + input
  verify current task and original assignment edges (from/to, parent/cause/receipt/source proof);
  walk actual issuing tasks back to root, detect cycles/missing joins; result is a return on the
  original delegate, not a new source of grant authority. Never traverse unrelated room members.
  Evaluate recipient and each issuing ancestor against its OWN bot/room/workspace/project/coding
  subject from pinned root + persisted workspace/coding task. Owner start has no bot ancestor.
  Every captured ref for those subjects must still identify that owner's current active revision,
  membership, expiry and matching subject. No replacement, dropped stale ref or union across bots.
  For a concrete action require root mandate permits it AND each subject has a selected grant
  permitting the whole action/resource. Empty selected refs permit communication, no physical access.
  Existing C bytes/call limits, confirm modes, catalog/trust/account and resource restrictions apply
  to each contributing grant. Deterministically bind sorted exact contributing refs per subject;
  enforce tightest mode; only explicit required confirmation via existing exact C decision, no prompt
  inside autonomous scope, no confirmation overrides missing/revoked/ancestor authority.
- ServiceTurnTools currently iterates listGrants(); restrict marked selection to allowed aliases.
  Factor existing service-admission-prepare tool/catalog/bytes/arguments/resource eligibility for
  reuse against mandate and each subject. At tx.claim in ServiceCallAdmissionService AND its
  synchronous authorizeDispatch rederive trusted marked scope from DB runId (never optional client
  flags); compare exact selected basis incl. actual classification. Confirm expiry/rotation/revocation
  during async owner wait fails closed. SqliteServiceAuthority.claim uses journal.claimNow;
  journal the unique (chargedRunId,subject,grantId,revision) basis on each actual effect claim.
  Executor charges its own run. Each issuer charges the original issuing run proved by the historical
  edge's sourceTurnId/sourceAttemptId, under that issuer’s subject. Children/siblings share that debit.
  Extend SqliteToolJournal.grantCalls to count distinct invocations across executor and ancestor bases
  by chargedRunId+grantId, including prior C-format claims. At claim enforce maxCalls then at dispatch
  revalidate the same refs/revisions/limits incl. this claim once. Each invocation costs root one.
  The same attribution applies to coding claims/reads. An unknown alias/global-unknown
  takes C's existing conservative conflict scope; different paths/connection IDs do not prove disjoint.
- For coding mandate resolve reserved CodingTask and assigned ready worktree, matching owner/dev,
  leases and project digest. Mark only actual dev turn with validated codingTaskId (make immutable);
  other bots communicate, never become coding dev by receiving a message. Do not widen task-specific
  grants to other bots. In coding-turn-factory/CodingTurnTools project only permitted read/edit/preset
  actions. Marked selection reads policy/presets only: defer createCodingOperationSession/sandbox
  qualification to first actual coding invocation after settled model start; recheck scope before
  launch, guard read after async tools.prepare and retain exact cleanup evidence. No apparently
  unstarted accepted turn can have prepared a worker. Require guarded edit/test dispatch.
  At CodingApprovalService.consume (journal claim) and authorizeDispatch verify same current ancestry
  and exact binding/registered preset/lease. An owner vote cannot bypass scope. Keep writes/commands
  out of reviewer turns including service aliases granting mutation/command; in this slice restrict
  known reviewBotId of the selected CodingTask to room communications. Actual review is ONLY
  CodingReviewService.dispatch -> CodingReviewerPort.review({request,changeset,evidence}) -> bound
  verdict/findings; no chat/tools or implicit verdict. continuationReviewId is owner recovery, no role.

#### Serialized counts, stop and repair

- In store.ts/buildStore capture one private initially-null RoomHostScope={ownerId,epochId:string|null}.
  Expose bindRoomHost(scope,verified:{origin:RestoreOrigin|null,active:ProfileRebindRecord|null}):void once per trusted SqliteStore. runtime.ts
  calls it after exclusive ownership, restoredRuntimeAdmission/verifyRuntimeEpoch FS proof and ordinary
  host admission, before recovery. Freeze existing ownerId/epochId and fingerprint verified origin/active record.
  Inject same closure through SqliteEventLog→sqliteCommands, conversation, service and coding adapters.
  Under each actual lock compare current origin/active fingerprint, owner/epoch and root stamp. Native
  epoch null requires absent origin/active. Unbound adapters, missing/mismatched/invalid proof refuse marked I/O.
  Schema 29 nullable immutable root stamp, default NULL. Every roomDelivery run requires positive
  stamp for claim, StartModelRequest, tool claims/dispatch and repair, even explicit application calls.
  On replay return exact receipts only. Unbound/old roots remain inert. Eligible rebound starts use
  current epoch/grants in executable rooms. Maintain rt.restored() fallback, text-only/archive holds.
  Root status fences; tagged existing conversation receipts store stop/pause/state.
  For total child_runs limit 32 use pure reserve/settle(1) against count of committed marked turns
  while claiming delivery + inserting turn. Active count uses accepted/dispatching/prepared/uncertain;
  enforce ≤2 and one live slice/task; yield releases concurrency, not total; no refund on crash.
- In SQLite command-commit AFTER exact lookup and BEFORE append, locate marked run and validate
  root/slice, actual phase/attempt, current authority/privacy, stop and deadline; count committed
  attempt.model_request_started events across marked runs under same BEGIN IMMEDIATE. If <64,
  append StartModelRequest + immutable receipt atomically; only 'committed' gets dispatch authority.
  Replayed/altered/stale/denied receives no new start; no counter increment on version conflict.
  At modelRound before provider.stream, verify this fresh start + same current pins/privacy/fence
  synchronously, including abort after await. On proven veto before I/O settle not_sent; charge
  the already committed start. Restart never deduces not_sent from absence of a response.
  Count all ordinals and outages; no provider_requests dimension, process_starts substitution or
  fictitious ReserveBudget command. SettleModelRequest and RecordUsage keep actual vs unavailable;
  finite token budgets require reported usage; never turn unknown usage into zero or release it.
- For 64 tool_calls, count existing physical tool journal claims by joined room run (service/coding
  writes/presets AND guarded coding reads) plus local room call receipts (send/delegate/state).
  For room_state use same actor key family, strict operation/target binding, scoped reply in existing
  conversation receipts. For coding read bind a journal observation to actual worktree, actor, call
  and grant basis; existing read/list path lacks such a claim. No duplicate receipt for physical I/O.
  Derive RunBudget from durable counts; reserve(tool_calls,1), settle(1) for actual admitted call
  in SAME transaction as tx.claim/claimApprovalOperation or local receipt+delivery/state. No helper
  transaction. If a fresh claim refuses, rollback all writes; a stale/altered replay never dispatches. Physical
  reads take their sole charge at journal claim; guard again immediately before dispatch. Rollback
  removes unused reservation; no refund of admitted starts due to unknown/failure. Count distinct
  validated claims, not callbacks. For room tools no generic physical journal claim can precede send:
  it would invalidate the accepted no-pending-effect proof. Duplicate local results replay by receipt;
  physical replay never re-executes. Freeze a stable limit hold/reason when total/start/tool cap blocks
  next eligible work; reaching cap alone never prevents last local completion. Capacity saturation waits.
- In send transaction after exact receipt lookup and before a fresh child/message, count prior matching
  (root,senderBotId,recipientBotId,kind,text.trim().normalize('NFC')) since newest proved result for
  this exchange (original delegate pair + matching inverse/result receipt and verified final/Core head).
  Unrelated result, message, echoed text, partial, yielded run or technical receipt is not progress.
  On third occurrence CAS ready→paused with one reason receipt in existing store; no child/message/
  provider retry or duplicate notification. RootView exposes reason once by stable receipt ID.
- Owner stop writes bound stop receipt + root ready/paused→stopped before aborting/joining active
  jobs. Preserve child phases/wait links for exact repair. Release a proven never-started accepted
  hold only after executor join + locked unstarted evidence: absent Core is a no-start refusal;
  exact Create-only uses scoped RequestCancel and CompleteCleanup only with no preparation/effect
  and verified receipts. Keep stale/contradictory cases held. Distinguish not-started from
  cancelling/unknown. Do not issue RequestCancel over already prepared/proven local success.
  Explicit runs.cancel stays scoped Core request then controller.abort; detach only closes observer.
  Runtime shutdown fences this instance, never persist root stop solely on disconnect or orderly exit.
- Separate proof-only publication from start authority: verified exact Complete or prepared/handoff
  with exact unchanged running head, settled request, no related pending effects, saved version and
  absent Complete receipt can finish locally after stop. Recheck locked evidence after identical Complete; retain
  fence and all wait/result proof, never overwrite stopped/paused root as completed. Emit result only
  on matching parent wait and leave returned delivery inert behind fence. Never repair deadlined/
  contradicted evidence by rebasing; deadline limits new I/O, not already proven local publication.
  Archived/foreign-epoch and quarantined writes remain prohibited. Failed/unknown model or tool cannot retry by repair.
- Before claiming: exclusive runtime + restoration checks; forward configured SHA-256 through
  an optional DirectChatDeps.sha256 in runtime.ts -> DirectChatService.recover -> recoverChats ->
  repairRoomHandoff BEFORE generic reconciliation.
  Preserve broadcast/coding/plugin recovery. Reconcile pending tool claims conservatively. Extract
  exact unstarted-evidence classification from recoverUnstartedRoomClaims before reconcileInterrupted
  issues BeginReconcile; exempt ONLY those proven same accepted IDs (absent or exact sole Create,
  no other receipt/checkpoint/attempt/effect incl. new local receipts). Do not exempt all room runs.
  After runtime.ready/endpoint ownership, rerun recoverUnstartedRoomClaims with resolver and recheck exact claims.
  Scan only current-scope roots. Archived/old-epoch/unenrolled roots, inert v27 waits and
  contradictory evidence remain held. Replay cannot enroll or wake them.

#### Concrete edit map and acceptance

- contracts/src/local-runtime-room-tasks.ts (new DTO/codecs); tools-node/src/local-room-tasks-client.ts
  (new), local-runtime-client.ts and package indexes. cli/src/local-runtime/{server,client-compatibility,
  capabilities,host,host-options,turns,observe}.ts and new room-tasks.ts; runtime.ts/runtime-types.ts/
  runtime-services.ts, coding-turn-factory.ts compose authority using runtime-restoration.ts/runtime-epoch.ts.
- application/src/{room-task-persistence,room-task-records,room-task-send,room-delivery-claim,
  room-delivery-evidence,room-slice-publication,room-slice-result,chat-turn-execution,direct-chat,
  direct-chat-publication,reconciliation}.ts; new room-task-host.ts, room-task-authority.ts,
  room-task-tools.ts. Extend conversation-ports, service-turn-tools/admission(-prepare)/authority-ports,
  coding-grant-admission/coding-approval/coding-turn-tools at actual claims. Public index; no registry.
- store-sqlite/src/{store,event-log,command-commit,service-authority-storage,service-run-scope,coding-approval-storage,
  tool-journal,room-task-storage,room-task-slice-storage,room-task-chat-schema,room-runtime-reads,schema,
  schema-migrations,maintenance}.ts; new room-host-storage.ts (same-transaction facts/count reads). Domain
  profile-backup admits 29; maintenance retains historical schema28. Keep chat-receipts.ts and room-runtime-reads.ts evidence-based. No 2nd journal.
- RED→GREEN: disposable normal runtime/Unix socket; separate SDK processes; lost start/stop ACK,
  altered request conflicts; detach/reconnect/restart cursors; one slot A→text-only B→A after A1 deadline,
  unrelated root between slices; exact IDs, attribution, no A1 final, only one inverse result.
- Race two runs at 2/32/64/64 and replay last command/claim; compare SQLite receipts/events against
  actual transport calls. Fail before/after each commit; same-ID unstarted vs started, orphan receipt/
  checkpoint, pending effects, scoped/unscoped unknown; recover twice and assert no duplicate effects.
- Test sender/ancestor revoke between selection, claim, confirmation and dispatch; changed member/pin,
  cloud deny after claim/first round, opposite mixed-provider outages/no fallback; peer escalation,
  dev/reviewer boundaries, sibling delegates exhaust one issuing-run grant, cross-room/root state denial.
- Third normalized duplicate concurrent vs verified/unrelated result; one pause. Stop-vs-send/claim/
  model/C3/Complete/publication/drain; prepared child result survives stopped parent, unknown held.
  Positive RoomSlices fixtures bind disposable host + startHosted. Retain inert D1, genuine 27/28,
  synthetic wire data, CV7 refusal, 7.9 rebind and old clients/ACP. Never grant provider I/O to fixtures by origin.
- Implementation requires strict test TS,
  root pnpm check/build/format:check and ≤300 physical lines. Accepted 3899+166 are source evidence.
  Next 19.3: native Linux disjoint vs same/nested/alias worktrees incl. stdio startup/idle writers and
  lost reply + restart, descriptor/containment proof. Separate frozen real cloud→local→cloud/offline,
  mixed failures and installed Linux/client gates before stable activation. Existing RC2 installation stays pinned.

#### Concrete regression map and migration constraints

Known local action versus fresh execution authority: preserve Task19.2.1's explicit
settled-sender rule (owner edits after settlement do not invalidate that LOCAL tool
call). Runtime-authored persisted activation+settled Core proof still match immutable
sender pin; current room membership, host/epoch/quarantine/root status, loop/budget and
fresh recipient pin/privacy checks remain. Do not reuse the new-model/physical full
current-sender identity predicate to reject this already-admitted local action. Fresh
child claims/model starts and physical C dispatch continue to check current issuer
pins/refs, so a stale sender never authorizes new external I/O. Known receipt replay
and proof-only publication remain unchanged. Preserve original sender-edit local-send
success, recipient-only provider_unavailable and privacy model_transfer_denied/no-write
checks; isolate recipient edit from invalid sender state. This is existing contract
preservation, not a client override or new execution path.

Receipt replay owner boundary: rotation means model/key/connection/grant revision
changes under the SAME owner identity. Execution-owner rebind changing ownerId changes
an implicit bound input and conflicts on old requestId; old roots/receipts remain
immutable/inert, never stamped/woken/rewritten. New owner uses a fresh request with
current scope/grants. Ordinary same-profile restart keeps owner identity and replays
original receipt. Preserve accepted cross-owner refusal; no archive replay/rebind layer.
Marked grant expiry/current checks use the injected clock/now, not a silent wall-time
fallback. Existing host clock plumbing is sufficient; no new clock abstraction.

Own read observation and live leases: coding-turn-factory may accept an optional
trusted ProjectLeasePort supplied from existing codingDeps, REQUIRED for marked reads.
Normal CodingTaskService.authorize runs before claim; after claim its own pending
observation would trigger the old blanket hold. Dispatch instead combines exact
readClaimed (only its exact id/binding/run/attempt row excluded, all other conflicts
remain) with live ownership of CURRENT task and worktree leases. Missing/mismatched
port/lease denies. This is host effect-boundary wiring, not ProjectLeasePort injected
into SQL bindRoomHost. Test valid own read vs altered/conflicting row and lease loss
after async preparation with zero physical I/O. No client exclusion flag/global exemption.

Exact read confirmation ruling (same C/owner-decision mechanism): mutation
CodingApprovalBinding remains write|test|apply with real preparation hashes. A read
uses a small CodingReadRequest (scope/task/worktree/run/attempt/invocation, read_file
or list_files, canonical bounded arguments/operation digest, selected basis/limits),
without asserting content/tree/toolchain evidence before reading. Add optional read
confirmation method to existing coding owner port; absent method fails closed if
confirm mode is required. RuntimeOwnerDecisions persists kind project-read using an
exact metadata-only preview. Existing CodingApprovalService/store claimRead derives
trusted current own/ancestor authority; autonomous scope needs no vote. Confirmation
precedes any session/prepare/read. After vote recheck basis/current leases/scope and
atomically claim sole existing journal observation; vote never overrides missing or
revoked grants. No second approval table or journal. Historical read proof is tagged
existing journal evidence, not a fabricated mutation CodingApproval receipt.
Approved app owner-decisions.ts/coding-approval.ts, contracts local-runtime-decisions.ts,
CLI local-runtime/decisions.ts + owning tests. All decisions methods (list/get/preview/
resolve) gate project-read on room.tasks-v1 and return client_upgrade_required to old
peers before new-kind data, never silently omit cards. Test exact/stale/simultaneous
owner votes and revoke during wait with zero I/O. GUI-specific flow stays stage E.
Approved cap helper packages/application/src/coding-read-admission.ts holds exact read
request/preview types and pure eligibility/basis helpers, used by existing service/store
and turn tools/factory. Share coding policy rather than diverging from mutation guards;
no extra service/framework. Keep strict TS, public entry points and≤300 physical lines.

Approved test cap split: `apps/cli/src/room-coding-turn.test.ts` owns marked lazy
selection/read/lease-loss factory regressions with existing coding-consumer fixture,
real task/approval/journal/root/Core and scripted platform session. Existing295-line
coding-turn-factory.test.ts retains unmarked behavior. No test-import-test/native claim.

Exact coding evidence/dispatch seam additions:

- packages/domain/src/coding-approval.ts may add optional immutable roomBasis using
  a local debit tuple type with existing OwnerScopeGrant subject; no new shared module
  only for possible reuse. coding-approval-state.ts, store coding-claim-evidence.ts and
  coding-journal-receipt.ts may update exact immutable transition/read proof as needed.
  Basis comes only from trusted DB scope, never input. Validate bounded exact primitive
  tuples; no duplicate debit identity. Current claim/dispatch rederive live basis;
  historical finalization verifies frozen approval+journal basis, not today's grants.
  Absent roomBasis preserves old approval/journal shapes and byte semantics.
- packages/tools-node/src/{backend,executor,coding-operation,sandbox-probe}.ts may
  forward optional signal/ToolDispatchGuard through read/list and WorkspaceTools.prepare
  to existing sandboxFile dispatch. Add regressions in existing executor.test.ts,
  coding-operation.test.ts and sandbox-files.test.ts. Omitted guard preserves old callers.
  Marked public read/list has its single journal observation BEFORE lazy session/prepare;
  actual backend.read can occur DURING prepare, so check guard after asynchronous verify
  and immediately before file dispatch, not only PreparedTool.execute. Guard mutation
  preparation's internal reads too; exact write/preset claim remains before actual effect.
  Internal qualification/preparation is distinct from requested mutation; no duplicate
  top-level charge, new physical journal or general receipt framework.

Model inference dispatch recheck: add optional trusted ModelRequest.authorizeDispatch():boolean
in packages/application/src/provider.ts, forwarded from existing TurnInput authority callback
in round.ts. Built-in provider-{local,deepseek,openai,anthropic}/src/provider.ts check it
immediately before actual inference send; local checks AFTER awaited metadata preflight.
Undefined preserves existing unmarked behavior. No client/wire/model field, new authority
registry or alternate execution path. False/throw before send is proven not_sent, keeps
committed model start charged and never retries. Never run guard in requestBytes/body
serialization (can precede StartModelRequest); preserve dispatched→unknown semantics.
Add exact regressions in existing owning adapter tests, including local preflight
revocation with zero /api/chat and cloud denied callback with zero inference sends.

Required ordinary text-only model correction (D19.2.5, not a B restart): allow
qualified qwen3:1.7b completion metadata without tools as capabilities.tools=false.
Approved paths: packages/provider-local/src/{profile,metadata,provider}.ts and
qualification.test.ts; apps/cli/src/local-runtime/provider-local-lifecycle.test.ts.
wire/stream and their existing tests may change only for exact no-tools enforcement.
Keep exact model/backend/full digest/local-origin/tensors/context4096/streaming/text/
usage/timeout/preflight requirements. Provider advertises actual toolCalls; explicit
schemas/native tool history on a text-only profile refuse before I/O, returned tool
calls never execute. Missing completion, vision or unknown local origin still refuse.
Only explicit owner check publishes changed qualification/revision; active frozen
true→false or false→true preflight drift refuses, no implicit feature upgrade.
Replace only obsolete tools:false-is-unsupported expectation; preserve a genuine
unsupported-profile negative. Test ordinary A→text-only B→A through real activation
factory, no test resolver override; separate metadata traffic from inference counts.

Coding lease boundary clarification: add only narrow codingWorktree transaction
read and keep assigned dev codingTaskId immutable. SQL model-start authority checks
persisted task/worktree/lease identities/current scope, not external lease-registry
or FS I/O. Existing host CodingTaskService.authorize checks live leases in preparation;
actual read/list/edit/preset dispatch rechecks both external lease ownerships, including
after async preparation. Generation alone is not a worktree effect. Do not add a
ProjectLeasePort to bindRoomHost or claim atomicity across two registries. Prove lease
loss before physical read/write/spawn yields zero I/O. Lazy coding session starts only
after a settled model invocation, preserving known local publication on stop.

Recovery capacity regression: two proven unstarted claims restored with trusted host
capacity1 must both eventually execute; do not discard overflow from a recovery array
while the ordinary scan sees queued deliveries only. Reuse existing jobs/scan, no new
pending-work registry. claimRoomDelivery is currently synchronous; do not add an async
claim coordinator without an actual dependency.

Approved test cap split: `packages/store-sqlite/src/room-host-service.test.ts`
covers actual C claim/dispatch/contributing-basis/ancestor-debit regressions separately
from model/ancestor/loop/publication cases in room-host-authority.test.ts.

Approved cap split: `packages/store-sqlite/src/room-host-command.ts` owns marked
StartModelRequest authority/root-count guard and exact readonly same-transaction
facts through existing sqliteCommands/EventLog. Binding/migration/count/projection
remain in room-host-storage.ts; no new command journal or general policy system.

Shared normal-host fixture exact path is `apps/cli/test-fixtures/room-task-host.ts`;
it composes disposable CLI runtime/transport only, not a store→CLI dependency.

Approved cap split: `packages/contracts/src/local-runtime-room-task-codecs.ts`
contains closed request/row/view codecs; DTO module reexports them. No new protocol
behavior or generic codec framework; both normally formatted and≤300 physical lines.

19.2.5 cap-map addition (controller approved before implementation):
`apps/cli/src/local-runtime/host-room-tasks.ts` may extract the existing broadcast
and new room supervisor composition from host.ts (BASE297 lines), preserving
controller/drain ordering. Root projection lives in already mapped room-host-storage.ts
(BASE room-runtime-reads.ts278 lines). No generic scheduler or extra execution loop.

- New contract tests: `packages/contracts/src/local-runtime-room-tasks.test.ts`.
- New application tests: `packages/application/src/room-task-authority.test.ts`.
- New SQLite tests: `packages/store-sqlite/src/room-host-admission.test.ts`,
  `room-host-authority.test.ts`, `room-host-recovery.test.ts`, `room-host-migration.test.ts`.
- New CLI tests: `apps/cli/src/local-runtime/room-tasks.test.ts`,
  `room-tasks-process.test.ts`, `room-task-failures-process.test.ts`; register process cases
  in `vitest.process-cases.config.ts`. Use separate ordinary SDK client processes.
- Narrow shared fixtures: extend `packages/store-sqlite/test-fixtures/room-slices.ts`;
  add `room-task-host.ts` only for shared normal-host setup. No test importing another test.
  Every positive executing fixture binds the disposable verified host and uses startHosted;
  inert admission and negative legacy-origin fixtures stay inert. No fixture-origin execution exemption.
- Capture genuine schema28 before product edits from exact BASE, retain provenance/source pins
  and normally formatted static data `packages/store-sqlite/test-fixtures/room-slices-v28.json`.
  Its narrow loader may be `room-slices-v28.ts`. Compare historical named columns byte-for-byte
  plus new host stamp NULL, not SELECT* shape equality. Preserve existing genuine26/27 bytes.
  Adapt positional task inserts to explicit named columns; no implicit enrollment on migration/replay.
- Current-schema/future-version expectation maintenance may touch the inventoried19.2.4 tests
  above, `profile-backup.test.ts`, `maintenance.test.ts`, `room-slice-migration.test.ts` and
  the positive room-slice/claim/recovery fixtures. Inventory exact edits in the report;
  preserve behavioral assertions and old real schema fixtures, including eight frozen RC2 peers.
  Do not widen existing permissions or weaken proof checks to make fixtures pass.
- Root start currently does NOT call roomHold: an inert old root alone does not block a fresh
  hosted root. Preserve direct/batch and actual active-turn holds. Rebound fresh admission still
  requires an executable room/current grants; do not silently unquarantine or re-enroll old roots.
- Use concrete modules above and existing ports only. Routine cap-only source/test splits
  within these assigned module families/behaviors are implementation details: record exact
  paths/responsibilities and moved versus new cases in the report; reconcile the final map
  before review. Bring semantic authority/protocol/lifecycle changes or missing load-bearing
  APIs to controller. No generic scheduler, policy engine, event journal, workflow or model loop.

- [x] Implement the ordinary owner API/SDK, bounded root views and shared-engine room supervisor.
- [x] Enforce current ancestry, exact physical admission, serialized root limits, loop and stop fences.
- [x] Prove the listed interprocess/recovery/authority/migration scenarios with actual RED→GREEN;
      retain all unknown-effect holds and old-client semantics.
- [x] Freeze owned sources; pass strict root check/build/format, ≤300 physical lines;
      exact-path commit and independent spec/quality review before acceptance.

Acceptance of this leaf does not accept native19.3, live mixed execution, E/F or the full A–H goal.

Fence receipt namespace (19.2.5 review correction): internal fences use a NUL-prefixed
storage key outside the already-valid owner requestId alphabet, with an independent valid
public ID. Verify exact saved binding and root state before deduplication. Preserve
historical v1 receipts, including collisions; an unrelated owner receipt cannot suppress
a new pause. Root get/observe must pass the ordinary SDK decoder after pausing.

Snapshot authority (19.2.5 review correction): forward the existing optional guard
per operation through concrete snapshot reads, rechecking after async verification.
Preparation uses the selected write/preset permission and current leases; own-claim
exclusion requires the exact consumed approval. Keep repeatable preparation checks
separate from single-use dispatch and do not retain a previous read invocation guard.
The existing internal ToolDispatchGuard may add optional inspect():boolean for repeatable
checks; it never consumes or replaces authorize(). Marked snapshots require it; omitted
unmarked callers remain compatible. Do not fallback inspection to single-use dispatch.

Coding actor binding (19.2.5 review correction): use the same exact stored executor
and immutable dev assignment match for marked reads and mutations, including workspace,
room, bot, project, task and run. Reuse the existing admission helper and preserve
unmarked compatibility; request fields never select a different executor.

Historical publication (19.2.5 review correction): saved edge proof and proof-only
local publication also survive later member removal, with full immutable scope, host,
epoch, quarantine, Core/attempt and receipt checks. A trusted historical origin mode
may omit current membership only for that proof. New sends, claims and model/tool
execution continue to require current membership; no client override is added.

Never-started release retains current input and wait joins. Its saved issuer-membership
proof may use historical semantics independently of historical wait relaxation, through
one optional trusted internal argument; no client field or fresh execution exemption.

### Task 19.3: Qualify independent managed service workspaces

Reuse actual enrollment, verified sandbox bind descriptors, session supervision and
existing resource conflict predicate. Connection names/fake IDs/path inequality are
not containment evidence. Missing/stale proof and old unscoped unknown stay
conservative. Fence stdio launch/refresh and already-active/idle writers as well as
tool dispatch: server JS can mutate before its first call. Choose the smallest
footprint representation after actual enforcement proof, no identity registry.
Normal-host A mutates then loses its reply; after restart proven disjoint B works,
while same/nested/alias A via another connection remains blocked, including startup
writes. Same worktree remains coordinated. Native Linux proof and real mixed/live
gates remain distinct from unit/SQLite/root tests. Do not accept D until proved.

#### Bounded implementation and native qualification

Persist the complete lifetime of an explicitly enrolled writable stdio process in the
existing effect journal before executable launch. Explicit current owner enrollment
of a pinned program and verified bounded workspace, together with metadata permission,
authorizes that process lifecycle; it never grants a model business authority. Old
unbound rows stay inert. Use an internal typed identity disjoint from public/Core run
IDs, without fabricating a Core run or adding a lease registry.

Keep the hold through discovery, candidate, active idle state, calls and retirement.
A business call may exclude only its own exact live generation's started lifetime
claim after current proof checks. It cannot exclude other business claims or an
uncertain lifetime. Refresh must retire and join the previous writable generation
before starting a replacement. Post-send uncertainty removes writable readiness and
joins retirement; business unknown remains unknown even after clean process retirement.
Controlled lifecycle completion requires joined calls and confirmed whole-unit cleanup.
Interrupted idle lifetimes remain uncertain; empty cgroups do not prove their effects.

Managed stdio's hard watchdog is 120 seconds, allowing the existing catalog refresh
TTL (at most 60 seconds), bounded discovery, admitted-call drain and retirement to
complete normally. The old 60-second watchdog started before catalog activation and
would otherwise interrupt a healthy session before its scheduled refresh. Normal
refresh joins and settles the previous lifetime before replacement; actual watchdog
loss remains uncertain. This does not change coding sandbox preset limits or permit
business retries. Qualify healthy refresh beyond the old boundary and real watchdog
expiry separately.

The first positive partition is deliberately limited to roots on the same verified
Linux Btrfs mount/subvolume, using the existing open-directory kernel anchor helper,
actual sandbox bind descriptors and bounded mount-topology checks. Reopen saved roots
and retain trusted witnesses through the atomic journal decision and final launch/send
guard. Same, nested, aliased, replaced or ambiguously mounted roots conflict. Unsupported
or stale partition evidence remains conservative; uncertain containment denies launch.
No filesystem I/O occurs in pure domain logic or a SQLite write transaction. Mixed
coding/managed scopes remain conflicting without compatible physical evidence.

Native acceptance uses the ordinary built host, persisted owner enrollment and only
disposable task-owned profiles, workspaces and exact transient units. Observe startup,
wire, mutation and idle-descendant counters. After A mutates and loses its reply, kill
and reopen the runtime: independently enrolled disjoint B with no unknown lifetime of
its own must work, while same/nested/alias writers cannot start or repeat A. Cover the
reverse ordering with an already-active idle writer, concurrent independent work,
prelaunch identity/topology races and interrupted idle lifetime. Source and process
fixtures prove ordering and journal behavior; actual Linux counters and cleanup evidence
prove containment. Unsupported native cases remain explicit unqualified gates.

19.3 принят на `62bd51e`: root check/build/format — exit 0, 4098 source и
173 process прошли (44/58 настроенных opt-in пропусков); отдельная native-матрица —
22 теста в 13 файлах без пропусков. Полные результаты и ограничения —
[stage D](../../ocean/platform-stage-d.md). Для F остаются обязательными успешные
8 stdio (сейчас shared8 доказан как 7 HTTP + 1 stdio), разбор необъяснённого EOF
и workload/latency при консервативном preclaim отказе. Текущая приёмка не доказывает
одновременную успешную подготовку независимых каталогов, GUI, installed/live или stable.
Все отложенные Minor/Rulings остаются входом финального ревью F.

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

### Task 20.1: Discover room tasks through one negotiated server read

**Files:** contracts `local-runtime-room-tasks.ts`, new
`local-runtime-room-task-list.ts` and its tests; application
`room-task-records.ts` (application-local read-port shapes); store
`room-task-storage.ts`, new `room-task-list.ts` and tests; tools-node
`local-runtime-client.ts`, `local-room-tasks-client.ts` and tests; CLI
`local-runtime/{capabilities,client-compatibility,server,host,room-tasks}.ts`,
existing negotiation/process fixtures and a focused room-task-list process test.
Use public entry points and routine same-family splits only where the 300-line cap requires.

**Interfaces:** add exactly one feature `LOCAL_ROOM_TASK_LIST = 'room.task-list-v1'`
and RPC `roomTasks.list`, SDK `roomTaskList(input: RoomTaskList): Promise<RoomTaskListPage>`.
`RoomTaskList` has `workspaceId`, `roomId`, optional positive safe `beforeSeq` and
optional safe `limit` in 1–50 (default 50). Return `RoomTaskListPage` with echoed
`workspaceId`, `roomId`, `roots`, `nextBeforeSeq: number | null`. Each summary has
`rootId`, `startMessageId`, positive `startSeq`, `status`, `revision` and
`authority: 'current' | 'historical'`; no prompt, grants or model secrets.
Application read-port shapes remain local to application/domain, without a contracts import.

- [x] **RED:** pin exact closed DTOs, limit 1/50/51, exclusive descending cursor,
      duplicate/out-of-order/foreign-scope replies; verify SDK rejects unsupported peers.
      Store tests cover 51 roots with multiple initial siblings, exact pages, terminal/
      paused/unbound roots, different room/owner, no writes or execution from listing.
- [x] **Implement:** bounded room/owner-filtered SQL over existing tables and canonical
      position-zero start message evidence; never scan the scheduler's global `roots()`.
      Return one entry per root, newest first. Fetch at most limit+1; when more exist,
      `nextBeforeSeq` is the last returned start sequence, otherwise null. Owner comes
      from the authenticated host. `current` requires the exact existing verified host
      binding; old/unbound/foreign-host entries remain historical and are not adopted.
      Unknown/foreign room follows existing scoped error behavior, not successful empty.
- [x] **Compatibility:** list requires negotiated `room.task-list-v1`, `room.tasks-v1`
      and `room.addressed-history-v1`. Add only the one feature token: current normal
      hello goes from 79 to 80, keeping the existing ceiling 80 and RC2 projection.
      Suppress list on restore-mode hosts just like D execution. Preserve four existing
      D methods, addressed-history compatibility, receipts and all effect/authority rules.
- [x] **GREEN/process:** real built owner and two independent public SDK peers: lose a
      start ACK after durable commit, discover the same root without its receipt, restart
      owner and discover it again; identical replay retains IDs and changed payload fails.
      Listing changes neither provider/effect counters nor durable state. Old D peer still
      supports ordinary chat; missing list support is explicit, not an empty task list.
- [x] Run focused regressions and root `pnpm check`, `pnpm build`, `pnpm format:check`
      through the unchanged private runner, self-review, exact-path commit and task review.

20.1 принят на `fdb8d2b`: независимое ревью без замечаний, root check/build/format —
exit 0; 4122 source и 174 process прошли (44/58 opt-in пропусков). Это серверное
чтение и public SDK; Desktop и установленная GUI-приёмка остаются 20.2/20.3.

### Task 20.2: Connect the existing Desktop to team tasks

**Files:** Desktop `protocol.ts`, `protocol-room.ts`, new `room-task-protocol.ts`,
`host/room-task-client.ts`, thin `host/runtime-client.ts` dispatch; UI `Desktop.vue`,
`room-feed.ts`, new `room-task-state.ts`, `RoomTasks.vue`, `RoomTaskStart.vue`;
`RoomHistory.vue`, `RoomDetails.vue`, `RoomWork.vue`, `runtime-text.ts`,
`PluginSettings.vue`, `ServiceDecisions.vue`, `service-decisions.ts` and focused tests.
Keep existing `state.ts` below 300 lines by composing at its existing room/ref boundary.

**Interfaces:** typed IPC `task-support/list/start/get/observe/stop`, fixed workspace
`ws_ocean`, existing authenticated public SDK only. Reuse existing profile/instance
write binding and renegotiate before dispatch. Do not expose a generic RPC escape hatch.
SDK `roomTaskGet` assembles at most 512 rows; the socket guard accepts at most 50 per
page. Define a separate closed assembled-view IPC guard (`nextPage:null`, at most 512
validated strictly ordered unique rows); do not relax the existing wire-page guard.

- [x] **RED:** both IPC boundaries reject foreign/stale/oversized frames; accept a valid
      51+ row assembled view. Pin room/selection/profile/instance epoch changes, held
      responses, lost ACK exact-payload replay, downgrade, stale decision and stopped-root
      cleanup truth. Ordinary drafts/file chips survive opening, cancelling and submitting
      the separate task form. Addressed A→B differs from an ordinary self-targeted reply.
- [x] **Implement existing UI:** one keyboard-reachable “Задачи команды” room-header
      entry and one dialog for the server index, selected root and “Новое поручение”.
      Reuse current styling; keep direct/@bot/note/broadcast composer unchanged. The
      separate task text field is explicitly text-only, UTF-8 limit 16384 bytes, no hidden
      attachment envelope. Reuse per-bot cloud/local/model/capability and grant settings.
- [x] **Start:** explicit room participants and nonempty initial subset; bot IDs on wire,
      handles in UI. Select optional current active room/bot service grants with exact
      revisions, permissions, modes and limits. Mandate has null project/codingTask IDs;
      conversation-only uses empty refs/permissions. No synthetic coding authority,
      policy merging or auto-grant. Server remains authoritative for all eligibility.
      Show actual root/message/delivery receipt; clear only task form after confirmation.
      Lost ACK freezes exact payload/request ID; allow only explicit identical replay in
      the same verified profile. No automatic writes/reconstructed draft on restart.
- [x] **Observe/read:** load server index on room open, explicit refresh and room watermark
      changes; page older roots explicitly. One selected-root observer, short waits around
      1s; watermark then full SDK get on snapshot/change/resync. Retry reads on changed
      page revision, never expose partial rows as complete. Ignore late scoped responses;
      stale/disconnected state disables writes without erasing chat. Historical roots and
      unsupported peers stay read-only, not falsely empty or newly enrolled.
- [x] **Truth/decisions:** show assignee, peer wait, queued/held delivery, yielded slice,
      actual result, unknown/authority/limit fence. Preserve `resultMessageId` in ordinary
      run DTO; completed without a result is not “Ответил”. Root stop uses exact current
      ready/paused revision and fresh request ID; receipt proves fence, not cleanup.
      Lost ACK stays unconfirmed; stale revision visibly refuses without write retry.
      Slice service decisions reuse exact room/run/ID/version/digest preview and resolve;
      display “Устаревшее решение отклонено” on conflict. Other decision kinds remain
      honest read-only with their supported owner-client route; project approvals stay G.
- [x] Run meaningful UI/bridge regressions and root gates via unchanged runner, self-review,
      exact-path commit and independent task review. Native installed acceptance is 20.3.

20.2 принят на `ccf021b` после исправления привязки чтения прав и чистого scoped-ревью.
Root check/build/format и реальный Desktop bundle — exit 0; 4158 source и 174 process
прошли (44/58 opt-in пропусков). Это исходники и сборка, установленный GUI — 20.3.

### Task 20.3: Qualify the installed bot GUI and two clients

**Files:** focused `apps/desktop/qa/room-task-native.mjs` and same-family phase helpers
under 300 lines as needed; reuse existing `model-native-session`, widths, current-window,
client-handoff and asset/restart/lifecycle helpers. Add `docs/ocean/platform-stage-e.md`
only after actual evidence; retained B results do not qualify E candidate bytes.

- [x] Build/install one frozen disposable candidate and pin CLI/SDK manifest, Desktop
      executable/ASAR hashes and revision. Use two real packaged Electron processes with
      separate fresh userData, one private profile/runtime and an independent installed
      SDK peer. Deterministic loopback cloud/local/provider/service fixtures, no renderer
      mocks, seeded DB, live-key requirement or protected installed/profile changes.
- [x] Through UI start one scoped text task, observe same root from second window without
      receipt; verify delegation/wait/yield/result and actual history order. Show the same
      confirmation twice: one accepted operation, stale second vote refused, effect count1.
      Closing a window does not cancel. Restart/reconnect preserves IDs and no repeated
      dispatch. Explicit stop distinguishes root fence from unresolved cleanup/unknown.
- [x] Check mixed bindings/auth-none local, revoked scope and unavailable local without
      hidden cloud sends; unsupported peer leaves ordinary chat usable and tasks inert.
      Preserve normal image/text/binary attachments/original export after restart; eligible
      fixture receives exact image bytes, unsupported model rejects before send.
- [x] At measured 1024/1280/1920×800 verify controls/composer/drafts/chips fit, keyboard
      access, Escape/focus return and unchanged Enter/Shift+Enter behavior. Independent
      public reads and counters verify results; screenshots are supplemental evidence.
- [x] Reuse unchanged private runner with only explicitly passed, owned Wayland and
      Hyprland command sockets as argv; map those endpoints into private runtime state,
      never inherit real HOME/XDG/DBus/env or change system settings. Operate only checked
      candidate PIDs/windows. Record exact commands, artifacts, limits and owned cleanup.
      Missing compositor/geometry is an explicit native gap, not a passing source test.
- [x] Final root gates, independent task review, document actual implemented vs planned
      E results and continue F. Do not claim stable or full A–H completion here.

Принято на продукте `c6f7cf8`, QA `b6e5f5a`, после двух точечных исправлений
проверочной обвязки и чистого re-review. Проверены два установленных окна,
однократный эффект, перезапуск в том же приватном пространстве сокета,
исходные вложения и открытая форма на трёх размерах. Детали: [этап E](../../ocean/platform-stage-e.md).

## Task 21: F. Приёмка и выпуск приоритета 1

- [x] Обновить полную карту требований и release ledger. Устранить применимый
      долг test typing; ни удаление SDK, ни docs-only commit не закрывают его автоматически.
      [Карта выпуска](../../ocean/platform-stage-f.md) принята на `f7d5d63`;
      строгие графы проверили все 1712 TypeScript-файлов и 34 Vue-компонента.
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
