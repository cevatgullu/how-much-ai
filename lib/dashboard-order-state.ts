import { sortWeeklyAccountMetrics, type QuotaSortMode, type WeeklyAccountMetric } from "./quota-metrics";

export type InteractionChannel = "focus" | "pointer";

export type DashboardOrderEvent =
  | { type: "batch_started"; accountIds: readonly string[] }
  | { type: "account_settled"; accountId: string }
  | { type: "candidate_order"; accountIds: readonly string[]; acceptedEpoch: number }
  | { type: "sort_changed"; mode: QuotaSortMode; accountIds: readonly string[] }
  | { type: "accounts_changed"; accountIds: readonly string[] }
  | { type: "interaction_enter"; accountId: string; channel: InteractionChannel }
  | { type: "interaction_leave"; accountId: string; channel: InteractionChannel };

export interface DashboardOrderState {
  mode: QuotaSortMode;
  visibleAccountIds: readonly string[];
  pendingAccountIds: readonly string[] | null;
  unsettledAccountIds: readonly string[];
  focusAccountIds: readonly string[];
  pointerAccountIds: readonly string[];
  acceptedEpoch: number;
}

function uniqueAccountIds(accountIds: readonly string[]): string[] {
  return [...new Set(accountIds)];
}

function reconcileAccountIds(accountIds: readonly string[], vaultAccountIds: readonly string[]): string[] {
  const validAccountIds = new Set(vaultAccountIds);
  const retained = uniqueAccountIds(accountIds).filter((accountId) => validAccountIds.has(accountId));
  return [...retained, ...vaultAccountIds.filter((accountId) => !retained.includes(accountId))];
}

function interactionIsActive(state: DashboardOrderState): boolean {
  return state.focusAccountIds.length > 0 || state.pointerAccountIds.length > 0;
}

function releasePendingOrder(state: DashboardOrderState): DashboardOrderState {
  if (state.pendingAccountIds === null || interactionIsActive(state)) return state;
  return { ...state, visibleAccountIds: state.pendingAccountIds, pendingAccountIds: null };
}

function acceptCandidate(
  state: DashboardOrderState,
  accountIds: readonly string[],
  acceptedEpoch: number | null,
): DashboardOrderState {
  if (acceptedEpoch !== null && acceptedEpoch <= state.acceptedEpoch) return state;
  if (state.unsettledAccountIds.length > 0) return state;

  const candidateAccountIds = reconcileAccountIds(accountIds, state.visibleAccountIds);
  const nextState = {
    ...state,
    ...(acceptedEpoch === null ? {} : { acceptedEpoch }),
  };

  if (interactionIsActive(nextState)) {
    return { ...nextState, pendingAccountIds: candidateAccountIds };
  }
  return { ...nextState, visibleAccountIds: candidateAccountIds, pendingAccountIds: null };
}

export function initialDashboardOrderState(
  accountIds: readonly string[],
  mode: QuotaSortMode,
): DashboardOrderState {
  return {
    mode,
    visibleAccountIds: uniqueAccountIds(accountIds),
    pendingAccountIds: null,
    unsettledAccountIds: [],
    focusAccountIds: [],
    pointerAccountIds: [],
    acceptedEpoch: 0,
  };
}

export function dashboardOrderReducer(
  state: DashboardOrderState,
  event: DashboardOrderEvent,
): DashboardOrderState {
  switch (event.type) {
    case "batch_started":
      return {
        ...state,
        unsettledAccountIds: uniqueAccountIds([...state.unsettledAccountIds, ...event.accountIds]),
      };
    case "account_settled":
      return {
        ...state,
        unsettledAccountIds: state.unsettledAccountIds.filter((accountId) => accountId !== event.accountId),
      };
    case "candidate_order":
      return acceptCandidate(state, event.accountIds, event.acceptedEpoch);
    case "sort_changed":
      return acceptCandidate({ ...state, mode: event.mode }, event.accountIds, null);
    case "accounts_changed": {
      const accountIds = uniqueAccountIds(event.accountIds);
      const nextState: DashboardOrderState = {
        ...state,
        visibleAccountIds: reconcileAccountIds(state.visibleAccountIds, accountIds),
        pendingAccountIds: state.pendingAccountIds === null ? null : reconcileAccountIds(state.pendingAccountIds, accountIds),
        unsettledAccountIds: state.unsettledAccountIds.filter((accountId) => accountIds.includes(accountId)),
        focusAccountIds: state.focusAccountIds.filter((accountId) => accountIds.includes(accountId)),
        pointerAccountIds: state.pointerAccountIds.filter((accountId) => accountIds.includes(accountId)),
      };
      return releasePendingOrder(nextState);
    }
    case "interaction_enter": {
      const key = event.channel === "focus" ? "focusAccountIds" : "pointerAccountIds";
      return { ...state, [key]: uniqueAccountIds([...state[key], event.accountId]) };
    }
    case "interaction_leave": {
      const key = event.channel === "focus" ? "focusAccountIds" : "pointerAccountIds";
      return releasePendingOrder({ ...state, [key]: state[key].filter((accountId) => accountId !== event.accountId) });
    }
  }
}

export function resolvedDashboardOrder(
  metrics: readonly WeeklyAccountMetric[],
  mode: QuotaSortMode,
): string[] {
  return sortWeeklyAccountMetrics(metrics, mode).map((metric) => metric.accountId);
}
