import type { IncidentAlert } from "../src/agent/prompts.ts";

// The broken workloads in minikube's `demo` (experiment/runner/k8s/scenarios/), each with the alert kube-prometheus would fire for it.
// Pod names are today's: if minikube recreates a pod, update its name here.
export type Scenario = { name: string; alert: Pick<IncidentAlert, "labels" | "annotations">; rootCause: string };

const crashLooping = (pod: string) => ({
  labels: { alertname: "KubePodCrashLooping", severity: "warning", namespace: "demo", pod, container: "app" },
  annotations: {
    summary: "Pod is crash looping.",
    description: `Pod demo/${pod} (app) is in waiting state (reason: "CrashLoopBackOff").`,
  },
});

export const scenarios: Scenario[] = [
  {
    name: "crashloop",
    alert: crashLooping("crashloop-68784d8c77-sbnvd"),
    rootCause: "the container prints 'FATAL: db connection refused' and exits 1 (only the logs show it)",
  },
  {
    name: "oom",
    alert: crashLooping("oom-866ccf4c54-glwnl"),
    rootCause: "OOMKilled (exit 137): the container allocates 200 MB against a 32Mi memory limit",
  },
  {
    name: "bad-image",
    alert: {
          labels: { alertname: "KubePodNotReady", severity: "warning", namespace: "demo", pod: "bad-image-6cc4665f8b-twgf9" },
      annotations: {
        summary: "Pod has been in a non-ready state for more than 15 minutes.",
        description: "Pod demo/bad-image-6cc4665f8b-twgf9 has been in a non-ready state for longer than 15 minutes.",
      },
    },
    rootCause: "ImagePullBackOff: the image tag nginx:9.9.9-does-not-exist doesn't exist",
  },
  {
    // KubePodNotReady only fires for Pending/Unknown/Failed pods; this one is Running, so the deployment's alert fires.
    name: "not-ready",
    alert: {
          labels: { alertname: "KubeDeploymentReplicasMismatch", severity: "warning", namespace: "demo", deployment: "not-ready" },
      annotations: {
        summary: "Deployment has not matched the expected number of replicas.",
        description: "Deployment demo/not-ready has not matched the expected number of replicas for longer than 15 minutes.",
      },
    },
    rootCause: "the readiness probe GET /healthz on port 80 returns 404, so the pod never becomes Ready",
  },
  {
    name: "bad-deploy",
    alert: {
          labels: { alertname: "KubeDeploymentRolloutStuck", severity: "warning", namespace: "demo", deployment: "web", condition: "Progressing", status: "false" },
      annotations: {
        summary: "Deployment rollout is not progressing.",
        description: "Rollout of deployment demo/web is not progressing for longer than 15 minutes.",
      },
    },
    rootCause:
      "release v2 (same image) changed the command to read /etc/web/config.yaml, which doesn't exist: the new pod exits 1, the old ReplicaSet keeps serving",
  },
];
