import {after, before, describe, it} from "node:test";
import * as assert from "node:assert/strict";

class TestClassList {
    private readonly values = new Set<string>();

    public add(...tokens: string[]) {
        tokens.forEach((token) => this.values.add(token));
    }

    public remove(...tokens: string[]) {
        tokens.forEach((token) => this.values.delete(token));
    }

    public contains(token: string) {
        return this.values.has(token);
    }
}

class TestMathElement {
    public readonly classList = new TestClassList();
    public firstElementChild?: TestMathElement;
    public dangerousMarkupAssignments = 0;
    public innerHTMLAssignments = 0;
    public text = "";
    private html = "";
    private readonly attributes = new Map<string, string>();

    constructor(public readonly tagName: string) {}

    public get innerHTML() {
        return this.html;
    }

    public set innerHTML(value: string) {
        this.innerHTMLAssignments++;
        if (/<svg|onload=/i.test(value)) this.dangerousMarkupAssignments++;
        this.html = value;
    }

    public get textContent() {
        return this.text;
    }

    public set textContent(value: string) {
        this.text = value;
    }

    public getAttribute(name: string) {
        return this.attributes.get(name) ?? null;
    }

    public setAttribute(name: string, value: string) {
        this.attributes.set(name, value);
    }

    public querySelectorAll(): TestMathElement[] {
        return [];
    }
}

const stubPaths = [
    require.resolve("../util/addScript"),
    require.resolve("../util/addStyle"),
    require.resolve("../../constants"),
    require.resolve("../wysiwyg/getBlock"),
    require.resolve("../util/hasClosest"),
    require.resolve("../../util/functions"),
    require.resolve("./util"),
];
const originalModules = stubPaths.map((modulePath) => require.cache[modulePath]);
let mathRender: typeof import("./mathRender").mathRender;

before(async () => {
    require.cache[stubPaths[0]] = {exports: {addScript: async (): Promise<void> => undefined}} as NodeModule;
    require.cache[stubPaths[1]] = {exports: {addStyle() {}}} as NodeModule;
    require.cache[stubPaths[2]] = {exports: {Constants: {PROTYLE_CDN: "", ZWSP: "\u200b"}}} as NodeModule;
    require.cache[stubPaths[3]] = {exports: {
        hasNextSibling: (): undefined => undefined,
        hasPreviousSibling: (): boolean => false,
    }} as NodeModule;
    require.cache[stubPaths[4]] = {exports: {hasClosestBlock: (): undefined => undefined}} as NodeModule;
    require.cache[stubPaths[5]] = {exports: {looseJsonParse: () => ({})}} as NodeModule;
    require.cache[stubPaths[6]] = {exports: {
        genRenderFrame(element: TestMathElement) {
            const frame = new TestMathElement("DIV");
            frame.firstElementChild = new TestMathElement("DIV");
            element.firstElementChild = frame;
        },
    }} as NodeModule;

    const katex = require("../../../stage/protyle/js/katex/katex.min.js");
    (globalThis as unknown as {window: Window}).window = {
        siyuan: {config: {editor: {katexMacros: "{}"}}},
        katex,
    } as unknown as Window;
    (globalThis as unknown as {Lute: {UnEscapeHTMLStr(value: string | null): string}}).Lute = {
        UnEscapeHTMLStr: (value) => value || "",
    };
    ({mathRender} = await import("./mathRender"));
});

after(() => {
    stubPaths.forEach((modulePath, index) => {
        if (originalModules[index]) require.cache[modulePath] = originalModules[index];
        else delete require.cache[modulePath];
    });
});

const renderInvalidFormula = async (tagName: "DIV" | "SPAN") => {
    const payload = "\\badcommand{<svg/onload=1>}";
    const mathElement = new TestMathElement(tagName);
    mathElement.setAttribute("data-subtype", "math");
    mathElement.setAttribute("data-content", payload);
    const root = new TestMathElement("DIV");
    root.querySelectorAll = () => [mathElement];

    mathRender(root as unknown as Element);
    await new Promise<void>((resolve) => setImmediate(resolve));

    const errorTarget = tagName === "DIV"
        ? mathElement.firstElementChild?.firstElementChild
        : mathElement;
    assert.ok(errorTarget);
    assert.equal(errorTarget.innerHTMLAssignments, 0);
    assert.equal(errorTarget.dangerousMarkupAssignments, 0);
    assert.match(errorTarget.textContent, /<svg\/onload=1>/);
    assert.equal(errorTarget.classList.contains("ft__error"), true);
    assert.equal(mathElement.getAttribute("data-render"), "true");
};

describe("mathRender error sink", () => {
    it("renders an invalid inline formula error only as text", async () => {
        await renderInvalidFormula("SPAN");
    });

    it("renders an invalid block formula error only as text", async () => {
        await renderInvalidFormula("DIV");
    });
});
