// Copyright 2026 TradingAgents fork contributors
// SPDX-License-Identifier: Apache-2.0
// Added in this fork of TradingAgents 1.0.0.
/**
 * The XML reader on the shapes the fork reads (an SEC ownership document, OpenDART's corpCode.xml, a DART
 * report fragment), all hand-made in their documented forms, and on input no well-formed document has.
 */
import { describe, expect, test } from "bun:test";
import {
  child,
  children,
  find,
  findAll,
  parseXml,
  textOf,
  valueAt,
  type XmlElement,
} from "../../../src/fork/data/util/xml.js";

/** A Form 4 in SEC's ownership XML (hand-made, in the documented element names). */
const FORM4 = `<?xml version="1.0"?>
<ownershipDocument>
  <schemaVersion>X0508</schemaVersion>
  <documentType>4</documentType>
  <periodOfReport>2026-11-17</periodOfReport>
  <issuer>
    <issuerCik>0000320193</issuerCik>
    <issuerName>Apple Inc.</issuerName>
    <issuerTradingSymbol>AAPL</issuerTradingSymbol>
  </issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001214156</rptOwnerCik><rptOwnerName>Doe Jane</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship>
      <isDirector>0</isDirector><isOfficer>1</isOfficer><officerTitle>SVP &amp; CFO</officerTitle>
    </reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionDate><value>2026-11-17</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts>
        <transactionShares><value>1000</value></transactionShares>
        <transactionPricePerShare><value>341.25</value><footnoteId id="F1"/></transactionPricePerShare>
        <transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode>
      </transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>25000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle>
      <transactionCoding><transactionCode>M</transactionCode></transactionCoding>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
  <footnotes><footnote id="F1"><![CDATA[Weighted average price; prices ranged from $340.00 to $342.50 <inclusive>.]]></footnote></footnotes>
</ownershipDocument>`;

const NBSP = String.fromCharCode(0xa0);
const REPLACEMENT = String.fromCharCode(0xfffd);

describe("well-formed documents", () => {
  test("an ownership document: paths, values, repeated elements, attributes, references, CDATA", () => {
    const doc = parseXml(FORM4);
    const root = child(doc, "ownershipDocument") as XmlElement;
    expect(valueAt(root, "issuer/issuerCik")).toBe("0000320193");
    expect(valueAt(root, "reportingOwner/reportingOwnerRelationship/officerTitle")).toBe("SVP & CFO");
    const transactions = findAll(root, "nonDerivativeTransaction");
    expect(transactions).toHaveLength(2);
    expect(transactions.map((tx) => valueAt(tx, "transactionCoding/transactionCode"))).toEqual(["S", "M"]);
    expect(valueAt(transactions[0] as XmlElement, "transactionAmounts/transactionShares/value")).toBe("1000");
    expect(
      valueAt(transactions[1] as XmlElement, "transactionAmounts/transactionShares/value"),
    ).toBeUndefined();
    expect(
      find(transactions[0] as XmlElement, "transactionAmounts/transactionPricePerShare/footnoteId")
        ?.attributes,
    ).toEqual({
      id: "F1",
    });
    expect(valueAt(root, "footnotes/footnote")).toBe(
      "Weighted average price; prices ranged from $340.00 to $342.50 <inclusive>.",
    );
    expect(children(child(root, "issuer") as XmlElement).map((element) => element.name)).toEqual([
      "issuerCik",
      "issuerName",
      "issuerTradingSymbol",
    ]);
  });

  test("OpenDART's corpCode.xml list (hand-made, in its documented shape)", () => {
    const doc = parseXml(
      `<?xml version="1.0" encoding="UTF-8"?>\n<result>\n  <list>\n    <corp_code>00126380</corp_code>\n    <corp_name>삼성전자</corp_name>\n    <corp_eng_name>SAMSUNG ELECTRONICS CO,.LTD</corp_eng_name>\n    <stock_code>005930</stock_code>\n    <modify_date>20250101</modify_date>\n  </list>\n  <list>\n    <corp_code>00434003</corp_code>\n    <corp_name>다코</corp_name>\n    <stock_code> </stock_code>\n  </list>\n</result>`,
    );
    const rows = findAll(doc, "list").map((list) => ({
      code: valueAt(list, "corp_code"),
      name: valueAt(list, "corp_name"),
      stock: valueAt(list, "stock_code"),
    }));
    expect(rows).toEqual([
      { code: "00126380", name: "삼성전자", stock: "005930" },
      { code: "00434003", name: "다코", stock: undefined },
    ]);
  });

  test("namespaced names match by local name, prefixed queries exactly", () => {
    const doc = parseXml(
      `<ix:root xmlns:ix="x"><ix:nonNumeric name="a">One</ix:nonNumeric><b:nonNumeric>Two</b:nonNumeric></ix:root>`,
    );
    const root = child(doc, "root") as XmlElement;
    expect(children(root, "nonNumeric").map((element) => textOf(element))).toEqual(["One", "Two"]);
    expect(children(root, "ix:nonNumeric").map((element) => textOf(element))).toEqual(["One"]);
    expect(find(doc, "ix:root/ix:nonNumeric")?.attributes).toEqual({ name: "a" });
  });

  test("character references: numeric, named, unknown, impossible", () => {
    const doc = parseXml(
      "<a>&#65;&#x42;&lt;&gt;&amp;&quot;&apos;&nbsp;&bogus;&#0;&#xD800;&#x110000; &amp</a>",
    );
    expect(textOf(doc)).toBe(`AB<>&"'${NBSP}&bogus;${REPLACEMENT.repeat(3)} &amp`);
  });

  test("text between inline elements keeps its spaces; indentation is dropped", () => {
    const doc = parseXml("<p>\n  <b>bold</b> <i>italic</i>\n</p>");
    const p = child(doc, "p") as XmlElement;
    expect(p.children).toEqual([
      { name: "b", attributes: {}, children: ["bold"] },
      " ",
      { name: "i", attributes: {}, children: ["italic"] },
    ]);
  });
});

describe("what no well-formed document has, read without throwing", () => {
  test("unclosed elements close at the end; a stray end tag is ignored", () => {
    const doc = parseXml("<a><b>one<c>two</a></x>three");
    const a = child(doc, "a") as XmlElement;
    expect(textOf(a)).toBe("onetwo");
    expect(doc.children.at(-1)).toBe("three");
  });

  test("an end tag closes the elements left open inside it, matching case when it must", () => {
    const doc = parseXml(
      "<SECTION-1><TITLE>II. 사업의 내용<P>first<P>second</section-1><SECTION-2>next</SECTION-2>",
    );
    const sections = children(doc);
    expect(sections.map((section) => section.name)).toEqual(["SECTION-1", "SECTION-2"]);
    expect(textOf(sections[0])).toBe("II. 사업의 내용firstsecond");
  });

  test("attributes: unquoted, bare, single-quoted, unterminated, duplicated", () => {
    const doc = parseXml(`<t a=1 b c='two' d="3" a="again"/><u e="never closed>text</u>`);
    expect((child(doc, "t") as XmlElement).attributes).toEqual({ a: "1", b: "", c: "two", d: "3" });
    const u = child(doc, "u") as XmlElement;
    expect(u.attributes.e).toBe("never closed");
    expect(textOf(u)).toBe("text");
  });

  test("a < that starts no tag is text", () => {
    expect(textOf(parseXml("<a>1 < 2 and 3 <= 4</a>"))).toBe("1 < 2 and 3 <= 4");
    expect(textOf(parseXml("a <"))).toBe("a <");
  });

  test("comments, processing instructions and a DOCTYPE with an entity are skipped, not expanded", () => {
    const doc = parseXml(
      `<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;">]><!-- a > comment --><a>&lol2;<?pi data?></a>`,
    );
    expect(textOf(doc)).toBe("&lol2;");
  });

  test("unterminated comment, CDATA, declaration and tag read to the end", () => {
    expect(textOf(parseXml("<a>x<!-- never closed"))).toBe("x");
    expect(textOf(parseXml("<a><![CDATA[raw <b> & text"))).toBe("raw <b> & text");
    expect(textOf(parseXml("<a>x</a><!DOCTYPE never"))).toBe("x");
    const cut = parseXml("<a><b attr='x");
    expect(find(cut, "a/b")?.attributes).toEqual({ attr: "x" });
  });

  test("deep nesting is read without recursion", () => {
    const depth = 100_000;
    const doc = parseXml(`${"<d>".repeat(depth)}bottom${"</d>".repeat(depth)}`);
    expect(textOf(doc)).toBe("bottom");
    expect(findAll(doc, "d")).toHaveLength(depth);
  });

  test("a large flat document reads in time", () => {
    const rows = Array.from(
      { length: 50_000 },
      (_, i) => `<list><corp_code>${String(i).padStart(8, "0")}</corp_code></list>`,
    );
    const started = performance.now();
    const doc = parseXml(`<result>${rows.join("\n")}</result>`);
    expect(findAll(doc, "list")).toHaveLength(50_000);
    expect(performance.now() - started).toBeLessThan(5_000);
  });

  test("empty and whitespace input", () => {
    expect(parseXml("")).toEqual({ name: "#document", attributes: {}, children: [] });
    expect(parseXml("  \n ").children).toEqual([]);
    expect(valueAt(parseXml("<a> </a>"), "a")).toBeUndefined();
  });
});
