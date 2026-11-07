# Ocean 1.1: установка Linux

[Ocean 1.1.0 опубликован](https://github.com/ryltsevmikhail/Ocean/releases/tag/v1.1.0) для Linux x86_64.
Приёмка выполнена на Omarchy. Возьмите архивы и `SHA256SUMS` из релиза;
точная ревизия сборки — `4fd6687`. Свидетельства и границы проверки записаны
в [карте приёмки F](platform-stage-f.md).

## CLI, runtime и SDK

Нужен Node **v26.13.0**, указанный в манифесте архива; launcher проверяет точную
версию. Для runtime также нужен `/usr/bin/python3` с Unix sockets и `SO_PEERCRED`.
Для coding worker нужны Git, bubblewrap, systemd user manager и cgroup v2;
[предпосылки и ограничения](operations.md#кандидат-11-linux-prerequisites-и-границы-проверки)
проверяются отдельно. pnpm 12.16.1 нужен для сборки, но не обычного запуска.

После получения архива, установщика и доверенной SHA-256:

```sh
node /absolute/download/ocean-install.mjs \
  --archive /absolute/download/ocean-1.1.0-linux-x64.tar.gz \
  --sha256 TRUSTED_SHA256 --prefix /home/user/.local
/home/user/.local/bin/ocean --version
/home/user/.local/bin/ocean init \
  --workspace /absolute/workspace --profile /absolute/private/profile
/home/user/.local/bin/ocean runtime start --profile /absolute/private/profile --json
```

Не запускайте проверочный экземпляр на рабочем профиле. Установщик меняет
программу, но не открывает профиль. Миграция при обычном открытии выполняется
вперёд до схемы **29**. Архив включает CLI, runtime, публичный SDK, лицензии и
документацию; Electron поставляется отдельным архивом.

## Desktop

Распакуйте `ocean-desktop-1.1.0-linux-x64.tar.gz` в отдельный каталог и запустите
упакованный executable при работающем runtime:

```sh
OCEAN_DESKTOP_PROFILE=/absolute/private/profile \
  /absolute/desktop/OceanDesktop-linux-x64/OceanDesktop \
  --user-data-dir=/absolute/private/desktop
```

Оба процесса должны видеть один `XDG_RUNTIME_DIR`. На Wayland передайте абсолютный
путь существующего сокета через `WAYLAND_DISPLAY`. Закрытие окна отсоединяет
клиент; состояние принадлежит runtime. Подключения моделей, боты, комнаты,
вложения и задачи команды описаны в [Desktop](../integration/desktop-client.md).
Графический клиент проектов и два новых TUI — последующие этапы G/H.

## Обновление и откат

Остановите владельца профиля и сделайте проверенную копию текущей совместимой
версией: `ocean backup --profile /absolute/profile --to /absolute/new-backup --json`.
Сначала проверьте обновление на одноразовой копии. Установите новый архив тем же
установщиком в тот же prefix. Прежние версии программы сохраняются.

Откат программы выполняется установкой прежнего проверенного архива. Он **не**
откатывает данные. Для отката профиля восстановите совместимую прежней версии
копию в **новый** каталог через `ocean restore`; не запускайте старую программу
на схеме 29. История после выбранной копии не восстанавливается этим способом.
Format-2 restore сохраняет assets в карантине; новое выполнение требует штатного
`runtime restore` и точного подтверждения rebind владельцем в живом TTY.
Старый runtime также не читает новые room-task roots с `peerTools: false`.

## Поддержка и границы

При обращении приложите версию, Git revision из manifest.json, Node/ОС,
обезличенный вывод `ocean doctor --profile /absolute/profile --json` и точное
действие. Не публикуйте ключи, базы профилей, backup или реальные переписки.
Не повторяйте неизвестный внешний эффект и не удаляйте записи владельца вручную.

Физическая перезагрузка не квалифицирована. После аварии и потери временного
доказательства сокета исходный профиль закрыто отказывает; проверенный путь —
[совместимая копия в отдельный профиль](operations.md#потеря-временного-доказательства-сокета),
а не автоматическое восстановление исходника. Native-нагрузка квалифицирована
только в записанных пределах; лимиты presets не ограничивают всю автономную задачу.
Live OpenAI/Anthropic отложены; GitHub MCP квалифицирован только через read-only
Issues endpoint. Локальная модель и смешанная цепочка имеют конкретные измеренные
версии и ограничения в [карте F](platform-stage-f.md). Результаты старых RC не
считаются повторной проверкой финальных байтов.
