#!/usr/bin/env bash
# Reference commands for deploying company-categorizer-ts to Google Cloud as a
# Cloud Run JOB (not a Service) triggered on a schedule by Cloud Scheduler.
#
# Why a Job instead of a Service: this app has no HTTP server and no
# incoming traffic to respond to - it wakes up, processes a batch, and
# exits. A Cloud Run Service would have to be kept alive 24/7 (or you'd
# fight cold starts trying to scale it to zero) to run node-cron inside
# it, and you'd be billed for idle time. A Job only bills for the seconds
# it's actually executing, which for this workload is the cheapest option.
#
# This file is a REFERENCE - read it, adjust the variables, and run the
# commands yourself (or copy/paste them one at a time). It is not meant
# to be run unattended.

set -euo pipefail

# ---- 1. Variables - EDIT THESE ----
PROJECT_ID="your-gcp-project-id"
REGION="us-central1"                     # pick the region closest to you / your DB
REPO="company-categorizer-ts"               # Artifact Registry repo name
JOB_NAME="company-categorizer-ts"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/${REPO}/${JOB_NAME}:latest"
SCHEDULER_JOB="company-categorizer-ts-trigger"
SCHEDULE="*/15 * * * *"                  # matches SCHEDULE_CRON in .env.example
SA_NAME="company-categorizer-ts-invoker"    # dedicated service account for Scheduler -> Run

# ---- 2. One-time project setup ----
gcloud config set project "$PROJECT_ID"

gcloud services enable \
  run.googleapis.com \
  cloudscheduler.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  sqladmin.googleapis.com   # only needed if you use Cloud SQL for Postgres

gcloud artifacts repositories create "$REPO" \
  --repository-format=docker \
  --location="$REGION" \
  --description="company-categorizer-ts images"

# ---- 3. Store secrets in Secret Manager (do this once, update as needed) ----
# Run each of these interactively so the secret value isn't left in your
# shell history:
#   printf '%s' "the-value" | gcloud secrets create SECRET_NAME --data-file=-
# Repeat for:
#   GOOGLE_SERVICE_ACCOUNT_EMAIL
#   GOOGLE_PRIVATE_KEY        (paste the full PEM block, real newlines are fine here)
#   FIRECRAWL_API_KEY
#   ANTHROPIC_API_KEY
#   DATABASE_URL
#   SSH_PRIVATE_KEY           (only if SSH_TUNNEL_ENABLED=true - see README)
#
# GOOGLE_SPREADSHEET_ID and GOOGLE_SHEET_NAME are NOT secrets - they're
# plain env vars (see --set-env-vars below) specifically so you can switch
# sheets later with a single `gcloud run jobs update --update-env-vars`
# call, with no need to touch Secret Manager or rebuild the image.

# ---- 4. Build and push the image (uses Cloud Build, no local Docker needed) ----
gcloud builds submit --tag "$IMAGE" .

# ---- 5. Create the Cloud Run Job ----
gcloud run jobs create "$JOB_NAME" \
  --image="$IMAGE" \
  --region="$REGION" \
  --cpu=1 \
  --memory=512Mi \
  --max-retries=1 \
  --task-timeout=900s \
  --set-env-vars="GOOGLE_SPREADSHEET_ID=your-spreadsheet-id,GOOGLE_SHEET_NAME=Companies - Uncategorized,ANTHROPIC_MODEL=claude-sonnet-4-6,BATCH_SIZE=10,SCRAPE_DELAY_MS=20000,BETWEEN_COMPANY_DELAY_MS=3000" \
  --set-secrets="GOOGLE_SERVICE_ACCOUNT_EMAIL=GOOGLE_SERVICE_ACCOUNT_EMAIL:latest,\
GOOGLE_PRIVATE_KEY=GOOGLE_PRIVATE_KEY:latest,\
FIRECRAWL_API_KEY=FIRECRAWL_API_KEY:latest,\
ANTHROPIC_API_KEY=ANTHROPIC_API_KEY:latest,\
DATABASE_URL=DATABASE_URL:latest"
# If you're using an SSH tunnel to reach Postgres (SSH_TUNNEL_ENABLED=true),
# also add to --set-env-vars: SSH_TUNNEL_ENABLED=true,SSH_HOST=...,SSH_PORT=22,SSH_USERNAME=...
# and to --set-secrets: SSH_PRIVATE_KEY=SSH_PRIVATE_KEY:latest

# To point at a different sheet later (no rebuild, no redeploy of the
# image, no Secret Manager changes needed):
#   gcloud run jobs update "$JOB_NAME" --region="$REGION" \
#     --update-env-vars="GOOGLE_SPREADSHEET_ID=<new-id>,GOOGLE_SHEET_NAME=<tab-name>"
# Remember to share the new sheet with the service account's client_email
# as an Editor, and make sure its headers match (Domains, Category,
# Sub Category, Note, Checked, Errors).

# If your Postgres is Cloud SQL, add (and see the Cloud SQL note below):
#   --add-cloudsql-instances="$PROJECT_ID:$REGION:your-instance-name"
# and set DATABASE_URL to use the unix socket path, e.g.
#   postgresql://user:pass@/dbname?host=/cloudsql/PROJECT:REGION:INSTANCE

# ---- 6. Let Cloud Scheduler invoke the Job on a schedule ----
# Dedicated service account, least privilege: only "run.invoker" on this job.
gcloud iam service-accounts create "$SA_NAME" \
  --display-name="Invokes the company-categorizer-ts Cloud Run Job"

gcloud run jobs add-iam-policy-binding "$JOB_NAME" \
  --region="$REGION" \
  --member="serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
  --role="roles/run.invoker"

JOB_URI="https://${REGION}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${PROJECT_ID}/jobs/${JOB_NAME}:run"

gcloud scheduler jobs create http "$SCHEDULER_JOB" \
  --location="$REGION" \
  --schedule="$SCHEDULE" \
  --uri="$JOB_URI" \
  --http-method=POST \
  --oauth-service-account-email="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# ---- 7. Test it ----
#   gcloud run jobs execute "$JOB_NAME" --region="$REGION"
#   gcloud run jobs executions list --job="$JOB_NAME" --region="$REGION"
# Then check logs:
#   gcloud beta run jobs executions logs read EXECUTION_NAME --region="$REGION"
