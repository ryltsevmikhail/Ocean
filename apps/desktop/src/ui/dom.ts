const errors: Record<string, string> = {
  attachment_too_large: 'Один файл — не более 10 МБ.',
  attachment_unavailable: 'Не удалось открыть вложение. Попробуйте прикрепить файл ещё раз.',
  invalid_image: 'Не удалось прочитать изображение. Поддерживаются PNG, JPEG, GIF и WebP.',
  message_too_large: 'Сообщение вместе с описанием вложений превышает допустимую длину.',
  attachment_corrupted: 'Контрольная сумма файла не совпала. Нужен исходный файл.',
  invalid_attachment: 'Не удалось проверить вложение.',

  invalid_request:
    'Проверьте поля. Desktop не принимает значения, начинающиеся с «--», или отдельное «-V».',
  invalid_input: 'Проверьте текст, имя и выбранного участника.',
  provider_unavailable: 'Провайдер недоступен. Проверьте конфигурацию провайдера процесса runtime.',
  outcome_unknown:
    'Исход операции неизвестен. Обновите историю и состояние запуска перед новой отправкой.',
  room_busy: 'В комнате уже выполняется запрос.',
  owner_busy: 'Профиль занят другим процессом. Обновите после его завершения.',
  choose_recipient: 'Выберите бота для сообщения с ведущим @упоминанием.',
  recovery_required: 'Предыдущий запрос требует разбора в Ocean CLI.',
  restore_restricted:
    'Восстановленный профиль доступен для чтения. Для нового запроса требуется подтверждение в CLI.',
  handle_taken: 'Такой идентификатор бота уже занят.',
  context_limit: 'История превысила лимит контекста модели.',
  not_member: 'Этот бот не состоит в комнате.',
  runtime_absent: 'Runtime не запущен. Запустите ocean runtime start с выбранным профилем.',
  profile_missing: 'Профиль недоступен. Проверьте OCEAN_DESKTOP_PROFILE и инициализацию в CLI.',
  insecure_permissions:
    'Runtime отказал в доступе. Проверьте приватные права и канонический путь профиля.',
  no_active_send: 'Запрос уже завершился или больше не принадлежит этому окну.',
};
export function explain(error: unknown) {
  const code = error instanceof Error ? error.message : String(error);
  return (
    errors[code] ??
    (/^[a-z_]+$/.test(code)
      ? 'Ошибка Ocean · ' + code
      : 'Нет подтверждённого ответа runtime. Обновите историю.')
  );
}
