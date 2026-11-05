import { isDeepStrictEqual } from "node:util";
import { AIMessage, type BaseMessage } from "langchain";

const ITEM = /^([-*]|\d+\.)\s+/;

// As the prompt asks for it: `list_pods {"namespace":"demo"}`. Arguments can hold backticks (LogQL),
// so a citation ends at the first }` that leaves valid JSON, or at the first }` if none does.
function citationsIn(item: string) {
  const found: { text: string; name: string; args: unknown }[] = [];
  const start = /`([a-zA-Z0-9_-]+) (?=\{)/g;
  for (let m = start.exec(item); m; m = start.exec(item)) {
    const from = start.lastIndex;
    const ends = [...item.slice(from).matchAll(/\}`/g)].map((e) => from + e.index + 1);
    if (ends.length === 0) continue;
    const end = ends.find((e) => parse(item.slice(from, e)) !== undefined) ?? ends[0]!;
    found.push({ text: item.slice(m.index, end + 1), name: m[1]!, args: parse(item.slice(from, end)) });
    start.lastIndex = end + 1;
  }
  return found;
}

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
    const cited = citationsIn(item);
    if (cited.length === 0) return [`no tool call cited in: "${item}"`];
    return cited
      .filter(({ name, args }) => !calls.some((c) => c.name === name && isDeepStrictEqual(c.args, args)))
      .map(({ text }) => `${text} matches no tool call you made`);
  });
}

function parse(json: string): unknown {
  try {
    return JSON.parse(json);
  } catch {
    return undefined;
  }
}
