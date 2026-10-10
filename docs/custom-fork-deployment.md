# Custom Fork Container Deployment

The container workflows are deliberately manual for publishing and deployment.
Pull requests build the Docker image without publishing it. Publishing requires
a manual workflow dispatch and approval from the `Publish` GitHub Environment.
Kubernetes deployment requires a separate manual dispatch and approval from the
`Production` Environment.

## One-Time GitHub Setup

1. In the repository settings, create a `Publish` Environment and configure the
   required reviewers who may approve GHCR publication.
2. Create a `Production` Environment and configure its required reviewers.
3. Add a `KUBECONFIG` secret to the `Production` Environment. Enter the raw
   kubeconfig YAML in GitHub Settings; do not commit it or send it through chat.
   Ensure the credentials are restricted to the intended cluster and namespace.
4. GHCR packages are private by default. Before deploying, either make
   `ghcr.io/eponerine/yopass-erniecosta` public or configure the Kubernetes
   namespace to pull private GHCR images using an image pull secret.

Environment approvals must be configured before dispatching the workflows;
merely referencing an Environment name in YAML does not add reviewers.

## Publish

1. Open **Actions** and select **Container image**.
2. Run the workflow from the branch and commit to publish, with `publish` set to
   `true`.
3. Approve the run in the `Publish` Environment.
4. Copy the `sha256:...` digest from the workflow summary. The image is also
   tagged with the full commit SHA, but deployment uses the digest.

## Deploy

1. Open **Actions** and select **Deploy to Kubernetes**.
2. Enter the image digest from the publish workflow, including the `sha256:`
   prefix.
3. Approve the run in the `Production` Environment.

The workflow renders the existing `deploy/yopass-k8.yaml` manifest with the
GHCR image pinned by digest, applies it, and waits for the `yopass` deployment
rollout. It does not run automatically on pushes or releases.
