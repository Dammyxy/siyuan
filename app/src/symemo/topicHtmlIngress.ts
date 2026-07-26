import {
    browserTopicDomParser,
    serializeTopicDomNodes,
    TopicDomElement,
    TopicDomNode,
    TopicDomParser,
} from "./topicDom";

const ALLOWED_TAGS = new Set([
    "h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "ul", "ol", "li", "blockquote", "pre", "code",
    "table", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "hr",
    "strong", "b", "em", "i", "u", "s", "del", "ins", "mark", "sub", "sup", "a", "img", "span", "div",
]);

const DANGEROUS_SUBTREES = new Set([
    "head", "title", "script", "style", "link", "meta", "base", "iframe", "object", "embed", "form", "button", "input",
    "textarea", "select", "option", "audio", "video", "source", "track", "canvas", "svg", "math",
]);

const SAFE_STYLE_PROPERTIES = new Set([
    "font-weight", "font-style", "text-decoration", "text-align", "color", "background-color",
]);

const STYLE_ORDER = ["background-color", "color", "font-style", "font-weight", "text-align", "text-decoration"];
const SAFE_CSS_SCALAR = /^[#a-zA-Z0-9\s.,()%+-]+$/;
const UNSAFE_FORMULA_COMMAND = /\\(?:catcode|csname|def|edef|endcsname|expandafter|futurelet|gdef|global|href|includegraphics|let|long|newcommand|noexpand|providecommand|renewcommand|url|xdef)\b/i;

const isSafeAbsoluteURL = (value: string): boolean => {
    try {
        const url = new URL(value.trim());
        return url.protocol === "http:" || url.protocol === "https:";
    } catch {
        return false;
    }
};

export const isSafeTopicHref = (value: string): boolean => {
    const trimmed = value.trim();
    return /^#[^\s]+$/.test(trimmed) || isSafeAbsoluteURL(trimmed);
};

const isSafeID = (value: string): boolean => {
    const trimmed = value.trim();
    return trimmed !== "" && !/[\s<>"'`]/.test(trimmed);
};

const isPositiveSmallInteger = (value: string): boolean => {
    const trimmed = value.trim();
    return /^\d{1,4}$/.test(trimmed) && trimmed !== "0";
};

const sanitizeStyle = (value: string): string => {
    const retained = new Map<string, string>();
    for (const declaration of value.split(";")) {
        const colon = declaration.indexOf(":");
        if (colon <= 0) continue;
        const property = declaration.slice(0, colon).trim().toLowerCase();
        const scalar = declaration.slice(colon + 1).trim().replace(/\s+/g, " ");
        const lower = scalar.toLowerCase();
        if (!SAFE_STYLE_PROPERTIES.has(property) || !scalar || !SAFE_CSS_SCALAR.test(scalar) ||
            lower.includes("url(") || lower.includes("var(") || lower.includes("calc(") || lower.includes("expression") ||
            /[@<>{}\\]/.test(scalar)) {
            continue;
        }
        retained.set(property, scalar);
    }
    return STYLE_ORDER.flatMap((property) => {
        const scalar = retained.get(property);
        return scalar ? [`${property}: ${scalar}`] : [];
    }).join("; ");
};

const isFormulaElement = (element: TopicDomElement): boolean =>
    element.attributes["data-subtype"] === "math" && (
        (element.name === "span" && element.attributes["data-type"] === "inline-math") ||
        (element.name === "div" && element.attributes["data-type"] === "NodeMathBlock")
    );

const sanitizeAttributes = (element: TopicDomElement): Record<string, string> | undefined => {
    const output: Record<string, string> = {};
    const formula = isFormulaElement(element);

    if (formula) {
        const content = element.attributes["data-content"];
        if (!content || UNSAFE_FORMULA_COMMAND.test(content)) return undefined;
        output["data-content"] = content;
        output["data-subtype"] = "math";
        output["data-symemo-katex-trust"] = "false";
        output["data-type"] = element.name === "span" ? "inline-math" : "NodeMathBlock";
        return output;
    }

    for (const [name, rawValue] of Object.entries(element.attributes)) {
        const value = rawValue.trim();
        if (name.startsWith("on") || name.startsWith("data-") || name === "srcset" || name === "formaction") continue;
        if (name === "href" && element.name === "a" && isSafeTopicHref(value)) {
            output[name] = value;
        } else if (name === "src" && element.name === "img" && isSafeAbsoluteURL(value)) {
            output[name] = value;
        } else if ((name === "alt" || name === "title") && (element.name === "img" || element.name === "a")) {
            output[name] = rawValue;
        } else if (name === "id" && isSafeID(value)) {
            output[name] = value;
        } else if ((name === "colspan" || name === "rowspan") && (element.name === "td" || element.name === "th") && isPositiveSmallInteger(value)) {
            output[name] = value;
        } else if (name === "scope" && element.name === "th" && isSafeID(value)) {
            output[name] = value;
        } else if (name === "start" && element.name === "ol" && isPositiveSmallInteger(value)) {
            output[name] = value;
        } else if (name === "reversed" && element.name === "ol") {
            output[name] = "";
        } else if (name === "style") {
            const style = sanitizeStyle(rawValue);
            if (style) output[name] = style;
        }
    }

    if (element.name === "img" && !output.src) return undefined;
    return output;
};

const sanitizeNode = (node: TopicDomNode): TopicDomNode[] => {
    if (node.kind === "comment") return [];
    if (node.kind === "text") return [{...node}];
    if (DANGEROUS_SUBTREES.has(node.name)) return [];

    const children = node.children.flatMap(sanitizeNode);
    if (!ALLOWED_TAGS.has(node.name)) return children;
    if ((node.name === "span" || node.name === "div") && !isFormulaElement(node)) return children;

    const attributes = sanitizeAttributes(node);
    if (!attributes) return [];
    return [{kind: "element", name: node.name, attributes, children: isFormulaElement(node) ? [] : children}];
};

export const filterTopicHTMLIngress = (html: string, parser: TopicDomParser = browserTopicDomParser): string => {
    if (!html) return "";
    return serializeTopicDomNodes(parser.parse(html).flatMap(sanitizeNode)).trim();
};
