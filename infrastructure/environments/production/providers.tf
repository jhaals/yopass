provider "aws" {
  region = var.region

  default_tags {
    tags = data.roo_tags.defaults.aws_tags
  }

  assume_role {
    role_arn     = data.roo_aws_account.current.terraform_deploy_role_arn
    session_name = "geopoiesis"
  }
}

provider "datadog" {
  api_key = var.datadog_api_key
  app_key = var.datadog_app_key

  http_client_retry_backoff_base       = 10
  http_client_retry_backoff_multiplier = 2
  http_client_retry_max_retries        = 5
  http_client_retry_timeout            = 180 # seconds
}

provider "roo" {
  default_ownership_group = "security-engineering"

  default_env_name   = var.env_name
  default_shard_name = var.shard
}