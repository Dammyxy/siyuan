import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {filterTopicHTMLIngress} from "./topicHtmlIngress";
import {parse5TopicDom} from "./testTopicDom";

describe("Topic HTML ingress filtering", () => {
    it("drops executable subtrees and unsafe identity/resource attributes before editor insertion", () => {
        assert.equal(
            filterTopicHTMLIngress(
                "<script>alert(1)</script><p onclick=\"x()\" data-symemo-node-id=\"foreign\" " +
                "data-private=\"x\">Safe <strong>text</strong></p>" +
                "<img src=\"file:///tmp/local.png\" alt=\"local\"><img src=\"https://example.com/ok.png\" " +
                "srcset=\"bad\" onerror=\"x()\">",
                parse5TopicDom,
            ),
            "<p>Safe <strong>text</strong></p><img src=\"https://example.com/ok.png\">",
        );
    });

    it("retains safe links, table spans, and canonical formula source while unwrapping unknown containers", () => {
        assert.equal(
            filterTopicHTMLIngress(
                "<section><a href=\"javascript:alert(1)\">bad</a><a href=\"https://example.com/#x\" title=\"ok\">ok</a>" +
                "<table><tbody><tr><td colspan=\"2\" rowspan=\"3\" style=\"color: red; background-image: url(x)\">cell</td></tr></tbody></table>" +
                "<span data-type=\"inline-math\" data-subtype=\"math\" data-content=\"x^2\" " +
                "data-render=\"katex\"></span></section>",
                parse5TopicDom,
            ),
            "<a>bad</a><a href=\"https://example.com/#x\" title=\"ok\">ok</a>" +
            "<table><tbody><tr><td colspan=\"2\" rowspan=\"3\" style=\"color: red\">cell</td></tr></tbody></table>" +
            "<span data-content=\"x^2\" data-subtype=\"math\" data-symemo-katex-trust=\"false\" data-type=\"inline-math\"></span>",
        );
    });

    it("returns an empty fragment when HTML is missing or fully rejected", () => {
        assert.equal(filterTopicHTMLIngress("", parse5TopicDom), "");
        assert.equal(filterTopicHTMLIngress("<iframe src=\"https://example.com\"></iframe><img src=\"data:image/png;base64,abc\">", parse5TopicDom), "");
    });

    it("uses inert DOM parsing for quoted tag delimiters and backend-v1 attributes", () => {
        assert.equal(
            filterTopicHTMLIngress(
                "<p title=\"1 > 0\" id=\"safe\" data-symemo-node-id=\"foreign\">A</p>" +
                "<script data-x=\">\"><p>bad</p></script>" +
                "<span>plain wrapper</span><div>block wrapper</div>" +
                "<img title=\"remote\" alt=\"diagram\" src=\"https://example.com/a.png\">",
                parse5TopicDom,
            ),
            "<p id=\"safe\">A</p>plain wrapperblock wrapper" +
            "<img alt=\"diagram\" src=\"https://example.com/a.png\" title=\"remote\">",
        );
    });

    it("cannot leak descendants from malformed raw-text or embedded-content subtrees", () => {
        for (const html of [
            '<script><img src="https://attacker.example/track.png">',
            "<style><p>leaked style text</p>",
            '<iframe><img src="https://attacker.example/frame.png">',
        ]) {
            assert.equal(filterTopicHTMLIngress(html, parse5TopicDom), "");
        }
    });

    it("matches backend-v1 scalar attributes and preserves safe author styles", () => {
        assert.equal(
            filterTopicHTMLIngress(
                '<ol start="2" reversed><li id="item" style="font-weight: 700; color: rgb(1, 2, 3); position: fixed">A</li></ol>' +
                '<table><tbody><tr><th scope="col" colspan="0" rowspan="12">H</th></tr></tbody></table>',
                parse5TopicDom,
            ),
            '<ol reversed="" start="2"><li id="item" style="color: rgb(1, 2, 3); font-weight: 700">A</li></ol>' +
            '<table><tbody><tr><th rowspan="12" scope="col">H</th></tr></tbody></table>',
        );
    });
});
