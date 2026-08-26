# Private media storage + delivery + queues (spec pp. 38, 41, 45):
# S3 with all public access blocked, SSE-KMS, lifecycle retention; CloudFront
# for static delivery; SQS + DLQ for media/ML jobs.

variable "name" { type = string }
variable "kms_key_arn" { type = string }
variable "raw_clip_retention_days" {
  type    = number
  default = 30
}

resource "aws_s3_bucket" "media" {
  bucket = "${var.name}-media"
}

resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = var.kms_key_arn
    }
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  # Raw cloud clips: 30-day default retention unless the user keeps them
  # (kept objects are re-tagged by the media worker).
  rule {
    id     = "raw-clip-retention"
    status = "Enabled"
    filter {
      and {
        prefix = "media/"
        tags   = { retention = "default" }
      }
    }
    expiration { days = var.raw_clip_retention_days }
  }
  rule {
    id     = "share-render-intermediates"
    status = "Enabled"
    filter { prefix = "share-intermediate/" }
    expiration { days = 14 }
  }
}

resource "aws_sqs_queue" "jobs_dlq" {
  name                      = "${var.name}-jobs-dlq"
  message_retention_seconds = 1209600
}

resource "aws_sqs_queue" "jobs" {
  name                       = "${var.name}-jobs"
  visibility_timeout_seconds = 300
  redrive_policy = jsonencode({
    deadLetterTargetArn = aws_sqs_queue.jobs_dlq.arn
    maxReceiveCount     = 5
  })
}

output "media_bucket" { value = aws_s3_bucket.media.bucket }
output "jobs_queue_url" { value = aws_sqs_queue.jobs.url }
output "jobs_dlq_url" { value = aws_sqs_queue.jobs_dlq.url }
