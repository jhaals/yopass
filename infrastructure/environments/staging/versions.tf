terraform {
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
    circleci = {
      source = "terraform-registry.deliveroo.net/deliveroo/circleci"
    }
    datadog = {
      source = "DataDog/datadog"
    }
    hopper = {
      source  = "terraform-registry.deliveroo.net/deliveroo/hopper"
      version = "~> 1.0"
    }
    random = {
      source = "hashicorp/random"
    }
    sentry = {
      source  = "terraform-registry.deliveroo.net/deliveroo/sentry"
      version = "~> 1.0"
    }
    roo = {
      source  = "terraform-registry.deliveroo.net/deliveroo/roo"
      version = "~> 1.0"
    }
  }
}