import { tool, type ToolRuntime } from "langchain";
import * as z from "zod";
import { callOp, type OpsContext } from "./ops.ts";

const namespace = z
  .string()
  .describe(
    "Kubernetes namespace. Listing a namespace that doesn't exist returns an empty list, not an error.",
  );

const LIST_PODS = `List the pods in a namespace, like \`kubectl get pods\`: status, ready containers, restarts, node, owner, and per container its image, state and last termination (reason, exit code, finishedAt).
A crash-looping pod's status flips between Error or OOMKilled (just exited) and CrashLoopBackOff (waiting to restart); restarts and lastTermination are the stable signal.
At most 500 pods; truncated: true means there were more.`;

const GET_POD = `Describe one pod, like \`kubectl describe pod\` without events: per container its image, command and args, resources (requests, limits), probes, env vars (names and source only, never values), state and last termination (reason, exit code, message); "problems" (the pod conditions that aren't True, e.g. Ready=False), labels and owner.
Use it for what list_pods doesn't show: a container's limits (why it was OOMKilled), its probes (why it isn't Ready), what it runs.`;

const GET_LOGS = `Read a container's logs: the newest lines that fit 64 KB, with timestamps, each line cut at 2,000 characters; truncated: true means older lines were left out.
While a container waits in CrashLoopBackOff, its current logs are its last crashed run, the same as previous: true. A container still waiting for its image has no logs (the error says why).`;

const LIST_EVENTS = `List a namespace's events, newest first: time, type, reason, object (Kind/name), message, count. At most 100; truncated: true means more matched.
Ask for type "Warning" about one object first (the signal: most Normal events are routine); ask for the full timeline only when you need it.
Kubernetes keeps events for about an hour, so older history isn't here, and the first, most specific error of a failure can already be gone (e.g. why an image pull failed; later events only repeat "Back-off pulling image").`;

const LIST_DEPLOYMENTS = `List the deployments in a namespace: ready replicas, rollout status (the checks of \`kubectl rollout status\`), pod selector and images.
"ready" can look healthy while a new rollout is stuck or failed: check "rollout".
To see a deployment's pods or ReplicaSets, pass its "selector" to list_pods or list_replicasets as labelSelector.`;

const LIST_REPLICASETS = `List the ReplicaSets in a namespace: one per Deployment revision, grouped by Deployment (owner), newest revision first, each with revision, changeCause, ready ("ready/desired"; 0/0 is an old revision) and its pod template's containers (as in get_pod).
Comparing a Deployment's newest revision with the one before shows what a rollout changed. restartedAt set means the revision came from \`kubectl rollout restart\`, with the template otherwise unchanged.
Pass the Deployment's "selector" (from list_deployments) as labelSelector: a whole namespace can be large.`;

export function createTools(opsUrl: string) {
  // strictObject: a mistyped arg is an error the model sees, instead of being dropped silently.
  const op = (name: string, description: string, shape: z.ZodRawShape) =>
    tool(
      (args: object, runtime: ToolRuntime<unknown, OpsContext>) =>
        callOp(opsUrl, runtime.context, name, args),
      {
        name,
        description,
        schema: z.strictObject(shape),
        extras: { strict: true },
      },
    );

  return [
    op("list_pods", LIST_PODS, {
      namespace,
      labelSelector: z
        .string()
        .optional()
        .describe('Label selector on the pods, e.g. "app=web"'),
    }),
    op("get_pod", GET_POD, {
      namespace,
      name: z.string().describe("The pod's name, as in list_pods"),
    }),
    op("get_logs", GET_LOGS, {
      namespace,
      pod: z.string().describe("The pod's name, as in list_pods"),
      container: z
        .string()
        .optional()
        .describe(
          "Needed when the pod has more than one container (the error names them)",
        ),
      previous: z
        .boolean()
        .optional()
        .describe(
          "true for the container's previous run, the one before its last restart. Can be gone (NOT_FOUND)",
        ),
      tailLines: z
        .number()
        .optional()
        .describe(
          "How many of the newest lines, a whole number from 1 to 500 (default 100). TOO_LARGE means they are over 2 MB: ask for fewer",
        ),
      sinceSeconds: z
        .number()
        .optional()
        .describe(
          "Only lines from the last N seconds, a whole number up to 604800 (7 days)",
        ),
    }),
    op("list_events", LIST_EVENTS, {
      namespace,
      involvedObject: z
        .string()
        .optional()
        .describe(
          'Only events about one object: "Kind/name" (e.g. "Pod/web-7d9f-x2k", or the owner shown by list_pods or get_pod, e.g. "ReplicaSet/web-7d9f") or a bare name',
        ),
      type: z.enum(["Warning", "Normal"]).optional(),
      sinceSeconds: z
        .number()
        .optional()
        .describe(
          "Only events from the last N seconds, a whole number from 1 to 3600",
        ),
    }),
    op("list_deployments", LIST_DEPLOYMENTS, {
      namespace,
      labelSelector: z
        .string()
        .optional()
        .describe(
          "Label selector on the Deployments' own labels, not their pods'. Usually not needed.",
        ),
    }),
    op("list_replicasets", LIST_REPLICASETS, {
      namespace,
      labelSelector: z
        .string()
        .optional()
        .describe(
          'Label selector on the ReplicaSets, e.g. a Deployment\'s selector "app=web"',
        ),
    }),
  ];
}
