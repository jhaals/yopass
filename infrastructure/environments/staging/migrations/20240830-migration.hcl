mv {
  resources = {
    "module.yopass" : "module.yopass_staging.module.yopass"
    "module.yopass_redis" : "module.yopass_staging.module.yopass_redis"
    "module.yopass_web" : "module.yopass_staging.module.yopass_web"
    "module.yopass_web_identity" : "module.yopass_staging.module.yopass_web_identity"
    "hopper_variable.redis_url" : "module.yopass_staging.hopper_variable.redis_url"
  }
}