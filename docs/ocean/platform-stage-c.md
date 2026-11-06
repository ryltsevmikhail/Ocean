# Ocean Platform: прогресс этапа C

Дата: 2026-11-06. Приняты C18.1 (`79bbce9`), C18.2 (`7bbb502`),
C18.3 с normal coding consumers (`b868d32`) и C18.4.1 (`165e1c0`)
после независимых ревью и исправлений. Прямой MCP transport и managed stdio
квалифицированы; штатный runtime пока использует Executor. Его переключение,
owner RPC/UI, миграция и установленная замена ещё запланированы.

## Что квалифицировано

Закреплён [публичный MCP SDK 2.4.0](https://github.com/modelcontextprotocol/typescript-sdk/releases/tag/v2.4.0),
upstream `951fe5603a7ec0b2dcb6a0b95d92cd86f93ad9e5`; опубликованные tarball
client/server/core сверены по SHA-512 и данным provenance. Это не независимый
аудит подписи attestation. SDK Apache-2.0; транзитивные permissive-лицензии
сохранены в инвентаре квалификации. Используются публичные root/stdio API,
без vendor patch, частных полей и собственной реализации JSON-RPC.

26 HTTP/catalog-проверок подтверждают запрет скрытых повторов, frozen definition,
явный metadata refresh, ошибки и разделение вызовов. При timeout до отправки
закрытый допуск не допускает поздний fetch/write; после отправки исход остаётся
uncertain. В stdio шесть исходных сценариев и два целевых запуска исправления
подтвердили изоляцию окружения/файлов, ограничения вывода и завершение cgroup.
Выход SDK-процесса не используется как единственное доказательство очистки.

Отдельный разрешённый GitHub read вернул техническое Ocean issue5/open,
HTTP200, MCP2025-11-25: четыре metadata send и один business send. Токен
использовался только из одобренного приватного файла в памяти отдельного процесса.
Живой read и шесть исходных native-сценариев относятся к `ff019f1`;
исправление `79bbce9` покрыто 26 HTTP-тестами, двумя целевыми native-запусками,
строгой компиляцией пакета/Node-тестов, lint/format/syntax. Новый live reader
имеет compilation coverage; повторного запроса ради общего флага не делали.
Offline aggregate без токена остаётся false, а не выдаётся за полную live-приёмку.

## Границы результата

Прототип — приватный workspace-пакет, явно исключённый из релизной сборки.
Исключение временное: до первой установленной MCP-сборки C18.4/18.6 оно должно
быть заменено проверенным production inventory/bundle. Остальные dependency
checks и Executor не изменены. Нет автоматического credential/account fallback,
производственной миграции, живой записи, запросов к моделям или изменения RC2.

Корневые команды на `ff019f1`: check1 (strict main/Node/Desktop и lint0;
3434 source passed, 3 известных catalog failures, 44 skipped; process-фаза
не достигнута), build0, format1 на двух защищённых файлах. Два release process
теста прошли отдельно. Это не зелёный глобальный gate или приёмка установленного
продукта. Исправление проверено отдельно, ревизии не смешиваются.

Native effect-marker подтверждает наличие эффекта, а не независимый счётчик
всех исполнений; SDK send-counter остаётся отдельным наблюдением. Committed
header-тест объединяет имена, но сохранённый отдельный probe проверил точные
пары. Оба Minor переданы в production-adapter/F разбор. Квалификация не обещает
exactly-once сервиса, подтверждённую удалённую отмену или account continuity.

## Контракты и хранение C18.2

В schema24 добавлены три пустые таблицы: подключения, неизменяемые снимки
каталога и owner grants версии2. Новый порт использует то же SQLite-соединение.
CAS, публикация каталога, rollback и закрытие транзакции проверены; миграция
сохраняет старые строки и неизвестные эффекты, не создавая новых прав.
Это инертное хранение: runtime пока не использует его для допуска операций.

Конфигурация хранит только credential handle `env:NAME`. Stdio argv пока
допускает только пустой список; нужные безопасные формы запуска будут проверены
в18.4. Никакие реальные credentials, профили или установленный RC2 не использованы.

На787946c: 776 owning-тестов прошли; root check1 (strict main/Node/Desktop и
lint0;3454 passed/4 failed/44 skipped, process-фаза не достигнута), build0,
format1 только на двух защищённых файлах. Четвёртая ошибка — старое архитектурное
утверждение — исправлена и проверена отдельно14/14. Коррекция7bbb502:
7 новых RED→GREEN регрессий,24 covering passes, strict main/Node и scoped
lint/format0. Полного зелёного root gate эта проверка не заявляет.

Три Important закрыты: разреженные массивы, буквальные credentials в конфигурации
и необработанное отклонение async-callback. Два Minor (Unicode-порядок ключей
при сравнении каталогов и недостающие assertions в churn-тесте) переданы
финальному whole-branch review. Native/live/установленная миграция относятся
к следующим шагам.

## Актуальный допуск и coding consumers C18.3

OwnerScopeService хранит долговечное намерение владельца; служебные права, каталог
и сессия разделены. Exact/current-set используют утверждённые определения;
future tools требуют явного выбора. Отзыв проверяется перед отправкой.
Смена credential требует доказанной непрерывности, endpoint/account не считаются
обычной ротацией ключа. Клиентские owner-операции будут подключены в18.5.

Схема25 добавляет одну nullable admission-колонку существующему журналу.
Известные независимые footprints могут работать отдельно; legacy, неподтверждённые
и противоречивые записи сохраняют глобальный hold. Guarded coding требует
точной связи approval/claim/инструмент/fingerprint/metadata. Утрата metadata
не восстанавливает право отправки и не сбрасывает уже занятый allowance.

Обычная фабрика coding-tools проверена с реальными application/SQLite:
B читает, редактирует и запускает зарегистрированный preset без prompt,
пока A остаётся uncertain. Подтверждённая владельцем финализация освобождает
только B; записи и holds A не меняются. Platform session и registry в этих
тестах scripted: это не новое доказательство физических файлов, native sandbox
или установленного клиента. Source apply сохраняет отдельный точный
owner/review/changeset-путь и legacy global fallback.

Core303a623:92 focused passes; root3502 passed/3 failures/44 skipped.
Normal-consumerdcb1982:206 covering passes; root3584 passed/те же3 failures/
44 skipped; process-фаза не достигнута; build0, format1 только protected2.
Исправленияaf343c6 иb868d32 отдельно покрыты126 и226 тестами соответственно,
строгой main/Node/Desktop-компиляцией и scoped lint/format0. Нового полного
зелёного root gate эти результаты не заявляют.

В ревью закрыты ошибки сопоставления квитанций, legacy scope и resource identity,
допуска до project inspection и wiring верхних consumers. Minor о повторном
чтении SQLite оставлен финальному whole-branch review.

## Production MCP transport и managed stdio C18.4.1

`@runnets/integrations-mcp` экспортирует production transport отдельно от
`/qualification`. Используется тот же публичный SDK2.4.0: полный frozen tool,
явный каталог и однократный текущий допуск перед fetch/write. Адаптер не владеет
SQLite или правами. Кандидат активируется после точной долговечной публикации;
смена каталога не меняет уже допущенное определение. TTL/list-changed дают hint,
а отдельную metadata-работу будет выполнять runtime в18.4.2.

Trusted SDK остаётся у владельца runtime, stdio-сервер — в namespace/cgroup.
Квалифицированы pinned Node bundle и необязательный pinned sibling package.json,
только argv `[]` или `['/workspace']`, отдельный рабочий каталог и private env.
На сессию:512MiB RAM,64 процессов/потоков,60s,4MiB frame и64KiB stderr без
сохранения содержимого; восемь сессий на экземпляр. Это пределы данного
stdio-профиля, а не всей автономной задачи или coding presets. Неизвестная
очистка запрещает и новые, и уже ожидающие отправки. Прерванный preflight
сохраняет слот до завершения фонового I/O; закрытие его дожидается.

Готовый `@modelcontextprotocol/server-filesystem@2.2.0` проверен без собственного
плагина: список, запись, чтение и отказ выхода за каталог. Проверены фактические
cgroup limits, EAGAIN при64 задачах, inherited pipes, SIGKILL владельца,
restart и неопределённая очистка. Отдельный fault server независимо записывает
полученные запросы и эффекты: revoke/cancel/deadline дают0/0; sent/drop —1/1 и
uncertain; отказ сервера —1/0. Прежний owner-counter остаётся свидетельством
разрешения, не выдаётся за wire receipt. Точные raw header pairs проверены.
Этим закрыты два Minor прототипа C18.1, без обещания exactly-once внешнего сервиса.

Точный tarball, frozen dependency closure и permissive-лицензии сохранены в
инвентаре. В tarball filesystem2.2.0 отсутствует LICENSE, несмотря на manifest;
сохранена лицензия точного upstream commit с Apache/MIT transition, без заявления
MIT-only или независимого аудита подписи. Сервер и qualification fixtures не
поставляются пользователю как установленный backend.

Единственный production-adapter GitHub read вернул issue5/open:1 SDK attempt,
MCP2025-11-25, account unverified, без сохранения ключа или тела issue. Ready/live
относятся к18013a3. Исправления ревью8bb0d38:34 covering passes,12 affected coding
native passes и независимые native receipt/effect counters. Числовой literal
credential фиксf6be7d9:28 covering passes; quote/backslash cases сохранены.
Strict main/Node/Desktop и scoped lint/format прошли. Новых реальных запросов
ради повторного общего флага не делали.

Последний полный root наe744fd7:3624 passed/3 protected catalog failures/44 skipped,
process-фаза не достигнута; build0, format1 только protected2. Исправления проверены
отдельно, полного зелёного gate пока нет. Два новых Minor — проверка нулевого
числа credential lookups и повторный JSON freezer — остаются финальному ревью.

## Штатный runtime и MCP-поставка C18.4.2

Принято на `d35e28a` после полного ревью и двух проверок исправлений.
Один runtime выдаёт нейтральные service tools в существующий цикл вместе с coding
и владеет metadata refresh. Generic CLI/ACP не запускают discovery от открытия
профиля; maintenance даёт0 credential reads/HTTP/native preflights. Реальный failed
startup с удержанным TTL refresh сохраняет SQLite owner_busy до drainage;
независимый процесс подтверждает освобождение после завершения работы.

Доступный MCP peer наблюдал два владельца: metadata lists2→3, business receipt/
effect1/1, model requests1→0; прежний run/attempt/journal и uncertain сохранены.
Первый stop incomplete, второй complete — это не отмена неизвестного эффекта.
Проверены revoke/TTL до отправки и один ход с реальным worktree и service tool
без лишнего approval. Нативный готовый filesystem server вернул точный canary,
completed journal и подтверждённое завершение cgroup/PID на `f604249`.
Его HTTP-only counters не выдаются за wire-наблюдение внутри ready server.

В архив входит один production adapter с SDKclient/core2.4.0 и Rolldown1.2.16.
Проверяются reviewed lock SHA-256, SDK inputs, лицензии, внутренний/внешний
инвентарь и файлы. Emitted standalone отклонил шесть самосогласованных повреждённых
архивов до создания prefix; корректный установлен. Исторический Executor archive
поддерживается только для rollback parsing. Архив на `a060c24`: SHA-256
`53e1500796920333c52dcaf880a51f66b797bc062071e3b7538f55c584de04b9`.
Последующее source-only исправление `b17bf8a` в него не входит.

Исправления:82/82 covering,19/19 process/release,15/15 final release; последняя
helper-правка59/59, strict main/Node/Desktop и scoped lint/format0. Это отдельные
пересекающиеся измерения. Root остаётся3654passed/3protectedfail/44skipped,
process-фаза не достигнута, build0, format1 только protected2 на прежнем pin.
Полного зелёного gate и installed/live replacement пока нет. M1–M4 сохранены
для F: combined-tool wording, изолированная changed-definition проверка,
obsolete legacy binding и drop-specific ordering/zero-answer assertions.

## Настройки владельца и квитанции C18.5.1

Принято на `4798c95` после полного и одного scoped-ревью. Capability
`service.authority-v2` открывает восемь методов authenticated runtime socket:
`service.connections`, `service.grants`, `service.receipt`,
`service.connection-set`, `service.connection-disconnect`,
`service.connection-refresh`, `service.grant-set`, `service.grant-revoke`.
Это реализованный wire API; текущие Desktop/TUI-формы подключаются в18.5.3.

Schema26 хранит prepared/completed owner receipts. Мутации используют requestId
и точные ожидаемые версии; replay возвращает прежний снимок, изменённые данные
отказывают. Grant policy остаётся в OwnerScopeService; новая явная выдача по
умолчанию autonomous. Явный некорректный mode, включая null, не создаёт разрешение.
Maintenance разрешает только безопасные reads, старый клиент не получает новых
прав через неподдерживаемый контракт. Принятый metadata refresh переживает
отключение клиента и завершает квитанции coalesced запросов один раз.

Ключи хранятся в существующем private store вне профиля/backup. Ответы и SQLite
не содержат их значений. Material binding доказывает только неизменность байтов,
не идентичность аккаунта. Неявный перенос bearer на другой origin запрещён;
нужны явная передача материала или удаление. Для перехода keyed HTTP→stdio
сначала удаляется ключ. Credential/trust revisions сохраняют отказ старым grants.

Private publication ограничена65536 UTF-8 байт и проверяет размер до замены файла.
Ротация атомарно заменяет прежний service entry, сохраняя provider entries.
Corrupt/insecure/oversized shared state не очищается записью или удалением одного
ключа: операция отказывает. Подготовленная операция после сбоя сама не повторяется;
для допустимого private state возможен новый явный запрос с материалом и текущими
версиями. Автоматического ремонта повреждённого общего файла нет.

Проверки с реальной SQLite/private-store показали сохранность несвязанного
provider-ключа при переполнении и отказе финального SQL commit, reopen без retry
и явное восстановление. Исправления:186 source tests в31 файле,1 process,
strict main/Node/Desktop и scoped lint/format0. Root до исправлений:
3689pass/3protectedfail/44skip, process-фаза не достигнута, build0/format1 только
protected2. Это не новый root gate и не installed/live квалификация.
M1 стоимости list, M2 точного момента потери generic mutation reply и N1 лишней
записи при отсутствующем private file сохранены для F. Межпроцессный тест
подтверждает исходную квитанцию после reconnect/restart; точный drop после commit
для этой generic mutation ещё требует усиления наблюдения.

## Дальше по плану

18.5.1 принят;18.5.2 — точные подтверждения;18.5.3 — тонкие клиенты
и консервативная миграция;
18.6 — установленная/live/package-приёмка и удаление Executor. Затем D —
сохраняемые поручения и свободное взаимодействие команды, E/F — клиент и выпуск.
[Канонический план](../superpowers/plans/2026-11-04-ocean-platform.md).
