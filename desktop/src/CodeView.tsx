import { Highlight, type PrismTheme } from "prism-react-renderer";
import { useEffect, useRef, useState } from "react";

const DARK_THEME: PrismTheme = {
  plain: { color: "#dde1ea", backgroundColor: "transparent" },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#6d6e80", fontStyle: "italic" },
    },
    { types: ["punctuation"], style: { color: "#a8a9b8" } },
    {
      types: ["property", "tag", "boolean", "number", "constant", "symbol", "deleted"],
      style: { color: "#fbbf24" },
    },
    {
      types: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
      style: { color: "#86dcb1" },
    },
    { types: ["operator", "entity", "url"], style: { color: "#84b9e8" } },
    { types: ["atrule", "attr-value", "keyword"], style: { color: "#b4a8f0" } },
    {
      types: ["function", "class-name", "maybe-class-name"],
      style: { color: "#84b9e8", fontWeight: "500" },
    },
    { types: ["regex", "important", "variable"], style: { color: "#f0c062" } },
    { types: ["important", "bold"], style: { fontWeight: "bold" } },
    { types: ["italic"], style: { fontStyle: "italic" } },
  ],
};

const LIGHT_THEME: PrismTheme = {
  plain: { color: "#24292e", backgroundColor: "transparent" },
  styles: [
    {
      types: ["comment", "prolog", "doctype", "cdata"],
      style: { color: "#6a737d", fontStyle: "italic" },
    },
    { types: ["punctuation"], style: { color: "#24292e" } },
    {
      types: ["property", "tag", "boolean", "number", "constant", "symbol", "deleted"],
      style: { color: "#d73a49" },
    },
    {
      types: ["selector", "attr-name", "string", "char", "builtin", "inserted"],
      style: { color: "#032f62" },
    },
    { types: ["operator", "entity", "url"], style: { color: "#d73a49" } },
    { types: ["atrule", "attr-value", "keyword"], style: { color: "#d73a49" } },
    {
      types: ["function", "class-name", "maybe-class-name"],
      style: { color: "#6f42c1", fontWeight: "500" },
    },
    { types: ["regex", "important", "variable"], style: { color: "#e36209" } },
    { types: ["important", "bold"], style: { fontWeight: "bold" } },
    { types: ["italic"], style: { fontStyle: "italic" } },
  ],
};

function usePrismTheme(): PrismTheme {
  const [theme, setTheme] = useState<"dark" | "light">(() =>
    document.documentElement.dataset.theme === "light" ? "light" : "dark",
  );
  const prevRef = useRef(theme);
  useEffect(() => {
    const el = document.documentElement;
    const cb = () => {
      const t = el.dataset.theme === "light" ? "light" : "dark";
      if (t !== prevRef.current) {
        prevRef.current = t;
        setTheme(t);
      }
    };
    const mo = new MutationObserver(cb);
    mo.observe(el, { attributes: true, attributeFilter: ["data-theme"] });
    return () => mo.disconnect();
  }, []);
  return theme === "dark" ? DARK_THEME : LIGHT_THEME;
}

export function CodeView({
  text,
  lang,
  startLine = 1,
  showLineNumbers = true,
}: {
  text: string;
  lang: string;
  startLine?: number;
  showLineNumbers?: boolean;
}) {
  const theme = usePrismTheme();
  return (
    <Highlight theme={theme} code={text} language={lang}>
      {({ className, tokens, getLineProps, getTokenProps }) => (
        <pre className={`codeview ${className}`}>
          {tokens.map((line, i) => (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: prism token lines are a static snapshot
              key={i}
              {...getLineProps({ line })}
              className="codeview-line"
            >
              {showLineNumbers && <span className="codeview-line-num">{i + startLine}</span>}
              <span className="codeview-line-content">
                {line.map((token, k) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: prism tokens are a static snapshot
                    key={k}
                    {...getTokenProps({ token })}
                  />
                ))}
              </span>
            </div>
          ))}
        </pre>
      )}
    </Highlight>
  );
}
