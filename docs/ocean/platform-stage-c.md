# Ocean Platform: прогресс этапа C

Дата: 2026-11-06. **Приняты C18.1** на `79bbce9`, **C18.2** на `7bbb502`
и **C18.3** с normal coding consumers на `b868d32` после независимых ревью
и исправлений. Сервисный production transport пока использует Executor;
прямой MCP-host, owner RPC/UI и установленная миграция ещё запланированы.

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

## Дальше по плану

18.4 — production adapter/host;18.5 — консервативная миграция и настройки;
18.6 — установленная/live/package-приёмка и удаление Executor. Затем D —
сохраняемые поручения и свободное взаимодействие команды, E/F — клиент и выпуск.
[Канонический план](../superpowers/plans/2026-11-04-ocean-platform.md).
