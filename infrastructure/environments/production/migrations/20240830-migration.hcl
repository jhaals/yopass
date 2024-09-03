mv {
  resources = {
    "module.yopass" : "module.yopass_prod.module.yopass"
    "module.yopass_redis" : "module.yopass_prod.module.yopass_redis"
    "module.yopass_web" : "module.yopass_prod.module.yopass_web"
    "module.yopass_web_identity" : "module.yopass_prod.module.yopass_web_identity"
    "hopper_variable.redis_url" : "module.yopass_prod.hopper_variable.redis_url"
  }
}