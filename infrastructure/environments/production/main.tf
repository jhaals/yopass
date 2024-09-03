module "yopass_prod" {
  source = "../../modules/yopass"

  env_name        = var.env_name
  datadog_api_key = var.datadog_api_key
  datadog_app_key = var.datadog_app_key
  region          = var.region
  shard           = var.shard
  redirect_uri    = "passwords.deliveroo.net"
}