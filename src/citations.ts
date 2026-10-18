import { isDeepStrictEqual } from "node:util";
import { AIMessage, type BaseMessage } from "langchain";

// As the prompt asks for it: `list_pods {"namespace":"demo"}`.
const CITATION = /`([a-z_]+) (\{[^`]*\})`/g;
const ITEM = /^([-*]|\d+\.)\s+/;

// What's wrong with the report's Evidence: every item must cite a tool call, and every cited call must have run.
export function citationProblems(report: string, messages: BaseMessage[]): string[] {
  const lines = report.split("\n");
  const start = lines.findIndex((l) => /^##\s*Evidence$/i.test(l.trim()));
  if (start === -1) return ["the report has no ## Evidence section"];
  const end = lines.findIndex((l, i) => i > start && /^#{1,6}\s/.test(l));

  // An item starts at column 0; indented lines, sub-items included, belong to the one above.
  const items: string[] = [];
  for (const line of lines.slice(start + 1, end === -1 ? undefined : end)) {
    if (ITEM.test(line)) items.push(line.replace(ITEM, ""));
    else if (items.length > 0 && line.trim()) items[items.length - 1] += `\n${line}`;
  }

  const calls = messages.flatMap((m) => (AIMessage.isInstance(m) ? (m.tool_calls ?? []) : []));
  return items.flatMap((item) => {
    const cited = [...item.matchAll(CITATION)];
    if (cited.length === 0) return [`no tool call cited in: "${item}"`];
    return cited
      .filter(([, name, args]) => !calls.some((c) => c.name === name && isDeepStrictEqual(c.args, parse(args!))))
      .map(([citation]) => `${citation} matches no tool call you made`);
  });
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
