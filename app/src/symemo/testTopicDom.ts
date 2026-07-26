import * as path from "node:path";
import type {TopicDomNode, TopicDomParser} from "./topicDom";

interface Parse5Attribute {
    name: string;
    value: string;
}

interface Parse5Node {
    nodeName: string;
    tagName?: string;
    value?: string;
    data?: string;
    attrs?: Parse5Attribute[];
    childNodes?: Parse5Node[];
}

const htmlWebpackPlugin = require.resolve("html-webpack-plugin");
const parse5 = require(require.resolve("parse5", {paths: [path.dirname(htmlWebpackPlugin)]})) as {
    parse(html: string): Parse5Node;
};

const convertNode = (node: Parse5Node): TopicDomNode | undefined => {
    if (node.nodeName === "#text") {
        return {kind: "text", value: node.value ?? ""};
    }
    if (node.nodeName === "#comment") {
        return {kind: "comment", value: node.data ?? ""};
    }
    if (!node.tagName) {
        return undefined;
    }
    return {
        kind: "element",
        name: node.tagName.toLowerCase(),
        attributes: Object.fromEntries((node.attrs ?? []).map((attribute) => [attribute.name.toLowerCase(), attribute.value])),
        children: (node.childNodes ?? []).map(convertNode).filter((child): child is TopicDomNode => child !== undefined),
    };
};

const findBody = (node: Parse5Node): Parse5Node | undefined => {
    if (node.tagName === "body") return node;
    for (const child of node.childNodes ?? []) {
        const body = findBody(child);
        if (body) return body;
    }
    return undefined;
};

export const parse5TopicDom: TopicDomParser = {
    parse(html: string): TopicDomNode[] {
        const body = findBody(parse5.parse(html));
        return (body?.childNodes ?? []).map(convertNode).filter((node): node is TopicDomNode => node !== undefined);
    },
};
