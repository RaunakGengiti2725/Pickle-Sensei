# infra/terraform

AWS infrastructure as code (spec pp. 45–46, directive §49).

```
modules/network   VPC: public ALB subnets, private app subnets, private data subnets, NAT
modules/compute   ALB + ECS Fargate (api, media-worker) + ECR (scan-on-push) + autoscaling + least-privilege task roles
modules/data      RDS PostgreSQL 16 (encrypted, PITR, deletion protection) + Redis + KMS + Secrets Manager
modules/media     Private S3 (all public access blocked, SSE-KMS, retention lifecycle) + SQS + DLQ
envs/staging      Composed staging stack
envs/production   Copy of staging shape with production sizing (create at promotion time)
```

Not yet modules (tracked in IMPLEMENTATION_STATUS): CloudFront distribution, WAF web ACL, Cognito user pool, CloudWatch alarms/dashboards, GPU worker capacity provider, multi-account org baseline (security/logging accounts).

## Honesty note

`terraform` is not installed on the current dev machine, so these configs are code-reviewed but **not `terraform validate`d/planned** here. CI's `terraform plan` step (main-branch workflow) is the gate before any apply. No production credentials are required to hold or review this code; state backends are commented until per-account bootstrap.

## Autoscaling policy (spec p. 46)

API: CPU target tracking (55%) — request-count and p95 policies attach once the ALB has traffic data. Media worker: scale on SQS queue depth (add `aws_appautoscaling_policy` with `SQSQueueMessagesVisible` after first deploy). Cloud ML: scale-to-near-zero GPU capacity when that workload exists. Database: vertical headroom first; read replica only with actual query-load evidence.
