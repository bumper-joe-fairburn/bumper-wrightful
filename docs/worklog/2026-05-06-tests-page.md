# 2026-05-06 — Tests catalog page

## What changed

Enabled the previously-disabled "Tests" sidebar entry as a real page at
`/t/:teamSlug/p/:projectSlug/tests`. It lists every unique test seen in
committed runs over a 7d / 14d / 30d window, sorted by most recent run
first, with branch + free-text filters and pagination. Complements the
existing focused pages (Flaky Tests, Slowest Tests) with a flat catalog
view of "what tests do we have?".

## Details

- **New page**: `packages/dashboard/src/app/pages/tests.tsx` — RSC, Suspense-wrapped table.
- **Route**: `route("/t/:teamSlug/p/:projectSlug/tests", TestsPage)` in `worker.tsx`.
- **Sidebar**: `app-layout.tsx` — link enabled (was `href: "#"` / `disabled: true`).
- **Active-nav regex**: tightened from `/\/tests\//` to `/\/tests(\/|$)/` so the new top-level path activates the nav (the old regex required a trailing segment and only caught `/runs/:runId/tests/:testResultId`).
- **Window**: 7d / 14d / 30d, default 14d.
- **Page size**: 50.
- **Columns**: Status icon · Test (title + file) · Last seen · Runs · Pass/Flaky/Fail bar · Avg duration.
- **Page chrome** (post-review): no Card wrapper — header strip with title/subtitle/branch/range/search, then table fills the page in a `flex-1 overflow-y-auto min-h-0` scroll area, with pagination pinned below as a non-scrolling footer. Mirrors the structure of `flaky-tests.tsx` and `runs-list.tsx`.

## Query design

Two SQL round trips per render. Both filter on `runs.createdAt` (not
`testResults.createdAt`) so the planner can use the
`runs (projectId, createdAt)` index — the existing flaky/slowest pages
filter on `testResults.createdAt`, leaving that index off the table.
The two timestamps differ only by per-test runtime so the result set is
functionally identical.

1. **Page testIds + total count, in one query.** GROUP BY `testId` over
   the window, with `count(*) OVER ()` (after the GROUP BY collapse) as
   the distinct count. ORDER BY `MAX(createdAt) DESC` LIMIT/OFFSET. No
   per-row window functions, only ever returns ≤ 50 rows.
2. **Page aggregates.** A `WITH ranked AS (… row_number() OVER (PARTITION BY testId
ORDER BY createdAt DESC))` CTE restricted to the page's testIds via
   `WHERE testResults.testId IN (...)`. Pulls latest `title` / `file` /
   `status` / `runId` / `testResultId`, plus pass/flaky/fail/skip counts.

This is intentionally **not** the slowest-tests pattern of one big CTE
that scans every windowed row. Slowest-tests has to — every row
contributes to a p95 — but a "sort by most-recent-run" catalog can
paginate testIds first and aggregate only the page. Cost is bounded by
the page size, not the suite size.

Out-of-range `?page=` values (manual URL edits, recently-deleted runs)
clamp to the last valid page with one extra round trip — uncommon, so
the simple branch is preferred over a more elaborate single-query
fallback.

## Verification

| Check                                     | Result                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm typecheck` (dashboard)              | Same set of pre-existing errors in `__tests__/run-progress-broadcast.test.ts` and `runs-filter-bar.test.tsx` as on `main`; no new errors from the page. |
| `pnpm lint`                               | 0 errors, 41 warnings — all warnings pre-existing in unrelated files. New page produces none.                                                           |
| `pnpm format`                             | Cleaned via `pnpm format:fix`.                                                                                                                          |
| `pnpm --filter @wrightful/dashboard test` | 333 tests passed.                                                                                                                                       |
| Manual UI                                 | Pending — reporter is in production and the user runs `pnpm dev` themselves.                                                                            |

## Manual smoke checklist

- Navigate to `/t/<team>/p/<proj>/tests` — page renders with shell + skeleton, then table streams in.
- Sidebar "Tests" item is no longer dimmed and highlights when active.
- Range chips switch between 7d / 14d / 30d (resets `page`).
- Branch combobox narrows results.
- Search box (`?q=`) filters by title or file substring.
- Click a row — opens the latest test result for that test.
- Empty project / empty window → `Empty` placeholder renders.
- `?page=` past the last page clamps to the last valid page.
