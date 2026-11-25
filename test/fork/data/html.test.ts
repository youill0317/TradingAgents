// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * HTML as text, on hand-made pages in the forms filings take (an inline-XBRL 10-K's head and Items, tables
 * of figures, a DART report's tags), and on markup no browser would refuse.
 */
import { describe, expect, test } from "bun:test";
import { htmlToText } from "../../../src/fork/data/util/html.js";

const NBSP = String.fromCharCode(0xa0);

describe("pages as filings write them", () => {
  test("an inline-XBRL 10-K: its hidden header, scripts and styles left out, its Items as paragraphs", () => {
    const page = `<!DOCTYPE html><html><head><title>aapl-20260926</title><style>p { margin: 0 }</style></head>
<body><div style="display:none"><ix:header><ix:hidden><ix:nonNumeric name="dei:DocumentType">10-K</ix:nonNumeric></ix:hidden>
<ix:resources><xbrli:context id="c-1"><xbrli:entity>0000320193</xbrli:entity></xbrli:context></ix:resources></ix:header></div>
<script type="text/javascript">var hidden = "<p>not text</p>";</script>
<p style="font-weight:bold">PART&#160;I</p>
<p><span>Item 1.</span><span>&#160;&#160;&#160;&#160;Business</span></p>
<p>The Company designs, manufactures and markets smartphones,
   personal computers, tablets, wearables and accessories.</p>
<div><span>Item 1A.&nbsp;Risk Factors</span></div>
<p>The Company&#8217;s business can be affected by <ix:nonNumeric name="x">many</ix:nonNumeric> factors.</p>
</body></html>`;
    expect(htmlToText(page)).toBe(
      [
        "PART I",
        "",
        "Item 1. Business",
        "",
        "The Company designs, manufactures and markets smartphones, personal computers, tablets, wearables and accessories.",
        "",
        "Item 1A. Risk Factors",
        "",
        "The Company’s business can be affected by many factors.",
      ].join("\n"),
    );
  });

  test("a table of figures: a row a line, its cells separated by tabs", () => {
    const page = `<p>Net sales by category:</p>
<table><tr><th>Category</th><th>2026</th><th>2025</th></tr>
<tr><td>iPhone</td><td>$<span>&#160;</span>209,586</td><td>201,183</td></tr>
<tr><td><p>Services</p></td><td>109,158</td><td>96,169</td><td></td></tr>
<tr><td></td><td></td></tr>
</table><p>After the table.</p>`;
    expect(htmlToText(page)).toBe(
      [
        "Net sales by category:",
        "",
        "Category\t2026\t2025",
        "iPhone\t$ 209,586\t201,183",
        "Services\t109,158\t96,169",
        "",
        "After the table.",
      ].join("\n"),
    );
  });

  test("a DART report's tags: sections and titles as paragraphs, TE and TU as cells", () => {
    const report = `<SECTION-1 ACLASS="MANDATORY"><TITLE ATOC="Y" AASSOCNOTE="D-0-2-0-0">II. 사업의 내용</TITLE>
<P>당사는 본사를 거점으로 한국과 DX 부문 산하 해외 9개 지역총괄을 두고 있습니다.</P>
<TABLE><TR><TE>구분</TE><TE>매출액</TE></TR><TR><TU>DX 부문</TU><TD>174조</TD></TR></TABLE></SECTION-1>`;
    expect(htmlToText(report)).toBe(
      [
        "II. 사업의 내용",
        "",
        "당사는 본사를 거점으로 한국과 DX 부문 산하 해외 9개 지역총괄을 두고 있습니다.",
        "",
        "구분\t매출액",
        "DX 부문\t174조",
      ].join("\n"),
    );
  });

  test("pre keeps its spacing; br breaks a line; lists put each item on its own", () => {
    expect(htmlToText("<pre>  a   b\n\tc</pre><p>x<br>y<br/>z</p><ul><li>one</li><li>two</li></ul>")).toBe(
      ["  a   b", "\tc", "", "x", "y", "z", "", "one", "two"].join("\n"),
    );
  });

  test("a table inside a cell stays on the cell's line", () => {
    expect(
      htmlToText(
        "<table><tr><td>outer</td><td><table><tr><td>a</td><td>b</td></tr><tr><td>c</td></tr></table></td></tr></table>",
      ),
    ).toBe("outer\ta b; c");
  });

  test("references: named, numeric, a no-break space read as a space, unknown kept", () => {
    expect(htmlToText(`<p>&copy; 2026 &mdash; R&amp;D&nbsp;costs &#36;5 &bogus; &#x1F600;</p>`)).toBe(
      "© 2026 — R&D costs $5 &bogus; \u{1F600}",
    );
    expect(htmlToText(`<p>a${NBSP}${NBSP}b</p>`)).toBe("a b");
  });
});

describe("markup no browser refuses", () => {
  test("unclosed tags, stray end tags, upper case, attributes with > inside quotes", () => {
    expect(htmlToText(`<DIV CLASS="a>b">One<P>Two</SPAN></div>Three<p title='x > y'>Four`)).toBe(
      ["One", "", "Two", "Three", "", "Four"].join("\n"),
    );
  });

  test("a < that starts no tag, and a tag cut off at the end", () => {
    expect(htmlToText("<p>1 < 2 and x<3</p><p>end <a href=")).toBe(["1 < 2 and x<3", "", "end"].join("\n"));
  });

  test("a script or style never closed hides the rest; one closed in upper case ends there", () => {
    expect(htmlToText("<p>before</p><script>while (a < b) {}")).toBe("before");
    expect(htmlToText("<p>before</p><SCRIPT>x</SCRIPT ><p>after</p><style>p{}</style><p>end</p>")).toBe(
      ["before", "", "after", "", "end"].join("\n"),
    );
    expect(htmlToText("<script>a</scripts><p>hidden</p></script><p>shown</p>")).toBe("shown");
  });

  test("comments and declarations, closed or not", () => {
    expect(htmlToText("<!-- <p>no</p> --><?xml x?><p>yes</p><!-- open")).toBe("yes");
  });

  test("empty and whitespace-only pages", () => {
    expect(htmlToText("")).toBe("");
    expect(htmlToText(" \n\t ")).toBe("");
    expect(htmlToText("<p> </p><div>\n</div>")).toBe("");
  });

  test("deep nesting and long pages read in time, without recursion", () => {
    const depth = 50_000;
    expect(htmlToText(`${"<div><span>".repeat(depth)}deep${"</span></div>".repeat(depth)}`)).toBe("deep");
    const page = Array.from({ length: 20_000 }, (_, i) => `<tr><td>row ${i}</td><td>${i * 2}</td></tr>`).join(
      "",
    );
    const started = performance.now();
    const text = htmlToText(`<table>${page}</table>`);
    expect(text.split("\n")).toHaveLength(20_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });
});
