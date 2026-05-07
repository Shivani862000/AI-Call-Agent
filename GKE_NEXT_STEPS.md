# GKE Deployment Next Steps

The deployment flow is now aligned to this target path:

```text
GitHub Code
-> CI/CD
-> Docker Build
-> Artifact Registry
-> GKE Kubernetes Cluster
-> LoadBalancer / Ingress
-> Live API
```

The pipeline already uses your real Artifact Registry repository:

```text
asia-south2-docker.pkg.dev/lively-math-495604-b5/feedback-agent
```

## What Changed In The Repo

- `.github/workflows/deploy.yml` now deploys to GKE instead of SSHing into a VM
- `k8s/` contains the Kubernetes manifests for the app, service, ingress, backend config, and storage
- `k8s/managed-cert.yaml` adds the GKE managed certificate for HTTPS
- the pipeline creates or updates a Kubernetes secret from `APP_ENV_FILE`
- the pipeline deletes and recreates the managed certificate on deploy
- the deployment updates the app image in-cluster and waits for rollout success

## Required GitHub Secrets

Add these repository secrets:

- `GCP_SA_KEY`
- `GKE_CLUSTER_NAME`
- `GKE_CLUSTER_LOCATION`
- `K8S_NAMESPACE`
- `APP_HOSTNAME`
- `APP_BASE_URL`
- `APP_ENV_FILE`

You no longer need VM-specific secrets such as:

- `VM_HOST`
- `VM_USER`
- `VM_SSH_PRIVATE_KEY`
- `VM_DEPLOY_PATH`

The production env secret should still include sensible defaults for:

- `CUSTOMER_PHONE`
- `CUSTOMER_NAME`

## Required Service Account Access

The service account used in `GCP_SA_KEY` should have at least:

- `Artifact Registry Writer`
- `Kubernetes Engine Developer`

If your cluster uses additional locked-down IAM or workload policies, grant only the smallest extra permissions required for deployment.

## What The Pipeline Pushes

The app image will be pushed like this:

```text
asia-south2-docker.pkg.dev/lively-math-495604-b5/feedback-agent/feedback-automation-system:<git-sha>
```

## What The Pipeline Applies

The GKE deploy job applies:

- a `PersistentVolumeClaim` for SQLite and recordings
- a `Deployment` with 1 replica
- a `Service`
- a `BackendConfig`
- a `ManagedCertificate`
- an `Ingress`

## Important Runtime Note

This app still uses SQLite and local file storage, so the Kubernetes deployment is intentionally configured for:

- `replicas: 1`
- `strategy: Recreate`
- one persistent volume claim

That is the safest starting point for this codebase on GKE.

## Next Trigger

Once the required secrets are added and your GKE cluster exists, the next step is:

```bash
git push origin deploy
```

That will:

1. build the Docker image
2. push it to Artifact Registry
3. get GKE credentials
4. apply the Kubernetes manifests
5. wait for rollout success
6. recreate the managed certificate
7. wait for the ingress IP
8. verify the service through the ingress IP with the correct `Host` header
9. wait for the managed certificate to become `Active`
10. verify HTTPS directly against the ingress IP using the hostname for SNI
