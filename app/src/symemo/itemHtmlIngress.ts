import {
    browserTopicDomParser,
    serializeTopicDomNodes,
    TopicDomNode,
    TopicDomParser,
} from "./topicDom";
import {filterTopicHTMLIngress} from "./topicHtmlIngress";

const LOCAL_ASSET_SENTINEL = "https://siyuan.local/__symemo_asset__/";

const tokenNamespace = (): string => {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
        return crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const normalizeLocalAssetReference = (value: string): string => {
    if (!value.startsWith("assets/") || /[\\\0\r\n]/.test(value)) return "";
    const path = value.slice("assets/".length);
    if (!path || /[?#]/.test(path)) return "";
    if (path.split("/").some((segment) => segment === "" || segment === "." || segment === "..")) return "";
    return value;
};

const rewriteLocalAssets = (
    nodes: readonly TopicDomNode[],
    references: Map<string, string>,
    namespace: string,
): TopicDomNode[] => nodes.map((node) => {
    if (node.kind !== "element") return {...node};
    const attributes = {...node.attributes};
    const localReference = node.name === "img" ? normalizeLocalAssetReference(attributes.src || "") : "";
    if (localReference) {
        const token = `${LOCAL_ASSET_SENTINEL}${namespace}-${references.size}`;
        references.set(token, localReference);
        attributes.src = token;
    }
    return {
        ...node,
        attributes,
        children: rewriteLocalAssets(node.children, references, namespace),
    };
});

export const filterItemHTMLIngress = (
    html: string,
    parser: TopicDomParser = browserTopicDomParser,
): string => {
    if (!html) return "";
    const references = new Map<string, string>();
    const namespace = tokenNamespace();
    let rewritten: string;
    try {
        rewritten = serializeTopicDomNodes(rewriteLocalAssets(parser.parse(html), references, namespace));
    } catch (_error) {
        return html;
    }
    let filtered: string;
    try {
        filtered = filterTopicHTMLIngress(rewritten, parser);
    } catch (_error) {
        return html;
    }
    references.forEach((reference, token) => {
        filtered = filtered.split(token).join(reference);
    });
    return filtered;
};
