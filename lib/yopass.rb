require 'memcached'
require 'sinatra/base'
require 'securerandom'
require 'encryptor'

# TODO yaml settings
# TODO URL view
# TODO SMS SETUP

class Yopass < Sinatra::Base
  configure :development do
    require 'sinatra/reloader'
    register Sinatra::Reloader
  end
  configure do
    set :cache, Memcached.new('localhost:11211')
    set :public_folder, File.dirname(__FILE__) + '/static'
  end

  # Index
  get '/' do
    erb :index
  end

  post '/' do
    lifetime = params[:valid]
    lifetime_options = { '1w' => 3600*24*7,
                         '1d' => 3600*24,
                         '1h' => 3600,
    }
    # Verify that user has posted a valid lifetime
    return 'Invalid lifetime' unless lifetime_options.include? lifetime
    return 'No secret submitted' if params[:secret].empty?

    # goes in URL
    key = SecureRandom.urlsafe_base64 8
    # password goes in URL or via SMS if provider is configured
    password = SecureRandom.urlsafe_base64 8
    # encrypt secret with generated password
    data = Encryptor.encrypt(params[:secret], :key => password)
    # store secret in memcached
    settings.cache.set key, data, lifetime_options[lifetime]
    "http://127.0.0.1:4567/get?k=#{key}&p=#{password}"
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
      return 'Invalid password'
    end
    settings.cache.delete params[:k]
    result
  end

  run! if app_file == $0
end
