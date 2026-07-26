import * as assert from "node:assert/strict";
import test from "node:test";
import {
    createCanonicalFormulaHTML,
    htmlToPlainText,
    mapMarkdownFormulaHTML,
    normalizeTopicFormulaHTML,
    prepareFormulaRenderFrames,
} from "./topicFormula";
import {parse5TopicDom} from "./testTopicDom";

test("canonicalizes formula source and removes rendered descendants", () => {
    assert.equal(
        normalizeTopicFormulaHTML('<span class="katex" data-type="inline-math" data-subtype="math" data-content="E=mc^2"><em>rendered</em></span>', false, parse5TopicDom),
        '<span data-content="E=mc^2" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span>',
    );
    assert.equal(
        normalizeTopicFormulaHTML('<div class="render-node" data-type="NodeMathBlock" data-subtype="math" data-content="x&lt;y" data-symemo-node-id="20260725123100-hijklmn"><span>rendered</span></div>', false, parse5TopicDom),
        '<div data-content="x&lt;y" data-subtype="math" data-symemo-katex-trust="false" data-symemo-node-id="20260725123100-hijklmn" data-type="NodeMathBlock"></div>',
    );
});

test("maps only branded Markdown formula shapes to canonical source nodes", () => {
    assert.equal(
        mapMarkdownFormulaHTML({provenance: "siyuan-md2html", html: '<p id="LUTE_NODE_ID" updated="20260725123100">Inline <span class="language-math">x&amp;y</span> text.</p>\n'}, parse5TopicDom),
        '<p id="LUTE_NODE_ID" updated="20260725123100">Inline <span data-content="x&amp;y" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span> text.</p>\n',
    );
    assert.equal(
        mapMarkdownFormulaHTML({provenance: "siyuan-md2html", html: '<div class="language-math" id="LUTE_NODE_ID" updated="20260725123100">\\int_0^1 x\\,dx</div>\n'}, parse5TopicDom),
        '<div data-content="\\int_0^1 x\\,dx" data-subtype="math" data-symemo-katex-trust="false" data-type="NodeMathBlock"></div>\n',
    );
    assert.equal(
        mapMarkdownFormulaHTML({provenance: "siyuan-md2html", html: '<span class="language-math"><b>x</b></span>'}, parse5TopicDom),
        '<span class="language-math"><b>x</b></span>',
    );
});

test("never infers formula source from rendered descendants", () => {
    assert.equal(
        normalizeTopicFormulaHTML(
            '<p>before</p><span data-type="inline-math" data-subtype="math"><span class="katex">stolen</span></span><p>after</p>',
            false,
            parse5TopicDom,
        ),
        "<p>before</p><p>after</p>",
    );
});

test("requires the canonical formula subtype marker before promoting source attributes", () => {
    assert.equal(
        normalizeTopicFormulaHTML(
            '<span data-type="inline-math" data-content="x">not canonical</span>' +
            '<div data-type="NodeMathBlock" data-subtype="other" data-content="y">not canonical</div>',
            false,
            parse5TopicDom,
        ),
        '<span data-content="x" data-type="inline-math">not canonical</span>' +
        '<div data-content="y" data-subtype="other" data-type="NodeMathBlock">not canonical</div>',
    );
});

test("prepares one disposable frame for childless block formulas", () => {
    let appendCount = 0;
    const formula = {
        firstElementChild: null,
        ownerDocument: {createElement: () => ({tagName: "DIV"})},
        append() {
            appendCount++;
        },
    } as unknown as HTMLElement;
    const root = {
        querySelectorAll(selector: string): HTMLElement[] {
            assert.equal(selector, 'div[data-type="NodeMathBlock"][data-subtype="math"]');
            return [formula];
        },
    } as unknown as ParentNode;

    assert.equal(prepareFormulaRenderFrames(root), 1);
    assert.equal(appendCount, 1);
});

test("plain text export follows visible text and block boundaries", () => {
    assert.equal(htmlToPlainText("<p>Hello <strong>world</strong></p><p>x&amp;y</p>", parse5TopicDom), "Hello world\nx&y");
    assert.equal(
        createCanonicalFormulaHTML({kind: "block", content: "x", clientKey: "ck-1"}, true),
        '<div data-content="x" data-subtype="math" data-symemo-katex-trust="false" data-symemo-client-node-key="ck-1" data-type="NodeMathBlock"><div></div></div>',
    );
});
