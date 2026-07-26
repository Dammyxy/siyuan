export interface TopicDomText {
    kind: "text";
    value: string;
}

export interface TopicDomComment {
    kind: "comment";
    value: string;
}

export interface TopicDomElement {
    kind: "element";
    name: string;
    attributes: Record<string, string>;
    children: TopicDomNode[];
}

export type TopicDomNode = TopicDomText | TopicDomComment | TopicDomElement;

export interface TopicDomParser {
    parse(html: string): TopicDomNode[];
}

const VOID_ELEMENTS = new Set(["br", "hr", "img"]);

const fromDOMNode = (node: Node): TopicDomNode | undefined => {
    if (node.nodeType === 3) {
        return {kind: "text", value: node.nodeValue ?? ""};
    }
    if (node.nodeType === 8) {
        return {kind: "comment", value: node.nodeValue ?? ""};
    }
    if (node.nodeType !== 1) {
        return undefined;
    }
    const element = node as Element;
    return {
        kind: "element",
        name: element.tagName.toLowerCase(),
        attributes: Object.fromEntries(Array.from(element.attributes, (attribute) => [attribute.name.toLowerCase(), attribute.value])),
        children: Array.from(element.childNodes).map(fromDOMNode).filter((child): child is TopicDomNode => child !== undefined),
    };
};

export const browserTopicDomParser: TopicDomParser = {
    parse(html: string): TopicDomNode[] {
        if (typeof DOMParser === "undefined") {
            throw new Error("DOMParser is unavailable");
        }
        const document = new DOMParser().parseFromString(html, "text/html");
        return Array.from(document.body.childNodes).map(fromDOMNode).filter((node): node is TopicDomNode => node !== undefined);
    },
};

export const topicDomNodesFromParent = (parent: ParentNode): TopicDomNode[] =>
    Array.from(parent.childNodes).map(fromDOMNode).filter((node): node is TopicDomNode => node !== undefined);

export const cloneTopicDomNode = (node: TopicDomNode): TopicDomNode => {
    if (node.kind !== "element") return {...node};
    return {
        kind: "element",
        name: node.name,
        attributes: {...node.attributes},
        children: node.children.map(cloneTopicDomNode),
    };
};

export const cloneTopicDomNodes = (nodes: readonly TopicDomNode[]): TopicDomNode[] => nodes.map(cloneTopicDomNode);

const escapeText = (value: string): string => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const escapeAttribute = (value: string): string => escapeText(value).replace(/"/g, "&quot;");

export const serializeTopicDomNode = (node: TopicDomNode): string => {
    if (node.kind === "text") return escapeText(node.value);
    if (node.kind === "comment") return "";
    const attributes = Object.entries(node.attributes)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => ` ${name}="${escapeAttribute(value)}"`)
        .join("");
    if (VOID_ELEMENTS.has(node.name)) return `<${node.name}${attributes}>`;
    return `<${node.name}${attributes}>${serializeTopicDomNodes(node.children)}</${node.name}>`;
};

export const serializeTopicDomNodes = (nodes: readonly TopicDomNode[]): string => nodes.map(serializeTopicDomNode).join("");

export const topicDomTextContent = (node: TopicDomNode): string => {
    if (node.kind === "text") return node.value;
    if (node.kind === "comment") return "";
    return node.children.map(topicDomTextContent).join("");
};

export const walkTopicDomElements = (nodes: readonly TopicDomNode[], visitor: (element: TopicDomElement) => void): void => {
    for (const node of nodes) {
        if (node.kind !== "element") continue;
        visitor(node);
        walkTopicDomElements(node.children, visitor);
    }
};
