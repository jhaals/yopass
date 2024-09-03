variable "env_name" {}
variable "redirect_uri" {}
variable "shard" {}
variable "region" {}
variable "datadog_api_key" {}
variable "datadog_app_key" {}

data "roo_aws_account" "current" {
  shard = "global"
}

data "roo_tags" "defaults" {}