import type {SiyuanMarkdownHTMLFragment} from "./types";
import {
    browserTopicDomParser,
    serializeTopicDomNodes,
    TopicDomElement,
    TopicDomNode,
    TopicDomParser,
    topicDomTextContent,
} from "./topicDom";

export type TopicFormulaKind = "inline" | "block";

export interface TopicFormulaSource {
    kind: TopicFormulaKind;
    content: string;
    nodeId?: string;
    clientKey?: string;
}

const FORMULA_FRAME_HTML = "<div></div>";
const UNSAFE_FORMULA_COMMAND = /\\(?:catcode|csname|def|edef|endcsname|expandafter|futurelet|gdef|global|href|includegraphics|let|long|newcommand|noexpand|providecommand|renewcommand|url|xdef)\b/i;

const escapeAttribute = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

export const createCanonicalFormulaHTML = (source: TopicFormulaSource, includeRenderFrame = false): string => {
    const content = escapeAttribute(source.content);
    if (source.kind === "inline") {
        return `<span data-content="${content}" data-subtype="math" data-symemo-katex-trust="false" data-type="inline-math"></span>`;
    }

    const identity = source.nodeId
        ? ` data-symemo-node-id="${escapeAttribute(source.nodeId)}"`
        : source.clientKey
            ? ` data-symemo-client-node-key="${escapeAttribute(source.clientKey)}"`
            : "";
    const frame = includeRenderFrame ? FORMULA_FRAME_HTML : "";
    return `<div data-content="${content}" data-subtype="math" data-symemo-katex-trust="false"${identity} data-type="NodeMathBlock">${frame}</div>`;
};

const formulaKind = (element: TopicDomElement): TopicFormulaKind | undefined => {
    if (element.attributes["data-subtype"] !== "math") return undefined;
    if (element.name === "span" && element.attributes["data-type"] === "inline-math") return "inline";
    if (element.name === "div" && element.attributes["data-type"] === "NodeMathBlock") return "block";
    return undefined;
};

export const isTopicFormulaElement = (node: TopicDomNode | undefined): boolean =>
    node?.kind === "element" && formulaKind(node) !== undefined;

const normalizeFormulaNode = (node: TopicDomNode, includeRenderFrame: boolean): TopicDomNode[] => {
    if (node.kind !== "element") return [node.kind === "text" ? {...node} : {...node}];
    const kind = formulaKind(node);
    if (!kind) {
        return [{
            kind: "element",
            name: node.name,
            attributes: {...node.attributes},
            children: node.children.flatMap((child) => normalizeFormulaNode(child, includeRenderFrame)),
        }];
    }

    const content = node.attributes["data-content"];
    if (!content || UNSAFE_FORMULA_COMMAND.test(content)) return [];
    const attributes: Record<string, string> = {
        "data-content": content,
        "data-subtype": "math",
        "data-symemo-katex-trust": "false",
        "data-type": kind === "inline" ? "inline-math" : "NodeMathBlock",
    };
    if (kind === "block") {
        const nodeId = node.attributes["data-symemo-node-id"];
        const clientKey = node.attributes["data-symemo-client-node-key"];
        if (nodeId) attributes["data-symemo-node-id"] = nodeId;
        else if (clientKey) attributes["data-symemo-client-node-key"] = clientKey;
    }
    return [{
        kind: "element",
        name: kind === "inline" ? "span" : "div",
        attributes,
        children: kind === "block" && includeRenderFrame
            ? [{kind: "element", name: "div", attributes: {}, children: []}]
            : [],
    }];
};

export const normalizeTopicFormulaNodes = (nodes: readonly TopicDomNode[], includeRenderFrame = false): TopicDomNode[] =>
    nodes.flatMap((node) => normalizeFormulaNode(node, includeRenderFrame));

export const normalizeTopicFormulaHTML = (
    html: string,
    includeRenderFrame = false,
    parser: TopicDomParser = browserTopicDomParser,
): string => serializeTopicDomNodes(normalizeTopicFormulaNodes(parser.parse(html), includeRenderFrame));

const hasExactMarkdownFormulaClass = (element: TopicDomElement): boolean =>
    Object.keys(element.attributes).every((name) => name === "class" || (element.name === "div" && (name === "id" || name === "updated"))) &&
    element.attributes.class === "language-math";

const mapMarkdownFormulaNode = (node: TopicDomNode): TopicDomNode => {
    if (node.kind !== "element") return {...node};
    if ((node.name === "span" || node.name === "div") && hasExactMarkdownFormulaClass(node) &&
        node.children.every((child) => child.kind === "text")) {
        const kind: TopicFormulaKind = node.name === "span" ? "inline" : "block";
        const content = node.children.map(topicDomTextContent).join("");
        return {
            kind: "element",
            name: node.name,
            attributes: {
                "data-content": content,
                "data-subtype": "math",
                "data-symemo-katex-trust": "false",
                "data-type": kind === "inline" ? "inline-math" : "NodeMathBlock",
            },
            children: [],
        };
    }
    return {
        kind: "element",
        name: node.name,
        attributes: {...node.attributes},
        children: node.children.map(mapMarkdownFormulaNode),
    };
};

export const mapMarkdownFormulaHTML = (
    fragment: SiyuanMarkdownHTMLFragment,
    parser: TopicDomParser = browserTopicDomParser,
): string => serializeTopicDomNodes(parser.parse(fragment.html).map(mapMarkdownFormulaNode));

const BLOCK_TEXT_ELEMENTS = new Set(["p", "div", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr"]);

const appendPlainText = (node: TopicDomNode, output: string[]): void => {
    if (node.kind === "text") {
        output.push(node.value);
        return;
    }
    if (node.kind === "comment") return;
    if (node.name === "br") {
        output.push("\n");
        return;
    }
    node.children.forEach((child) => appendPlainText(child, output));
    if (BLOCK_TEXT_ELEMENTS.has(node.name)) output.push("\n");
};

export const htmlToPlainText = (html: string, parser: TopicDomParser = browserTopicDomParser): string => {
    const output: string[] = [];
    parser.parse(html).forEach((node) => appendPlainText(node, output));
    return output.join("").replace(/\n{3,}/g, "\n\n").trim();
};

export const prepareFormulaRenderFrames = (root: ParentNode): number => {
    if (typeof root.querySelectorAll !== "function") return 0;
    let added = 0;
    root.querySelectorAll<HTMLElement>('div[data-type="NodeMathBlock"][data-subtype="math"]').forEach((formula) => {
        if (!formula.firstElementChild) {
            formula.append(formula.ownerDocument.createElement("div"));
            added++;
        }
    });
    return added;
};
