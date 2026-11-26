// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * web_search: the web, for what the data tools do not hold, through the session's provider search
 * (search.ts). Every agent has it, as it has the compute tools; one call is one recorded result, cited by
 * its id like any other, listing the pages found and the search model's findings, each finding with the
 * numbers of the pages it rests on. The record keeps every page and finding whole; the text the model and
 * the transcript read fits its room, and a cut says where the rest is. Like every tool result, it is
 * information under the agents' own rule on data (agents/prompts.ts DATA_NOT_INSTRUCTIONS).
 */
import { z } from "zod";
import { CALLS } from "../../contracts/limits.js";
import { hint } from "../../tools/preview.js";
import { referenceTo } from "../../tools/references.js";
import { defineTool, type Tool } from "../../tools/tool.js";
import { isoDate, oneLine, roomIn, shortened, shownOf } from "../../tools/tool-text.js";
import { type WebSearcher, type WebSearchSetup, webSearcher } from "./search.js";

export type { WebSearchSetup } from "./search.js";

/** A site as the model may write it ("https://www.sec.gov/"), read as its domain ("sec.gov"). */
const site = z
  .string()
  .trim()
  .toLowerCase()
  .transform((value) =>
    value
      .replace(/^[a-z][a-z0-9+.-]*:\/\//, "")
      .replace(/[/?#].*$/, "")
      .replace(/^www\./, ""),
  )
  .pipe(
    z.string().regex(/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/, "a domain such as sec.gov"),
  );

const RESULT = z.object({
  n: z.number().int().positive(),
  title: z.string().nullable(),
  url: z.string(),
  site: z.string(),
  published: z.string().nullable(),
  snippet: z.string().nullable(),
});
const FINDING = z.object({ text: z.string(), results: z.array(z.number().int().positive()) });
const OUT = z.object({
  query: z.string(),
  since: z.string().optional(),
  sites: z.array(z.string()).optional(),
  /** The provider and model that searched: "anthropic/claude-haiku-5-5". */
  searched_with: z.string(),
  searches: z.array(z.string()),
  findings: z.array(FINDING),
  results: z.array(RESULT),
});

const DESCRIPTION =
  "Search the web for what the data tools do not hold: recent events and announcements, guidance, deals, " +
  "litigation, regulation, management, products, industry and policy news, or a figure no data tool serves. " +
  "Returns the pages a search model found (site, title, link, date when given) and its findings, each with " +
  "the pages it rests on. The data tools come first for prices, statements, filings, estimates and economic " +
  "series. An answer that uses a page cites it with a markdown link to it, [site](url). Ask one specific " +
  "question (the company, the event, the period), narrowed with since or sites when that helps.";

/**
 * Text a page or the search model wrote, on one line; a long one cut as a long field is, with a note of
 * how much was left out and, given `where`, where all of it is.
 */
function cut(text: string, where: string | undefined): { shown: string; rest: string } {
  const flat = oneLine(text);
  if (flat.length <= CALLS.longFieldChars) return { shown: flat, rest: "" };
  const shown = shortened(flat, CALLS.longFieldChars);
  const more = flat.length - shown.length + 1;
  return { shown, rest: ` (${more} more characters${where ? `; all of it is in ${where}` : ""})` };
}

/** Such text as a line's words; in quotes (a page's own words, a query), with its note after them. */
function line(text: string, where?: string): string {
  const { shown, rest } = cut(text, where);
  return `${shown}${rest}`;
}
function quoted(text: string, where?: string): string {
  const { shown, rest } = cut(text, where);
  return `"${shown}"${rest}`;
}

/** Sites as one short phrase: "reuters.com, cnbc.com +3". */
function siteList(sites: readonly string[], most = 2): string {
  const shown = sites.slice(0, most).join(", ");
  return sites.length > most ? `${shown} +${sites.length - most}` : shown;
}

/** Rows' characters as `fitting` counts them, a line break each. */
const size = (rows: readonly string[]) => rows.reduce((sum, row) => sum + row.length + 1, 0);

/**
 * The finding rows, then the page rows, within `room`: both whole when they fit, else the findings first
 * in up to half the room (more when the pages need less), each list cut saying where every one of it is.
 */
function fittedRows(
  findings: readonly string[],
  pages: readonly string[],
  room: number,
  id: string | undefined,
): [string[], string[]] {
  const first =
    size(findings) + size(pages) <= room ? room : Math.max(Math.floor(room / 2), room - size(pages));
  const shown = shownOf(findings, first, id ? referenceTo(id, "findings") : undefined);
  return [shown, shownOf(pages, room - size(shown), id ? referenceTo(id, "results") : undefined)];
}

/** The web_search tool on `searcher`. */
export function webSearchTool(searcher: WebSearcher) {
  return defineTool({
    name: "web_search",
    description: DESCRIPTION,
    kind: "data",
    parallelSafe: true,
    input: z.object({
      query: z
        .string()
        .trim()
        .min(3)
        .describe(
          "What to find, as a specific question or search: the company, event or figure, and the period",
        ),
      since: isoDate.optional().describe("Only pages from this day on, YYYY-MM-DD"),
      sites: z
        .array(site)
        .min(1)
        .optional()
        .describe("Only pages on these sites, such as sec.gov or reuters.com"),
      limit: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe(
          "The most pages to list, though every page a finding rests on is listed; every page found when left out",
        ),
    }),
    output: OUT,
    label: ({ query }) => query,
    // Under its count: the first pages, each its site and title.
    preview: [hint(OUT, { list: "results", fields: ["site", "title"] })],
    async run({ query, since, sites, limit }, { signal, clock }) {
      const today = (clock?.() ?? new Date()).toISOString().slice(0, 10);
      const found = await searcher.search(
        {
          query,
          ...(since ? { since } : {}),
          ...(sites ? { sites } : {}),
          ...(limit !== undefined ? { limit } : {}),
          today,
        },
        signal,
      );
      // Kept whole: what the model and the transcript read is fitted when it is written (render).
      const places = [...new Set(found.results.map((page) => page.site))];
      return {
        payload: {
          query,
          ...(since ? { since } : {}),
          ...(sites ? { sites } : {}),
          searched_with: searcher.model,
          searches: found.searches,
          findings: found.findings,
          results: found.results,
        },
        provenance: {
          // A cited search names, in the list of sources, the sites its pages are on; each page is cited
          // in the answer with its own link.
          source: places.length ? `${siteList(places)} via ${searcher.source}` : searcher.source,
          as_of: today,
          ...(found.notes.length ? { notes: found.notes } : {}),
        },
        summary: found.results.length
          ? `${found.results.length} page${found.results.length === 1 ? "" : "s"} from ${siteList(places, 3)}`
          : "no pages found",
      };
    },
    render({ query, since, sites, searched_with, searches, findings, results }, { id, room }) {
      const at = (path: string) => (id ? referenceTo(id, path) : undefined);
      const asked = searches.map((search, i) => quoted(search, at(`searches[${i}]`)));
      const head = [
        `${results.length} page${results.length === 1 ? "" : "s"} found for ${quoted(query, at("query"))}${sites ? ` on ${sites.join(", ")}` : ""}${since ? `, asked for pages from ${since} on` : ""}, searched with ${searched_with}${asked.length ? ` as ${asked.join(", ")}` : ""}`,
        `Cite ${id ? `these pages as [${id}], and each page used ` : "each page used "}with a markdown link to it, [site](url); page numbers (p1, p2) are not citations.`,
      ];
      const findingRows = findings.map(
        (finding, i) =>
          `- ${line(finding.text, at(`findings[${i}].text`))} (${finding.results.length ? finding.results.map((n) => `p${n}`).join(", ") : "no page cited"})`,
      );
      const pageRows = results.map((page, i) =>
        [
          `p${page.n} ${oneLine(page.site)}${page.published ? `, ${line(page.published, at(`results[${i}].published`))}` : ""}: ${(page.title && line(page.title, at(`results[${i}].title`))) || "untitled"}`,
          `  ${oneLine(page.url)}`,
          ...(page.snippet ? [`  ${quoted(page.snippet, at(`results[${i}].snippet`))}`] : []),
        ].join("\n"),
      );
      const labels = [
        ...(findingRows.length ? ["findings:"] : []),
        results.length ? "pages:" : "No pages were found.",
      ];
      const [shownFindings, shownPages] = fittedRows(findingRows, pageRows, roomIn(room, head, labels), id);
      return [
        ...head,
        ...(findingRows.length ? ["findings:", ...shownFindings] : []),
        ...(results.length ? ["pages:", ...shownPages] : ["No pages were found."]),
      ];
    },
  });
}

/**
 * The web_search tool for an engine's settings: none without a provider search to run it on. `stallMs`:
 * how long a search request may send nothing before it is ended, the model's own stall time.
 */
export function webSearchTools(settings: {
  webSearch?: WebSearchSetup;
  fetch?: typeof globalThis.fetch;
  secrets?: readonly string[];
  stallMs?: number;
}): Tool[] {
  if (!settings.webSearch) return [];
  const searcher = webSearcher(settings.webSearch, {
    ...(settings.fetch ? { fetch: settings.fetch } : {}),
    ...(settings.secrets ? { secrets: settings.secrets } : {}),
    ...(settings.stallMs !== undefined ? { stallMs: settings.stallMs } : {}),
  });
  return [webSearchTool(searcher)];
}
