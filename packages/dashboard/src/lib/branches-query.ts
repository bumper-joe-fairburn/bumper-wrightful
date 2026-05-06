import type { ActiveProject } from "@/lib/active-project";

/**
 * Distinct, sorted branch list for committed runs in a project. Used by
 * the run-history branch filter in tests / flaky-tests / slowest-tests /
 * run-detail.
 */
export async function loadProjectBranches(
  project: ActiveProject,
): Promise<string[]> {
  const rows = await project.db
    .selectFrom("runs")
    .select("branch as value")
    .distinct()
    .where("projectId", "=", project.id)
    .where("committed", "=", 1)
    .where("branch", "is not", null)
    .execute();
  return rows
    .map((r) => r.value)
    .filter((v): v is string => !!v)
    .sort();
}
