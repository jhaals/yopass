# -*- encoding: utf-8 -*-
Gem::Specification.new do |s|
  s.name        = 'yopass'
  s.version     = '3.0.1'
  s.author      = 'Johan Haals'
  s.email       = 'johan@haals.se'
  s.homepage    = 'https://github.com/jhaals/yopass'
  s.summary     = 'Secure sharing for secrets and passwords'
  s.description = 'Web service for sharing secrets more securely'
  s.license     = 'Apache 2.0'

  # Manifest
  s.files         = `git ls-files`.split("\n")
  s.test_files    = `git ls-files -- {test,spec,features}/*_spec.rb`.split("\n")
  s.require_paths = ['lib']

  # Dependencies
  s.required_ruby_version = '>= 1.9.3'
  s.add_runtime_dependency 'encryptor', '~> 1.3'
  s.add_runtime_dependency 'memcached', '~> 1.8'
  s.add_runtime_dependency 'rack', ['>= 1.5.0', '< 1.6']
  s.add_runtime_dependency 'sinatra', '~> 1.4'
  s.add_runtime_dependency 'sinatra-contrib', '~> 1.4'

  s.add_development_dependency 'rake', '~> 10.4'
  s.add_development_dependency 'rspec', '~> 3.0'
end

