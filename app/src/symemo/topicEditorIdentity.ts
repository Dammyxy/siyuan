import {isTopicFormulaElement, normalizeTopicFormulaNodes} from "./topicFormula";
import {
    browserTopicDomParser,
    cloneTopicDomNodes,
    serializeTopicDomNodes,
    TopicDomElement,
    TopicDomNode,
    TopicDomParser,
    walkTopicDomElements,
} from "./topicDom";

export const SYMEMO_NODE_ID_ATTR = "data-symemo-node-id";
export const SYMEMO_CLIENT_KEY_ATTR = "data-symemo-client-node-key";

export type ClientKeyFactory = () => string;

export class TopicEditorIdentityError extends Error {}

export interface TopicEditorIdentityOptions {
    createClientKey?: ClientKeyFactory;
    retiredNodeIds?: ReadonlySet<string>;
    retiredClientKeys?: ReadonlySet<string>;
}

export interface AcceptedIdentityAdoption {
    html: string;
    adoptedCount: number;
}

const ADDRESSABLE_TAGS = new Set([
    "blockquote", "div", "figure", "h1", "h2", "h3", "h4", "h5", "h6", "hr", "li", "p", "pre", "td", "th",
]);

const EMPTY_INTENT_WRAPPERS = new Set(["p", "div"]);
const EMPTY_TEXT = /^[\s\u00a0\u200b\ufeff]*$/u;
const DISPOSABLE_FORMULA_ADJACENT_TEXT = /^[\n\u200b\ufeff]*$/u;

const defaultClientKeyFactory = (): ClientKeyFactory => {
    const timestamp = (() => {
        if (typeof Lute !== "undefined") {
            const nodeId = Lute.NewNodeID();
            if (/^\d{14}-/.test(nodeId)) return nodeId.slice(0, 14);
        }
        return new Date().toISOString().replace(/\D/g, "").slice(0, 14).padEnd(14, "0");
    })();
    return () => {
        const random = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))))
            .replace(/\+/g, "-")
            .replace(/\//g, "_")
            .replace(/=+$/g, "");
        return `client-v1-${timestamp}-${random}`;
    };
};

const isAddressable = (element: TopicDomElement): boolean =>
    ADDRESSABLE_TAGS.has(element.name) && (element.name !== "div" || isTopicFormulaElement(element));

const repairIdentityNodes = (nodes: readonly TopicDomNode[], options: TopicEditorIdentityOptions): TopicDomNode[] => {
    const output = cloneTopicDomNodes(nodes);
    const createClientKey = options.createClientKey ?? defaultClientKeyFactory();
    const seenNodeIds = new Set<string>();
    const seenClientKeys = new Set<string>();

    walkTopicDomElements(output, (element) => {
        if (!isAddressable(element)) return;
        const nodeId = element.attributes[SYMEMO_NODE_ID_ATTR]?.trim();
        const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR]?.trim();
        const nodeIdValid = Boolean(nodeId) && !options.retiredNodeIds?.has(nodeId!) && !seenNodeIds.has(nodeId!);

        if (nodeIdValid) {
            seenNodeIds.add(nodeId!);
            element.attributes[SYMEMO_NODE_ID_ATTR] = nodeId!;
            delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
            return;
        }

        delete element.attributes[SYMEMO_NODE_ID_ATTR];
        const clientKeyValid = Boolean(clientKey) && !nodeId && !options.retiredClientKeys?.has(clientKey!) && !seenClientKeys.has(clientKey!);
        if (clientKeyValid) {
            seenClientKeys.add(clientKey!);
            element.attributes[SYMEMO_CLIENT_KEY_ATTR] = clientKey!;
            return;
        }

        delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
        let nextKey = "";
        for (let attempt = 0; attempt < 32; attempt++) {
            const candidate = createClientKey();
            if (!seenClientKeys.has(candidate) && !options.retiredClientKeys?.has(candidate)) {
                nextKey = candidate;
                break;
            }
        }
        if (!nextKey) throw new TopicEditorIdentityError("client identity is unavailable");
        seenClientKeys.add(nextKey);
        element.attributes[SYMEMO_CLIENT_KEY_ATTR] = nextKey;
    });
    return output;
};

export const repairTopicEditorIdentity = (
    html: string,
    options: TopicEditorIdentityOptions = {},
    parser: TopicDomParser = browserTopicDomParser,
): string => serializeTopicDomNodes(repairIdentityNodes(parser.parse(html), options));

export const collectAcceptedIdentityByClientKey = (
    acceptedHTML: string,
    parser: TopicDomParser = browserTopicDomParser,
): Map<string, string> => {
    const identities = new Map<string, string>();
    walkTopicDomElements(parser.parse(acceptedHTML), (element) => {
        const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR];
        const nodeId = element.attributes[SYMEMO_NODE_ID_ATTR];
        if (clientKey && nodeId && !identities.has(clientKey)) identities.set(clientKey, nodeId);
    });
    return identities;
};

export const adoptAcceptedIdentities = (
    localHTML: string,
    acceptedHTML: string,
    parser: TopicDomParser = browserTopicDomParser,
): AcceptedIdentityAdoption => {
    const identities = collectAcceptedIdentityByClientKey(acceptedHTML, parser);
    const nodes = parser.parse(localHTML);
    let adoptedCount = 0;
    walkTopicDomElements(nodes, (element) => {
        const clientKey = element.attributes[SYMEMO_CLIENT_KEY_ATTR];
        const nodeId = clientKey ? identities.get(clientKey) : undefined;
        if (!nodeId) return;
        element.attributes[SYMEMO_NODE_ID_ATTR] = nodeId;
        delete element.attributes[SYMEMO_CLIENT_KEY_ATTR];
        adoptedCount++;
    });
    return {html: serializeTopicDomNodes(nodes), adoptedCount};
};

const stripEditorNode = (node: TopicDomNode, stripStableIdentity: boolean, stripClientKeys: boolean): TopicDomNode[] => {
    if (node.kind === "comment") return [];
    if (node.kind === "text") return [{...node}];
    const attributes = Object.fromEntries(Object.entries(node.attributes).filter(([name]) => {
        if (name.startsWith("data-mce-") || name === "contenteditable" || name === "data-render" ||
            name === "draggable" || name === "spellcheck" || name === "class") {
            return false;
        }
        if (stripStableIdentity && name === SYMEMO_NODE_ID_ATTR) return false;
        if (stripClientKeys && name === SYMEMO_CLIENT_KEY_ATTR) return false;
        return true;
    }));
    return [{
        kind: "element",
        name: node.name,
        attributes,
        children: node.children.flatMap((child) => stripEditorNode(child, stripStableIdentity, stripClientKeys)),
    }];
};

const removeDisposableFormulaText = (nodes: TopicDomNode[]): TopicDomNode[] => nodes.filter((node, index) => {
    if (node.kind !== "text" || !DISPOSABLE_FORMULA_ADJACENT_TEXT.test(node.value)) return true;
    return !isTopicFormulaElement(nodes[index - 1]) && !isTopicFormulaElement(nodes[index + 1]);
}).map((node) => {
    if (node.kind !== "element") return node;
    return {...node, children: removeDisposableFormulaText(node.children)};
});

const isEmptyIntent = (node: TopicDomNode): boolean => {
    if (node.kind === "comment") return true;
    if (node.kind === "text") return EMPTY_TEXT.test(node.value);
    if (isTopicFormulaElement(node)) return false;
    if (!EMPTY_INTENT_WRAPPERS.has(node.name)) return false;
    return node.children.every((child) => child.kind === "element" && child.name === "br" || isEmptyIntent(child));
};

export const stripTopicEditorNodes = (
    nodes: readonly TopicDomNode[],
    stripStableIdentity = false,
    stripClientKeys = true,
): TopicDomNode[] => {
    const stripped = nodes.flatMap((node) => stripEditorNode(node, stripStableIdentity, stripClientKeys));
    const formulas = normalizeTopicFormulaNodes(stripped);
    const withoutFormulaText = removeDisposableFormulaText(formulas);
    return withoutFormulaText.every(isEmptyIntent) ? [] : withoutFormulaText;
};

export const stripEditorMetadata = (
    html: string,
    stripStableIdentity = false,
    stripClientKeys = true,
    parser: TopicDomParser = browserTopicDomParser,
): string => serializeTopicDomNodes(stripTopicEditorNodes(parser.parse(html), stripStableIdentity, stripClientKeys));

export const serializeTopicEditorHTML = (
    html: string,
    options: TopicEditorIdentityOptions & {stripStableIdentity?: boolean} = {},
    parser: TopicDomParser = browserTopicDomParser,
): string => {
    const repaired = repairIdentityNodes(parser.parse(html), options);
    return serializeTopicDomNodes(stripTopicEditorNodes(repaired, options.stripStableIdentity, false)).trim();
};

export const serializeTopicEditorNodes = (
    nodes: readonly TopicDomNode[],
    options: TopicEditorIdentityOptions & {stripStableIdentity?: boolean} = {},
): string => {
    const repaired = repairIdentityNodes(nodes, options);
    return serializeTopicDomNodes(stripTopicEditorNodes(repaired, options.stripStableIdentity, false)).trim();
};
