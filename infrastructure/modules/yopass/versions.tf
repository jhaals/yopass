terraform {
  required_providers {
    aws = {
      source = "hashicorp/aws"
    }
    circleci = {
      source = "terraform-registry.deliveroo.net/deliveroo/circleci"
    }
    datadog = {
      source = "DataDog/datadog"
    }
    hopper = {
      source = "terraform-registry.deliveroo.net/deliveroo/hopper"
    }
    random = {
      source = "hashicorp/random"
    }
    sentry = {
      source = "terraform-registry.deliveroo.net/deliveroo/sentry"
    }
    roo = {
      source = "terraform-registry.deliveroo.net/deliveroo/roo"
    }
  }
}