// `meeting_group_users.presence_status` é varchar livre. O seed grava "PRESENT"
// / "ABSENT", mas há registros antigos em português: comparamos sem caixa.
const PRESENT_STATUSES = new Set(["present", "presente"]);

export function isPresent(status: string | null | undefined): boolean {
  return PRESENT_STATUSES.has((status ?? "").trim().toLowerCase());
}
