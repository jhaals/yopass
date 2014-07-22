# -*- encoding: utf-8 -*-
Gem::Specification.new do |s|
  # Metadata
  s.name        = 'yopass'
  s.version     = '2.0.0'
  s.author      = 'Johan Haals'
  s.email       = ['jhaals@spotify.com']
  s.homepage    = 'https://github.com/jhaals/yopass'
  s.summary     = 'Secure sharing for secrets and passwords'
  s.description = 'Web service for sharing secrets more securely'
  s.license     = 'Apache 2.0'

  # Manifest
  s.files         = `git ls-files`.split("\n")
  s.test_files    = `git ls-files -- {test,spec,features}/*_spec.rb`.split("\n")
  s.require_paths = ['lib', 'conf']

  # Dependencies
  s.required_ruby_version = '>= 1.8.7'
  s.add_runtime_dependency 'encryptor', '~> 1.3.0'
  s.add_runtime_dependency 'memcached' , '~> 1.7.2'
  s.add_runtime_dependency 'sinatra', '~> 1.4.4'
end

