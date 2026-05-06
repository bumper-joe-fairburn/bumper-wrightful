import { Suspense } from "react";
import {
  CheckCircle2,
  ChevronRight,
  HelpCircle,
  MinusCircle,
  TriangleAlert,
  XCircle,
} from "lucide-react";
import { sql } from "kysely";
import { requestInfo } from "rwsdk/worker";
import { AnalyticsButtonGroup } from "@/app/components/analytics/button-group";
import { RunHistoryBranchFilter } from "@/app/components/run-history-branch-filter";
import { ALL_BRANCHES } from "@/app/components/run-history-branch-filter.shared";
import { TablePaginationFooter } from "@/app/components/table-pagination-footer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/app/components/ui/empty";
import { Skeleton } from "@/app/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/app/components/ui/table";
import { NotFoundPage } from "@/app/pages/not-found";
import { type ActiveProject, getActiveProject } from "@/lib/active-project";
import { makeRangeParser, rangeToSeconds } from "@/lib/analytics/range";
import { loadProjectBranches } from "@/lib/branches-query";
import { STATUS_COLORS } from "@/lib/status";
import { formatDuration, formatRelativeTime } from "@/lib/time-format";

type RangeKey = "7d" | "14d" | "30d";
const RANGES: readonly RangeKey[] = ["7d", "14d", "30d"];
const parseRange = makeRangeParser<RangeKey>(RANGES, "14d");

const PAGE_SIZE = 50;

interface TestRow {
  testId: string;
  title: string;
  file: string;
  latestStatus: string;
  latestRunId: string | null;
  latestTestResultId: string | null;
  lastSeen: number;
  n: number;
  avgDurationMs: number | null;
  passedCount: number;
  flakyCount: number;
  failCount: number;
  skippedCount: number;
}

interface TestsPageData {
  rows: TestRow[];
  totalUniqueTests: number;
  currentPage: number;
  totalPages: number;
  fromRow: number;
  toRow: number;
}

export async function TestsPage(): Promise<React.ReactElement> {
  // Membership gate has to resolve before we start streaming the shell so a
  // missing project surfaces as a clean 404 — same pattern as flaky-tests.
  const project = await getActiveProject();
  if (!project) return <NotFoundPage />;

  const url = new URL(requestInfo.request.url);
  const range = parseRange(url.searchParams.get("range"));
  const branchParam = url.searchParams.get("branch");
  const branchFilter =
    !branchParam || branchParam === ALL_BRANCHES ? null : branchParam;
  const q = (url.searchParams.get("q") ?? "").trim();
  const requestedPage = parsePage(url.searchParams.get("page"));

  const branchesPromise = loadProjectBranches(project);
  const dataPromise = loadTestsPageData(
    project,
    range,
    branchFilter,
    q,
    requestedPage,
  );

  const hrefWith = (overrides: Record<string, string | null>): string => {
    const p = new URLSearchParams(url.searchParams);
    for (const [k, v] of Object.entries(overrides)) {
      if (v === null) p.delete(k);
      else p.set(k, v);
    }
    const qs = p.toString();
    return qs ? `${url.pathname}?${qs}` : url.pathname;
  };

  return (
    <>
      <div className="px-6 py-5 flex flex-col gap-4 border-b border-border shrink-0 sm:flex-row sm:items-end sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Tests</h1>
          <Suspense
            fallback={
              <p className="mt-1 text-xs text-muted-foreground font-mono">
                Loading…
              </p>
            }
          >
            <CatalogSubtitle dataPromise={dataPromise} />
          </Suspense>
          <Suspense
            fallback={
              <div className="mt-2">
                <RunHistoryBranchFilter
                  branches={[]}
                  defaultValue={branchParam ?? ALL_BRANCHES}
                />
              </div>
            }
          >
            <BranchFilterSection
              branchesPromise={branchesPromise}
              defaultValue={branchParam ?? ALL_BRANCHES}
            />
          </Suspense>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <form className="relative" method="get">
            {/* Preserve other params on search submit. */}
            {Array.from(url.searchParams.entries())
              .filter(([k]) => k !== "q" && k !== "page")
              .map(([k, v]) => (
                <input key={k} type="hidden" name={k} value={v} />
              ))}
            <input
              type="text"
              name="q"
              defaultValue={q}
              placeholder="Filter path or name..."
              className="w-56 rounded-md border border-border bg-background px-3 py-1 font-mono text-xs text-foreground placeholder:text-muted-foreground focus:border-ring focus:outline-none focus:ring-[3px] focus:ring-ring/24"
            />
          </form>
          <AnalyticsButtonGroup
            options={RANGES}
            value={range}
            hrefFor={(r) => hrefWith({ range: r, page: null })}
          />
        </div>
      </div>

      <Suspense fallback={<TestsTableFallback />}>
        <TestsTableSection
          project={project}
          dataPromise={dataPromise}
          hrefWith={hrefWith}
          range={range}
          branchFilter={branchFilter}
          q={q}
        />
      </Suspense>
    </>
  );
}

async function BranchFilterSection({
  branchesPromise,
  defaultValue,
}: {
  branchesPromise: Promise<string[]>;
  defaultValue: string;
}): Promise<React.ReactElement> {
  const branches = await branchesPromise;
  return (
    <div className="mt-2">
      <RunHistoryBranchFilter branches={branches} defaultValue={defaultValue} />
    </div>
  );
}

async function CatalogSubtitle({
  dataPromise,
}: {
  dataPromise: Promise<TestsPageData>;
}): Promise<React.ReactElement> {
  const { totalUniqueTests } = await dataPromise;
  return (
    <p className="text-xs text-muted-foreground mt-1 font-mono">
      {totalUniqueTests.toLocaleString()} unique test
      {totalUniqueTests === 1 ? "" : "s"} seen in committed runs
    </p>
  );
}

async function TestsTableSection({
  project,
  dataPromise,
  hrefWith,
  range,
  branchFilter,
  q,
}: {
  project: ActiveProject;
  dataPromise: Promise<TestsPageData>;
  hrefWith: (overrides: Record<string, string | null>) => string;
  range: RangeKey;
  branchFilter: string | null;
  q: string;
}): Promise<React.ReactElement> {
  const data = await dataPromise;
  const base = `/t/${project.teamSlug}/p/${project.slug}`;

  if (data.rows.length === 0) {
    return (
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="flex items-center justify-center h-full p-10">
          <Empty>
            <EmptyHeader>
              <EmptyTitle>No tests in this window</EmptyTitle>
              <EmptyDescription>
                {q
                  ? `No tests match "${q}". Try a wider window or clear the filter.`
                  : `No committed runs recorded in the last ${range}${
                      branchFilter ? ` on ${branchFilter}` : ""
                    }.`}
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      </div>
    );
  }

  const pageHref = (page: number): string =>
    hrefWith({ page: page === 1 ? null : String(page) });

  return (
    <>
      <div className="flex-1 overflow-y-auto min-h-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead className="w-16 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
                Status
              </TableHead>
              <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
                Test
              </TableHead>
              <TableHead className="w-32 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                Last seen
              </TableHead>
              <TableHead className="w-16 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                Runs
              </TableHead>
              <TableHead className="w-40 px-4 font-mono text-[11px] uppercase tracking-wider">
                Pass / Flaky / Fail
              </TableHead>
              <TableHead className="w-24 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
                Avg
              </TableHead>
              <TableHead className="w-10 px-2" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.map((row) => {
              const tone = statusTone(row.latestStatus);
              const href =
                row.latestRunId && row.latestTestResultId
                  ? `${base}/runs/${row.latestRunId}/tests/${row.latestTestResultId}?attempt=0`
                  : base;
              return (
                <TableRow
                  key={row.testId}
                  className="border-b border-border/50"
                >
                  <TableCell className="px-4 py-3">
                    <div className="flex items-center justify-center">
                      <tone.Icon size={18} color={tone.iconColor} />
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 max-w-md">
                    <a
                      href={href}
                      className="block truncate font-mono text-sm text-foreground hover:underline"
                    >
                      {row.title || row.testId}
                    </a>
                    <div className="mt-0.5 truncate font-mono text-[10px] text-muted-foreground">
                      {row.file}
                    </div>
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {formatRelativeTime(row.lastSeen)}
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-muted-foreground">
                    {row.n.toLocaleString()}
                  </TableCell>
                  <TableCell className="px-4 py-3">
                    <OutcomeBar
                      passed={row.passedCount}
                      flaky={row.flakyCount}
                      failed={row.failCount}
                      skipped={row.skippedCount}
                    />
                  </TableCell>
                  <TableCell className="px-4 py-3 text-right font-mono text-xs tabular-nums text-foreground">
                    {row.avgDurationMs === null
                      ? "—"
                      : formatDuration(Math.round(row.avgDurationMs))}
                  </TableCell>
                  <TableCell className="px-2 py-3 text-center text-muted-foreground">
                    <a href={href} aria-label="Open latest run">
                      <ChevronRight size={14} />
                    </a>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </div>
      {data.totalPages > 1 && (
        <TablePaginationFooter
          fromRow={data.fromRow}
          toRow={data.toRow}
          totalCount={data.totalUniqueTests}
          currentPage={data.currentPage}
          totalPages={data.totalPages}
          itemNoun="test"
          pageHref={pageHref}
        />
      )}
    </>
  );
}

function TestsTableFallback(): React.ReactElement {
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead className="w-16 px-4 text-center font-mono text-[11px] uppercase tracking-wider">
            Status
          </TableHead>
          <TableHead className="px-4 font-mono text-[11px] uppercase tracking-wider">
            Test
          </TableHead>
          <TableHead className="w-32 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
            Last seen
          </TableHead>
          <TableHead className="w-16 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
            Runs
          </TableHead>
          <TableHead className="w-40 px-4 font-mono text-[11px] uppercase tracking-wider">
            Pass / Flaky / Fail
          </TableHead>
          <TableHead className="w-24 px-4 text-right font-mono text-[11px] uppercase tracking-wider">
            Avg
          </TableHead>
          <TableHead className="w-10 px-2" />
        </TableRow>
      </TableHeader>
      <TableBody>
        {Array.from({ length: 8 }).map((_, i) => (
          <TableRow key={`skel-${i}`} className="border-b border-border/50">
            <TableCell className="px-4 py-3">
              <div className="flex items-center justify-center">
                <Skeleton className="h-[18px] w-[18px] rounded-full" />
              </div>
            </TableCell>
            <TableCell className="px-4 py-3">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-3 w-1/2 mt-1.5" />
            </TableCell>
            <TableCell className="px-4 py-3 text-right">
              <Skeleton className="h-3 w-16 ml-auto" />
            </TableCell>
            <TableCell className="px-4 py-3 text-right">
              <Skeleton className="h-3 w-8 ml-auto" />
            </TableCell>
            <TableCell className="px-4 py-3">
              <Skeleton className="h-2.5 w-32" />
            </TableCell>
            <TableCell className="px-4 py-3 text-right">
              <Skeleton className="h-3 w-10 ml-auto" />
            </TableCell>
            <TableCell className="px-2 py-3" />
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

// ---- data loading -------------------------------------------------------

async function loadTestsPageData(
  project: ActiveProject,
  range: RangeKey,
  branchFilter: string | null,
  q: string,
  requestedPage: number,
): Promise<TestsPageData> {
  // Filter on `runs.createdAt` (not `testResults.createdAt`) so the planner
  // can use the `runs (projectId, createdAt)` index. The two timestamps are
  // within milliseconds of each other in practice — they differ only by the
  // test runtime — so the result set is functionally identical.
  const nowSec = Math.floor(Date.now() / 1000);
  const rangeSec = rangeToSeconds(range) ?? 0;
  const windowStartSec = nowSec - rangeSec;

  const branchClause = branchFilter
    ? sql`AND "runs"."branch" = ${branchFilter}`
    : sql``;
  const searchClause = q
    ? sql`AND ("testResults"."title" LIKE ${`%${q}%`} OR "testResults"."file" LIKE ${`%${q}%`})`
    : sql``;

  // Query A — paginate testIds by lastSeen DESC, plus a windowed total
  // count so we don't need a second round trip just for pagination math.
  // `count(*) OVER ()` runs over the GROUP-BY-collapsed row set, so it's
  // the count of distinct testIds. LIMIT/OFFSET apply afterwards.
  const offset = (requestedPage - 1) * PAGE_SIZE;
  const pageRes = await sql<{
    testId: string;
    lastSeen: number;
    totalDistinct: number;
  }>`
    SELECT
      "testId",
      "lastSeen",
      "totalDistinct"
    FROM (
      SELECT
        "testResults"."testId" AS "testId",
        MAX("testResults"."createdAt") AS "lastSeen",
        count(*) OVER () AS "totalDistinct"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${project.id}
        AND "runs"."committed" = 1
        AND "runs"."createdAt" >= ${windowStartSec}
        ${branchClause}
        ${searchClause}
      GROUP BY "testResults"."testId"
    )
    ORDER BY "lastSeen" DESC
    LIMIT ${sql.raw(String(PAGE_SIZE))}
    OFFSET ${sql.raw(String(offset))}
  `.execute(project.db);

  const totalUniqueTests = pageRes.rows[0]?.totalDistinct ?? 0;
  const totalPages = Math.max(1, Math.ceil(totalUniqueTests / PAGE_SIZE));

  // Out-of-range page (manual URL edit, deleted runs, etc): clamp to last
  // page and re-fetch. Uncommon; one extra round trip is fine.
  let rowsForPage = pageRes.rows;
  let currentPage = requestedPage;
  if (rowsForPage.length === 0 && totalUniqueTests > 0 && requestedPage > 1) {
    currentPage = totalPages;
    const reOffset = (currentPage - 1) * PAGE_SIZE;
    const reRes = await sql<{
      testId: string;
      lastSeen: number;
      totalDistinct: number;
    }>`
      SELECT "testId", "lastSeen", "totalDistinct"
      FROM (
        SELECT
          "testResults"."testId" AS "testId",
          MAX("testResults"."createdAt") AS "lastSeen",
          count(*) OVER () AS "totalDistinct"
        FROM "testResults"
        INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
        WHERE "runs"."projectId" = ${project.id}
          AND "runs"."committed" = 1
          AND "runs"."createdAt" >= ${windowStartSec}
          ${branchClause}
          ${searchClause}
        GROUP BY "testResults"."testId"
      )
      ORDER BY "lastSeen" DESC
      LIMIT ${sql.raw(String(PAGE_SIZE))}
      OFFSET ${sql.raw(String(reOffset))}
    `.execute(project.db);
    rowsForPage = reRes.rows;
  } else {
    currentPage = Math.min(requestedPage, totalPages);
  }

  if (rowsForPage.length === 0) {
    return {
      rows: [],
      totalUniqueTests,
      currentPage,
      totalPages,
      fromRow: 0,
      toRow: 0,
    };
  }

  const lastSeenById = new Map(rowsForPage.map((r) => [r.testId, r.lastSeen]));
  const testIds = rowsForPage.map((r) => r.testId);

  // Query B — page aggregates. Touches only rows where testId is in the
  // page set, so work is bounded by ~PAGE_SIZE testIds × occurrences.
  const aggRes = await sql<{
    testId: string;
    n: number;
    avgDurationMs: number | null;
    title: string | null;
    file: string | null;
    latestStatus: string | null;
    latestRunId: string | null;
    latestTestResultId: string | null;
    passedCount: number;
    flakyCount: number;
    failCount: number;
    skippedCount: number;
  }>`
    WITH ranked AS (
      SELECT
        "testResults"."testId" AS "testId",
        "testResults"."title" AS "title",
        "testResults"."file" AS "file",
        "testResults"."status" AS "status",
        "testResults"."durationMs" AS "durationMs",
        "testResults"."createdAt" AS "createdAt",
        "testResults"."runId" AS "runId",
        "testResults"."id" AS "testResultId",
        row_number() OVER (
          PARTITION BY "testResults"."testId"
          ORDER BY "testResults"."createdAt" DESC
        ) AS "rnTime"
      FROM "testResults"
      INNER JOIN "runs" ON "runs"."id" = "testResults"."runId"
      WHERE "runs"."projectId" = ${project.id}
        AND "runs"."committed" = 1
        AND "runs"."createdAt" >= ${windowStartSec}
        AND "testResults"."testId" IN (${sql.join(testIds)})
        ${branchClause}
    )
    SELECT
      "testId",
      COUNT(*) AS "n",
      AVG("durationMs") AS "avgDurationMs",
      MAX(CASE WHEN "rnTime" = 1 THEN "title" END) AS "title",
      MAX(CASE WHEN "rnTime" = 1 THEN "file" END) AS "file",
      MAX(CASE WHEN "rnTime" = 1 THEN "status" END) AS "latestStatus",
      MAX(CASE WHEN "rnTime" = 1 THEN "runId" END) AS "latestRunId",
      MAX(CASE WHEN "rnTime" = 1 THEN "testResultId" END) AS "latestTestResultId",
      SUM(CASE WHEN "status" = 'passed' THEN 1 ELSE 0 END) AS "passedCount",
      SUM(CASE WHEN "status" = 'flaky' THEN 1 ELSE 0 END) AS "flakyCount",
      SUM(CASE WHEN "status" IN ('failed', 'timedout') THEN 1 ELSE 0 END) AS "failCount",
      SUM(CASE WHEN "status" = 'skipped' THEN 1 ELSE 0 END) AS "skippedCount"
    FROM ranked
    GROUP BY "testId"
  `.execute(project.db);

  const aggById = new Map(aggRes.rows.map((r) => [r.testId, r]));

  // Preserve the lastSeen DESC ordering from query A — the IN-list in
  // query B doesn't preserve order.
  const rows: TestRow[] = testIds.flatMap((id) => {
    const a = aggById.get(id);
    const lastSeen = lastSeenById.get(id) ?? 0;
    if (!a) return [];
    return [
      {
        testId: id,
        title: a.title ?? "",
        file: a.file ?? "",
        latestStatus: a.latestStatus ?? "",
        latestRunId: a.latestRunId,
        latestTestResultId: a.latestTestResultId,
        lastSeen,
        n: a.n,
        avgDurationMs: a.avgDurationMs,
        passedCount: a.passedCount,
        flakyCount: a.flakyCount,
        failCount: a.failCount,
        skippedCount: a.skippedCount,
      },
    ];
  });

  const fromRow =
    totalUniqueTests === 0 ? 0 : (currentPage - 1) * PAGE_SIZE + 1;
  const toRow = (currentPage - 1) * PAGE_SIZE + rows.length;

  return {
    rows,
    totalUniqueTests,
    currentPage,
    totalPages,
    fromRow,
    toRow,
  };
}

// ---- helpers ------------------------------------------------------------

interface StatusTone {
  Icon: typeof CheckCircle2;
  iconColor: string;
}

function statusTone(status: string): StatusTone {
  switch (status) {
    case "passed":
      return { Icon: CheckCircle2, iconColor: STATUS_COLORS.passed };
    case "failed":
    case "timedout":
      return { Icon: XCircle, iconColor: STATUS_COLORS.failed };
    case "flaky":
      return { Icon: TriangleAlert, iconColor: STATUS_COLORS.flaky };
    case "skipped":
      return { Icon: MinusCircle, iconColor: STATUS_COLORS.skipped };
    default:
      return {
        Icon: HelpCircle,
        iconColor: "var(--color-muted-foreground)",
      };
  }
}

function OutcomeBar({
  passed,
  flaky,
  failed,
  skipped,
}: {
  passed: number;
  flaky: number;
  failed: number;
  skipped: number;
}): React.ReactElement {
  const total = passed + flaky + failed + skipped;
  if (total === 0) {
    return <div className="font-mono text-[10px] text-muted-foreground">—</div>;
  }
  const segments: { count: number; color: string; label: string }[] = [
    { count: passed, color: STATUS_COLORS.passed, label: "passed" },
    { count: flaky, color: STATUS_COLORS.flaky, label: "flaky" },
    { count: failed, color: STATUS_COLORS.failed, label: "failed" },
    { count: skipped, color: STATUS_COLORS.skipped, label: "skipped" },
  ];
  return (
    <div className="flex flex-col gap-1">
      <div
        className="flex h-1.5 w-32 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${passed} passed, ${flaky} flaky, ${failed} failed, ${skipped} skipped`}
      >
        {segments.map((s) =>
          s.count > 0 ? (
            <span
              key={s.label}
              style={{
                width: `${(s.count / total) * 100}%`,
                backgroundColor: s.color,
              }}
            />
          ) : null,
        )}
      </div>
      <div className="font-mono text-[10px] tabular-nums text-muted-foreground">
        <span style={{ color: STATUS_COLORS.passed }}>{passed}</span>
        {" / "}
        <span style={{ color: STATUS_COLORS.flaky }}>{flaky}</span>
        {" / "}
        <span style={{ color: STATUS_COLORS.failed }}>{failed}</span>
      </div>
    </div>
  );
}

function parsePage(value: string | null): number {
  const n = parseInt(value ?? "1", 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}
