# RDS PostgreSQL + Redis + KMS (spec pp. 41, 45): private subnets, encryption
# at rest, automated backups + PITR, no public access.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "data_subnet_ids" { type = list(string) }
variable "app_security_group_id" { type = string }
variable "db_instance_class" {
  type    = string
  default = "db.t4g.medium"
}
variable "db_allocated_storage" {
  type    = number
  default = 50
}

resource "aws_kms_key" "data" {
  description         = "${var.name} data encryption"
  enable_key_rotation = true
}

resource "aws_db_subnet_group" "this" {
  name       = "${var.name}-db"
  subnet_ids = var.data_subnet_ids
}

resource "aws_security_group" "db" {
  name   = "${var.name}-db"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 5432
    to_port         = 5432
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "random_password" "db_master" {
  length  = 32
  special = false
}

resource "aws_secretsmanager_secret" "db_master" {
  name       = "${var.name}/db-master"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "db_master" {
  secret_id     = aws_secretsmanager_secret.db_master.id
  secret_string = random_password.db_master.result
}

# Per-role connection credentials (g12-f23). Terraform manages the secret
# material only; the Postgres LOGIN roles themselves are created inside the
# database by an operator following docs/RUNBOOK_CONSENT_DB_ROLES.md (the AWS
# provider cannot create in-database roles). Each secret stores a full
# connection URL so ECS tasks can consume it as a single environment variable.
locals {
  db_login_roles = ["app", "worker", "migrator", "readonly"]
  db_login_usernames = {
    app      = "pickle_app"
    worker   = "pickle_worker"
    migrator = "pickle_migrator"
    readonly = "pickle_ro"
  }
}

resource "random_password" "db_role" {
  for_each = toset(local.db_login_roles)
  length   = 32
  special  = false
}

resource "aws_secretsmanager_secret" "db_url" {
  for_each   = toset(local.db_login_roles)
  name       = "${var.name}/db-url-${each.key}"
  kms_key_id = aws_kms_key.data.arn
}

resource "aws_secretsmanager_secret_version" "db_url" {
  for_each  = toset(local.db_login_roles)
  secret_id = aws_secretsmanager_secret.db_url[each.key].id
  secret_string = format(
    "postgres://%s:%s@%s:5432/%s",
    local.db_login_usernames[each.key],
    random_password.db_role[each.key].result,
    aws_db_instance.postgres.address,
    aws_db_instance.postgres.db_name,
  )
}

resource "aws_db_instance" "postgres" {
  identifier                      = "${var.name}-pg"
  engine                          = "postgres"
  engine_version                  = "16"
  instance_class                  = var.db_instance_class
  allocated_storage               = var.db_allocated_storage
  db_name                         = "pickle"
  username                        = "pickle_admin"
  password                        = random_password.db_master.result
  db_subnet_group_name            = aws_db_subnet_group.this.name
  vpc_security_group_ids          = [aws_security_group.db.id]
  storage_encrypted               = true
  kms_key_id                      = aws_kms_key.data.arn
  backup_retention_period         = 14
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${var.name}-pg-final"
  publicly_accessible             = false
  performance_insights_enabled    = true
  performance_insights_kms_key_id = aws_kms_key.data.arn
}

resource "aws_security_group" "redis" {
  name   = "${var.name}-redis"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 6379
    to_port         = 6379
    protocol        = "tcp"
    security_groups = [var.app_security_group_id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_elasticache_subnet_group" "this" {
  name       = "${var.name}-redis"
  subnet_ids = var.data_subnet_ids
}

resource "aws_elasticache_replication_group" "redis" {
  replication_group_id       = "${var.name}-redis"
  description                = "${var.name} cache/rate limiting"
  engine                     = "redis"
  node_type                  = "cache.t4g.small"
  num_cache_clusters         = 1
  subnet_group_name          = aws_elasticache_subnet_group.this.name
  security_group_ids         = [aws_security_group.redis.id]
  at_rest_encryption_enabled = true
  transit_encryption_enabled = true
}

output "db_endpoint" { value = aws_db_instance.postgres.address }
output "db_secret_arn" { value = aws_secretsmanager_secret.db_master.arn }
output "db_url_app_secret_arn" { value = aws_secretsmanager_secret.db_url["app"].arn }
output "db_url_worker_secret_arn" { value = aws_secretsmanager_secret.db_url["worker"].arn }
output "db_url_migrator_secret_arn" { value = aws_secretsmanager_secret.db_url["migrator"].arn }
output "db_url_readonly_secret_arn" { value = aws_secretsmanager_secret.db_url["readonly"].arn }
output "redis_endpoint" { value = aws_elasticache_replication_group.redis.primary_endpoint_address }
output "kms_key_arn" { value = aws_kms_key.data.arn }
