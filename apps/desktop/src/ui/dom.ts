export function el<T extends HTMLElement=HTMLElement>(id:string):T {
  const element=document.getElementById(id);
  if(!element) throw new Error('missing_view');
  return element as T;
}
export function node<K extends keyof HTMLElementTagNameMap>(tag:K,text=''){
  const element=document.createElement(tag);
  element.textContent=text;
  return element;
}
const errors:Record<string,string>={
  invalid_request:'Проверьте поля. CLI v1 не принимает значения, начинающиеся с «--», или отдельное «-V».',
  invalid_input:'Проверьте текст, имя и выбранного участника.',
  provider_unavailable:'Провайдер недоступен. Проверьте локальный ключ DeepSeek и модель профиля.',
  outcome_unknown:'Исход операции неизвестен. Обновите историю и состояние запуска перед новой отправкой.',
  room_busy:'В комнате уже выполняется запрос.',owner_busy:'Профиль занят другим процессом. Обновите после его завершения.',
  choose_recipient:'Выберите бота для сообщения с ведущим @упоминанием.',
  recovery_required:'Предыдущий запрос требует разбора в Ocean CLI.',
  restore_restricted:'Восстановленный профиль доступен для чтения. Для нового запроса требуется подтверждение в CLI.',
  handle_taken:'Такой идентификатор бота уже занят.', context_limit:'История превысила лимит контекста модели.',
  not_member:'Этот бот не состоит в комнате.',runtime_unavailable:'Локальный Node недоступен. Пересоберите приложение.',
  insecure_permissions:'Runtime отказал в доступе. Проверьте приватные права и канонический путь профиля.',
  no_active_send:'Запрос уже завершился или больше не принадлежит этому окну.',
};
export function explain(error:unknown) {
  const code=error instanceof Error?error.message:String(error);
  return errors[code] ?? (/^[a-z_]+$/.test(code)?'Ошибка Ocean · '+code:'Нет подтверждённого ответа runtime. Обновите историю.');
}
