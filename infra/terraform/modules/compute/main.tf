# ALB + ECS Fargate services (api, media-worker) + ECR + autoscaling
# (spec pp. 45-46). GPU workers are added when cloud ML demand appears.

variable "name" { type = string }
variable "vpc_id" { type = string }
variable "public_subnet_ids" { type = list(string) }
variable "app_subnet_ids" { type = list(string) }
variable "api_image" { type = string }
variable "worker_image" { type = string }
variable "api_desired_count" {
  type    = number
  default = 2
}

# Per-role database credentials (g12-f23): Secrets Manager ARNs holding the
# full connection URLs for the least-privilege login roles. The api task gets
# DATABASE_URL_APP, the worker task DATABASE_URL_WORKER — matching the env
# vars services/api/src/config.ts and services/media-worker/src/main.ts read.
# Migrations are NOT wired here: they run as a deliberate operator step with
# the migrator credential (docs/RUNBOOK_CONSENT_DB_ROLES.md).
variable "api_db_url_secret_arn" { type = string }
variable "worker_db_url_secret_arn" { type = string }
variable "secrets_kms_key_arn" { type = string }

resource "aws_ecr_repository" "api" {
  name = "${var.name}-api"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_ecr_repository" "worker" {
  name = "${var.name}-media-worker"
  image_scanning_configuration { scan_on_push = true }
}

resource "aws_security_group" "alb" {
  name   = "${var.name}-alb"
  vpc_id = var.vpc_id
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_security_group" "app" {
  name   = "${var.name}-app"
  vpc_id = var.vpc_id
  ingress {
    from_port       = 3001
    to_port         = 3001
    protocol        = "tcp"
    security_groups = [aws_security_group.alb.id]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}

resource "aws_lb" "this" {
  name               = "${var.name}-alb"
  load_balancer_type = "application"
  subnets            = var.public_subnet_ids
  security_groups    = [aws_security_group.alb.id]
}

resource "aws_lb_target_group" "api" {
  name        = "${var.name}-api"
  port        = 3001
  protocol    = "HTTP"
  vpc_id      = var.vpc_id
  target_type = "ip"
  health_check {
    path                = "/v1/health"
    healthy_threshold   = 2
    unhealthy_threshold = 3
    interval            = 15
  }
}

resource "aws_ecs_cluster" "this" {
  name = var.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}

resource "aws_iam_role" "task_execution" {
  name = "${var.name}-task-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_iam_role_policy_attachment" "task_execution" {
  role       = aws_iam_role.task_execution.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}

# The execution role (not the task role) resolves container `secrets` at
# launch; scope it to exactly the two runtime DB-URL secrets and the KMS key
# that encrypts them.
resource "aws_iam_role_policy" "task_execution_db_secrets" {
  name = "${var.name}-db-url-secrets"
  role = aws_iam_role.task_execution.id
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = "secretsmanager:GetSecretValue"
        Resource = [var.api_db_url_secret_arn, var.worker_db_url_secret_arn]
      },
      {
        Effect   = "Allow"
        Action   = "kms:Decrypt"
        Resource = [var.secrets_kms_key_arn]
      }
    ]
  })
}

# Least-privilege task role: services get exactly the S3/SQS/Secrets access
# they need, attached per-service in the env stacks (spec p. 41).
resource "aws_iam_role" "api_task" {
  name = "${var.name}-api-task"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Action    = "sts:AssumeRole"
      Effect    = "Allow"
      Principal = { Service = "ecs-tasks.amazonaws.com" }
    }]
  })
}

resource "aws_ecs_task_definition" "api" {
  family                   = "${var.name}-api"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  container_definitions = jsonencode([{
    name         = "api"
    image        = var.api_image
    essential    = true
    portMappings = [{ containerPort = 3001 }]
    environment  = [{ name = "PICKLE_ENV", value = "production" }]
    secrets = [
      { name = "DATABASE_URL_APP", valueFrom = var.api_db_url_secret_arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/${var.name}-api"
        awslogs-region        = "us-west-2"
        awslogs-stream-prefix = "api"
        awslogs-create-group  = "true"
      }
    }
  }])
}

resource "aws_ecs_service" "api" {
  name            = "api"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.api.arn
  desired_count   = var.api_desired_count
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.app_subnet_ids
    security_groups = [aws_security_group.app.id]
  }
  load_balancer {
    target_group_arn = aws_lb_target_group.api.arn
    container_name   = "api"
    container_port   = 3001
  }
}

resource "aws_appautoscaling_target" "api" {
  max_capacity       = 10
  min_capacity       = var.api_desired_count
  resource_id        = "service/${aws_ecs_cluster.this.name}/${aws_ecs_service.api.name}"
  scalable_dimension = "ecs:service:DesiredCount"
  service_namespace  = "ecs"
}

resource "aws_appautoscaling_policy" "api_cpu" {
  name               = "${var.name}-api-cpu"
  policy_type        = "TargetTrackingScaling"
  resource_id        = aws_appautoscaling_target.api.resource_id
  scalable_dimension = aws_appautoscaling_target.api.scalable_dimension
  service_namespace  = aws_appautoscaling_target.api.service_namespace
  target_tracking_scaling_policy_configuration {
    predefined_metric_specification {
      predefined_metric_type = "ECSServiceAverageCPUUtilization"
    }
    target_value = 55
  }
}

resource "aws_ecs_task_definition" "worker" {
  family                   = "${var.name}-media-worker"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = 512
  memory                   = 1024
  execution_role_arn       = aws_iam_role.task_execution.arn
  task_role_arn            = aws_iam_role.api_task.arn
  container_definitions = jsonencode([{
    name        = "media-worker"
    image       = var.worker_image
    essential   = true
    environment = [{ name = "PICKLE_ENV", value = "production" }]
    secrets = [
      { name = "DATABASE_URL_WORKER", valueFrom = var.worker_db_url_secret_arn }
    ]
    logConfiguration = {
      logDriver = "awslogs"
      options = {
        awslogs-group         = "/ecs/${var.name}-media-worker"
        awslogs-region        = "us-west-2"
        awslogs-stream-prefix = "worker"
        awslogs-create-group  = "true"
      }
    }
  }])
}

resource "aws_ecs_service" "worker" {
  name            = "media-worker"
  cluster         = aws_ecs_cluster.this.id
  task_definition = aws_ecs_task_definition.worker.arn
  desired_count   = 1
  launch_type     = "FARGATE"
  network_configuration {
    subnets         = var.app_subnet_ids
    security_groups = [aws_security_group.app.id]
  }
}

output "alb_dns_name" { value = aws_lb.this.dns_name }
output "app_security_group_id" { value = aws_security_group.app.id }
output "cluster_name" { value = aws_ecs_cluster.this.name }
output "api_task_role_name" { value = aws_iam_role.api_task.name }
