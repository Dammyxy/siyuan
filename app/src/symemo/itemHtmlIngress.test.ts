import {describe, it} from "node:test";
import * as assert from "node:assert/strict";
import {filterItemHTMLIngress} from "./itemHtmlIngress";
import {parse5TopicDom} from "./testTopicDom";

describe("Item HTML ingress", () => {
    it("keeps normalized local images while rejecting unsafe image sources", () => {
        const result = filterItemHTMLIngress(
            '<p><img src="assets/item.png"><img src="assets/folder/../escape.png"><img src="https://example.com/remote.png"><img src="data:image/png;base64,AAA"><img src="../escape.png"></p>',
            parse5TopicDom,
        );

        assert.equal(result,
            '<p><img src="assets/item.png"><img src="https://example.com/remote.png"></p>');
    });
});
