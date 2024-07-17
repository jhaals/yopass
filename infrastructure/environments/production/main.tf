locals {
  yopass_web_host = "passwords.deliveroo.net"

  owner_emails = {
    SECURITY_ENGINEERING = "security@deliveroo.co.uk"
  }
  rota_links = {
    SECURITY_ENGINEERING = "https://deliveroo.pagerduty.com/schedules#PLBV7XB"
  }
  slack_urls = {
    SECURITY_ENGINEERING = "https://deliveroo.slack.com/archives/CTY19E1DG"
  }
  supported_team_names = {
    SECURITY_ENGINEERING = "security-architecture-engineering"
  }
}

# Cryptonote replacement (SECENG-170)
module "yopass" {
  source  = "terraform-registry.deliveroo.net/deliveroo/roo_app_basic/aws"
  version = "~> 5.0"

  uses_feature_flags = "true"
  sentry_enabled     = "false"

  app_name  = "yopass"
  repo_name = "yopass"

  owner_email   = local.owner_emails["SECURITY_ENGINEERING"]
  rota_link     = local.rota_links["SECURITY_ENGINEERING"]
  slack_url     = local.slack_urls["SECURITY_ENGINEERING"]
  playbook_link = "https://github.com/deliveroo/yopass"
  description   = "Burn after reading password sharing. No logging and the server doesn't have the key"
  tier          = 4
  team_name     = local.supported_team_names["SECURITY_ENGINEERING"]
}

module "yopass_web" {
  source  = "terraform-registry.deliveroo.net/deliveroo/roo-service/aws"
  version = "~> 2.0"

  service_type = "public_web"

  application    = module.yopass.config
  service_name   = "web"
  container_port = 80

  health_check_codes       = "200"
  health_check_path        = "/"
  alb_anomaly_bounds       = 6
  alb_anomaly_should_alert = false
  health_check_interval    = 30
}

module "yopass_web_identity" {
  source  = "terraform-registry.deliveroo.net/deliveroo/identity_auth/aws"
  version = "~> 6.0"

  ecs_service_name = module.yopass_web.service_name
  env_name         = var.env_name
  extra_scopes     = ["employee", "engineer.contractor"]
  lb_listener_arn  = module.yopass_web.lb_listener_arn
  redirect_uris    = ["https://${local.yopass_web_host}/oauth2/idpresponse"]
  target_group_arn = module.yopass_web.target_group_arn
}

module "yopass_redis" {
  source  = "terraform-registry.deliveroo.net/deliveroo/redis/aws"
  version = "~> 9.0"

  application_name           = module.yopass.app_name
  replication_group_id       = "yopass-cache"
  use_as_store               = false
  at_rest_encryption         = false
  transit_encryption_enabled = false
  cluster_mode_enabled       = false
  multi_az_enabled           = false
  automatic_failover_enabled = true
  num_node_groups            = 1
  node_count                 = 1
  replicas                   = 1

  datadog_pagerduty_service = ""
  engine_version            = "7.1"
  parameter_group_family    = "redis7"
  instance_type             = "cache.t3.small"

  parameter_group_configuration = {
    "cluster-enabled"  = "no"
    "maxmemory-policy" = "allkeys-lru"
  }
}

resource "hopper_variable" "redis_url" {
  app_name   = module.yopass.app_name
  name       = "REDIS_CACHE_URL"
  value      = module.yopass_redis.url
  write_only = true
}