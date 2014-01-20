require 'memcached'
require 'sinatra/base'
require 'securerandom'
require 'encryptor'
require 'yaml'
require 'uri'

# TODO SMS SETUP

class Yopass < Sinatra::Base
  configure :development do
    require 'sinatra/reloader'
    register Sinatra::Reloader
    set :config, YAML.load_file('conf/yopass.yaml')
  end
  configure do
    set :cache, Memcached.new(settings.config['memcached_url'])
    set :public_folder, File.dirname(__FILE__) + '/static'
  end

  # Index
  get '/' do
    erb :index
  end

  post '/' do
    headers 'Cache-Control' => 'no-cache, no-store, must-revalidate'
    headers 'Pragma' => 'no-cache'
    headers 'Expires' => '0'

    lifetime = params[:lifetime]
    # calculate lifetime in secounds
    lifetime_options = { '1w' => 3600*24*7,
                         '1d' => 3600*24,
                         '1h' => 3600,
    }
    # Verify that user has posted a valid lifetime
    return 'Invalid lifetime' unless lifetime_options.include? lifetime
    return 'No secret submitted' if params[:secret].empty?
    return 'This site is meant to store secrets not novels' if params[:secret].length >= 10000

    # goes in URL
    key = SecureRandom.urlsafe_base64 8
    # password goes in URL or via SMS if provider is configured
    password = SecureRandom.urlsafe_base64 8
    # encrypt secret with generated password
    data = Encryptor.encrypt(params[:secret], :key => password)
    # store secret in memcached
    settings.cache.set key, data, lifetime_options[lifetime]
    return erb :secret_url, :locals => {:url => URI.join(settings.config['http_base_url'], "get?k=#{key}&p=#{password}")}
  end

  get '/get' do
    # No password added
    return erb :get_secret, :locals => {:key => params[:k]} if params[:p].nil? or params[:p].empty?

    # Disable all caching
    headers 'Cache-Control' => 'no-cache, no-store, must-revalidate'
    headers 'Pragma' => 'no-cache'
    headers 'Expires' => '0'
    begin
    result = settings.cache.get params[:k]
    rescue Memcached::NotFound
      return erb :'404'
    end
    content_type 'text/plain'

    begin
    result = Encryptor.decrypt(:value => result, :key => params[:p])
    rescue OpenSSL::Cipher::CipherError
      return 'Invalid decryption key'
    end
    settings.cache.delete params[:k]
    result
  end

  run! if app_file == $0
end
