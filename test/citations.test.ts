import assert from "node:assert/strict";
import { test } from "node:test";
import { AIMessage, ToolMessage } from "langchain";
import { citationProblems } from "../src/agent/citations.ts";

const transcript = [
  new AIMessage({ content: "", tool_calls: [{ name: "list_pods", args: { namespace: "demo", labelSelector: "app=api" }, id: "1" }] }),
  new ToolMessage({ content: "{}", tool_call_id: "1" }),
];
const call = '`list_pods {"namespace":"demo","labelSelector":"app=api"}`';
// Suggested fix comes after Evidence and cites nothing: it must not be checked.
const report = (evidence: string) => `## Summary\nx\n## Evidence\n${evidence}\n## Suggested fix\n- Raise the memory limit.`;

test("every Evidence item must cite a tool call that ran", () => {
  const cases: [name: string, evidence: string, problems: string[]][] = [
    ["cited as sent", `- api-1 restarted 14 times ${call}`, []],
    ["key order and spaces don't matter", '- x `list_pods { "labelSelector": "app=api", "namespace": "demo" }`', []],
    ["cited on the item's next line", `- x\n  ${call}`, []],
    ["a numbered list", `1. x ${call}\n2. y`, ['no tool call cited in: "y"']],
    ["no items at all", "None: the runner was offline.", []],
    ["an item without a citation", `- x ${call}\n- api-1 was OOMKilled`, ['no tool call cited in: "api-1 was OOMKilled"']],
    ["different args", '- x `list_pods {"namespace":"demo"}`', ['`list_pods {"namespace":"demo"}` matches no tool call you made']],
    [
      "the same args on a tool that never ran",
      '- x `list_deployments {"namespace":"demo","labelSelector":"app=api"}`',
      ['`list_deployments {"namespace":"demo","labelSelector":"app=api"}` matches no tool call you made'],
    ],
    ["not JSON", "- x `list_pods {namespace: demo}`", ["`list_pods {namespace: demo}` matches no tool call you made"]],
  ];
  for (const [name, evidence, problems] of cases) {
    assert.deepEqual(citationProblems(report(evidence), transcript), problems, name);
  }
});

test("a report without an Evidence section", () => {
  assert.deepEqual(citationProblems(`## Summary\nx ${call}`, transcript), ["the report has no ## Evidence section"]);
});
