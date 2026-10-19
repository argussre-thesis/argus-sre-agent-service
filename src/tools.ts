import { tool, type ToolRuntime } from "langchain";
import * as z from "zod";
import { callOp, type OpsContext } from "./ops.ts";

const namespace = z
  .string()
  .describe(
    "Kubernetes namespace. A namespace that doesn't exist returns an empty list, not an error.",
  );

const LIST_PODS = `List the pods in a namespace, like \`kubectl get pods\`: status, ready containers, restarts, node, owner, and per container its image, state and last termination (reason, exit code, finishedAt).
A crash-looping pod's status flips between Error or OOMKilled (just exited) and CrashLoopBackOff (waiting to restart); restarts and lastTermination are the stable signal.
At most 500 pods; truncated: true means there were more.`;

const LIST_DEPLOYMENTS = `List the deployments in a namespace: ready replicas, rollout status (the checks of \`kubectl rollout status\`), pod selector and images.
"ready" can look healthy while a new rollout is stuck or failed: check "rollout".
To see a deployment's pods, pass its "selector" to list_pods as labelSelector.`;

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
    op("list_deployments", LIST_DEPLOYMENTS, {
      namespace,
      labelSelector: z
        .string()
        .optional()
        .describe(
          "Label selector on the Deployments' own labels, not their pods'. Usually not needed.",
        ),
    }),
  ];
}
