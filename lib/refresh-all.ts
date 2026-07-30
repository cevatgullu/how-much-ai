export interface RefreshAllSummary {
  updated: number;
  total: number;
}

export async function refreshAllAccounts(
  ids: readonly string[],
  refreshAccount: (id: string) => Promise<boolean>,
): Promise<RefreshAllSummary> {
  const results = await Promise.all(
    ids.map((id) =>
      Promise.resolve()
        .then(() => refreshAccount(id))
        .catch(() => false),
    ),
  );
  return { updated: results.filter(Boolean).length, total: ids.length };
}
