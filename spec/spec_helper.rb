require File.join(File.dirname(__FILE__), '../lib/yopass.rb')

require 'sinatra'
require 'rack/test'

set :run, false
set :raise_errors, true
set :logging, true

def app
    Yopass
end

RSpec.configure do |config|
    config.include Rack::Test::Methods
end
