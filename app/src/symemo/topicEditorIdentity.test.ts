import * as assert from "node:assert/strict";
import test from "node:test";
import {
    adoptAcceptedIdentities,
    repairTopicEditorIdentity,
    serializeTopicEditorHTML,
    stripEditorMetadata,
} from "./topicEditorIdentity";
import {parse5TopicDom} from "./testTopicDom";

const keyFactory = (keys: string[]) => () => {
    const key = keys.shift();
    if (!key) throw new Error("missing test key");
    return key;
};

test("assigns client keys and repairs duplicate or retired stable identity", () => {
    const html = [
        '<p data-symemo-node-id="stable-1">A</p>',
        '<p data-symemo-node-id="stable-1">B</p>',
        '<p data-symemo-client-node-key="retired">C</p>',
        "<p>D</p>",
    ].join("");
    assert.equal(
        repairTopicEditorIdentity(html, {
            createClientKey: keyFactory(["ck-2", "ck-3", "ck-4"]),
            retiredClientKeys: new Set(["retired"]),
        }, parse5TopicDom),
        [
            '<p data-symemo-node-id="stable-1">A</p>',
            '<p data-symemo-client-node-key="ck-2">B</p>',
            '<p data-symemo-client-node-key="ck-3">C</p>',
            '<p data-symemo-client-node-key="ck-4">D</p>',
        ].join(""),
    );
});

test("adopts backend stable IDs by client key without replacing newer HTML", () => {
    const local = '<p data-symemo-client-node-key="ck-1">newer local text</p>';
    const accepted = '<p data-symemo-client-node-key="ck-1" data-symemo-node-id="stable-2">old text</p>';
    assert.deepEqual(adoptAcceptedIdentities(local, accepted, parse5TopicDom), {
        adoptedCount: 1,
        html: '<p data-symemo-node-id="stable-2">newer local text</p>',
    });
});

test("export serialization strips editor metadata, client keys, rendered formulas, and optional stable IDs", () => {
    const html = '<p data-mce-bogus="1" data-symemo-client-node-key="ck" data-symemo-node-id="stable" contenteditable="true" style="color:red">A</p>' +
        '<span class="katex" data-type="inline-math" data-subtype="math" data-content="x"><span>rendered</span></span>';
    assert.equal(
        stripEditorMetadata(html, true, true, parse5TopicDom),
        '<p style="color:red">A</p><span data-content="x" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span>',
    );
    assert.equal(
        serializeTopicEditorHTML("<p>Needs key</p>", {createClientKey: keyFactory(["ck-1"])}, parse5TopicDom),
        '<p data-symemo-client-node-key="ck-1">Needs key</p>',
    );
});

test("handles disposable boundary text without reading outside the DOM fragment", () => {
    assert.equal(
        stripEditorMetadata("\n<p>A</p>\n", true, true, parse5TopicDom),
        "<p>A</p>\n",
    );
});

test("default client keys match backend edit identity contract and skip container-only nodes", () => {
    const html = serializeTopicEditorHTML("<h2>Heading</h2><ul><li>Item</li></ul><table><tbody><tr><td>Cell</td></tr></tbody></table><p><img src=\"https://example.com/a.png\"></p>", {}, parse5TopicDom);
    const keys = [...html.matchAll(/data-symemo-client-node-key="([^"]+)"/g)].map((match) => match[1]);
    assert.equal(keys.length, 4);
    assert.ok(keys.every((key) => /^client-v1-\d{14}-[A-Za-z0-9_-]{22,}$/.test(key)));
    assert.doesNotMatch(html, /<ul[^>]*data-symemo-client-node-key/);
    assert.doesNotMatch(html, /<table[^>]*data-symemo-client-node-key/);
    assert.doesNotMatch(html, /<img[^>]*data-symemo-client-node-key/);
});

test("keeps exactly one identity and preserves author style during DOM traversal", () => {
    assert.equal(
        repairTopicEditorIdentity(
            '<p style="color: red" data-symemo-node-id="stable-1" data-symemo-client-node-key="ck-old">A</p>',
            {createClientKey: keyFactory(["unused"])},
            parse5TopicDom,
        ),
        '<p data-symemo-node-id="stable-1" style="color: red">A</p>',
    );
});

test("treats valid block formula source as meaningful canonical material", () => {
    assert.equal(
        stripEditorMetadata(
            '<div data-type="NodeMathBlock" data-subtype="math" data-content="x"></div>',
            false,
            true,
            parse5TopicDom,
        ),
        '<div data-content="x" data-subtype="math" data-symemo-katex-trust="false" data-type="NodeMathBlock"></div>',
    );
});
