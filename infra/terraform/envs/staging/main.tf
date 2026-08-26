# Staging environment — composed from modules. Safe defaults; no production
# credentials required to review or plan this code (directive §49).

terraform {
  required_version = ">= 1.7"
  required_providers {
    aws    = { source = "hashicorp/aws", version = "~> 5.60" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
  # Remote state: configure per-account before first apply.
  # backend "s3" {
  #   bucket = "pickle-terraform-state-staging"
  #   key    = "staging/terraform.tfstate"
  #   region = "us-west-2"
  # }
}

provider "aws" {
  region = "us-west-2"
}

locals {
  name = "pickle-staging"
}

module "network" {
  source = "../../modules/network"
  name   = local.name
}

module "compute" {
  source            = "../../modules/compute"
  name              = local.name
  vpc_id            = module.network.vpc_id
  public_subnet_ids = module.network.public_subnet_ids
  app_subnet_ids    = module.network.app_subnet_ids
  api_image         = "REPLACED_BY_CI" # CI injects the signed ECR digest
  worker_image      = "REPLACED_BY_CI"
  api_desired_count = 1
}

module "data" {
  source                = "../../modules/data"
  name                  = local.name
  vpc_id                = module.network.vpc_id
  data_subnet_ids       = module.network.data_subnet_ids
  app_security_group_id = module.compute.app_security_group_id
  db_instance_class     = "db.t4g.small"
}

module "media" {
  source      = "../../modules/media"
  name        = local.name
  kms_key_arn = module.data.kms_key_arn
}

output "alb_dns_name" { value = module.compute.alb_dns_name }
output "media_bucket" { value = module.media.media_bucket }
output "jobs_queue_url" { value = module.media.jobs_queue_url }
