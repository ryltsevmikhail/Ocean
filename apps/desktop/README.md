# Ocean Desktop

Текстовый Electron/Vue клиент для Linux. Комнаты, участники и переписка общие с терминалом Ocean. Инициализируйте профиль через CLI, затем запустите отдельный процесс runtime с этим профилем. Сборка использует Node 26 и pnpm 12.16.1.

```sh
pnpm install --frozen-lockfile
pnpm ocean runtime start --profile /absolute/private/profile --json
# Во втором терминале
OCEAN_DESKTOP_PROFILE=/absolute/private/profile pnpm --filter @ocean/desktop start
```

Передайте обоим процессам один `XDG_RUNTIME_DIR`. Для отдельного окна укажите `--user-data-dir=/absolute/private/desktop`. Без `OCEAN_DESKTOP_PROFILE` клиент ищет runtime исходного профиля `<userData>/conversation/profile`. Ключ провайдера задаётся в окружении владельца runtime. Панель «Локальный профиль» показывает подтверждённую идентичность процесса.

«Создать Ocean Team» добавляет отсутствующие профили dev и review и создаёт общую комнату. В поле «Кому» выберите участника. Отправка всем сохраняет заметку. Для личного диалога нажмите «＋», выберите тип комнаты и одного участника.

После записи сообщения появляется квитанция, а состояние запуска и история обновляются отдельно. Потерянную квитанцию можно запросить повторной отправкой исходного запроса из открытого окна. Закрытие окна отключает клиента. Явная кнопка отмены указывает идентификатор и версию запуска. Для разбора неизвестного исхода или подтверждения операции откройте ту же комнату в TUI.

## Вложения

Скрепка, перетаскивание и вставка из буфера принимают до четырёх файлов по 10 МиБ. Изображения и текст доступны для предпросмотра. Оригинал сохраняется через системный диалог. Модель получает ограниченные текстовые выдержки и описания файлов.

Канонические байты находятся в приватном `<profile>/desktop-<uuid>/tree`, а
привязки запросов, подготовки и квитанции — в SQLite того же runtime. Старые
`<userData>/conversation/attachments` и
`<userData>/conversation/profiles/<profileId>/attachments` служат только явно
выбранными источниками миграции; после enrolment они инертны. Повтор исходного
запроса проверяет комнату, UUID, текст, получателя и порядок вложений по
зафиксированной подготовке runtime. Неизвестная или повреждённая подготовка не
заменяет UUID и не отправляет новый запрос. Полный публичный backup format 2
включает канонические байты и граф подготовки/квитанций. Восстановленный профиль
остаётся в quarantine до явного rebind владельцем через maintenance-хост.

## Проверка на Wayland

```sh
pnpm build
pnpm --filter @ocean/desktop bundle
node apps/desktop/qa/smoke.mjs
# Доступность composer и Send при открытых «Сведениях» на 1024/1280/1920:
OCEAN_QA_CLI=/absolute/built/apps/cli/dist/main.js \
  OCEAN_QA_ROOT=/absolute/private/evidence node apps/desktop/qa/layout.mjs
# Текущая проверка против явно выбранного установленного CLI:
OCEAN_QA_CLI=/absolute/installed/apps/cli/dist/main.js \
  OCEAN_QA_ROOT=/absolute/private/evidence node apps/desktop/qa/current.mjs
```

Устаревший драйвер `qa/entrypoint.mjs` удалён в RC2: он ждал удалённый элемент
отмены и не соответствовал объединённому UI. Его роль выполняет `qa/current.mjs`
против явно выбранного установленного CLI; отдельного «стандартного» драйвера
запуска больше нет.

Текущий драйвер `current.mjs` сохраняет приватные доказательства, использует
синтетические HOME, все XDG-каталоги и TMPDIR для каждого процесса, отдельный
userData и передаёт только реальное GUI-подключение Wayland. Он не использует
пользовательский D-Bus или физический буфер обмена. Для запуска Electron на
Wayland требуется **абсолютный** путь сокета в `WAYLAND_DISPLAY`; относительное
имя (`wayland-0`) не квалифицируется.

Драйвер `layout.mjs` проверяет при открытых «Сведениях», что поле ввода и кнопка
отправки на 1024, 1280 и 1920 видимы, доступны, не перекрыты панелью и реально
отправляют сообщение; он же фиксирует ограничения вложений и состояния истории.
Драйверы создают временные каталоги и отдельный runtime с тестовым провайдером. Проверка включает обычную команду запуска, закрытие окна во время генерации, повторное открытие и одновременное наблюдение через TUI и SDK. Подробности и границы проверки приведены в [руководстве по интеграции](../../docs/integration/desktop-client.md).

## Отдельная Linux-сборка

После `pnpm build` и `pnpm --filter @ocean/desktop bundle` приватный QA-драйвер
создаёт самостоятельный Linux x64 каталог через существующий `@electron/packager`:

```sh
OCEAN_QA_CLI=/absolute/installed/apps/cli/dist/main.js \
  OCEAN_QA_ROOT=/absolute/private/evidence \
  OCEAN_QA_PACKAGE_ROOT=/absolute/private/new-package-directory \
  node apps/desktop/qa/standalone.mjs
# С уже запущенным runtime и тем же XDG_RUNTIME_DIR:
OCEAN_DESKTOP_PROFILE=/absolute/private/profile \
  /absolute/private/new-package-directory/artifact/OceanDesktop-linux-x64/OceanDesktop \
  --user-data-dir=/absolute/private/desktop --ozone-platform=wayland
```

Для офлайн-упаковки `OCEAN_QA_ELECTRON_ZIP_DIR` указывает каталог с
`electron-v45.2.1-linux-x64.zip`. Драйвер запускает готовый исполняемый файл,
проверяет закрытие во время ответа и повторное открытие с тем же запуском.
Приватный loopback inspector применяется только при проверке native userData и
sandbox; обычному запуску он не нужен. Упаковка не устанавливает ярлыки или
системные службы и не является публикацией релиза.
