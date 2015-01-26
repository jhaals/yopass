require 'memcached'
require 'sinatra/base'
require 'securerandom'
require 'encryptor'
require 'yaml'
require 'uri'
require 'yopass/sms_provider'
require 'sinatra/json'
require 'json'

class Yopass < Sinatra::Base
  helpers Sinatra::JSON

  configure :development do
    require 'sinatra/reloader'
    register Sinatra::Reloader
  end

  configure do
    config = ENV['YOPASS_CONFIG'] || 'yopass.yaml'
    cfg = YAML.load_file(config)
    set :config, cfg
    set :base_url, ENV['YOPASS_BASE_URL'] || cfg['base_url']
    set :public_folder, File.dirname(__FILE__) + '/public'
    set :mc, Memcached.new(ENV['YOPASS_MEMCACHED_URL'] || cfg['memcached_url'])
  end

  get '/v1/secret/:key/:password' do
    begin
      result = settings.mc.get params[:key]
    rescue Memcached::NotFound
      status 404
      return json message: 'Not found'
    end

    begin
      result = Encryptor.decrypt(value: result, key: params[:password])
    rescue OpenSSL::Cipher::CipherError
      settings.mc.delete(params[:key]) if too_many_tries?(params[:key])
      status 401
      return json message: 'Invalid decryption key'
    end
    settings.mc.delete params[:key]
    return json secret: result
  end

  post '/v1/secret' do
    begin
      r = JSON.parse(request.body.read)
    rescue JSON::ParserError
      status 400
      json message: 'Bad request, seek API docs at https://github.com/jhaals/yopass'
    end
    lifetime = r['lifetime']
    # calculate lifetime in secounds
    lifetime_options = { '1w' => 3600 * 24 * 7,
                         '1d' => 3600 * 24,
                         '1h' => 3600 }

    # Verify that user has posted a valid lifetime
    status 400
    # default lifetime
    lifetime = '1d' if lifetime.nil?
    secret = r['secret']
    return json message: 'Invalid lifetime' unless lifetime_options.include? lifetime
    return json message: 'No secret submitted' if secret.nil?
    return json message: 'No secret submitted' if secret.empty?

    if secret.length >= settings.config['secret_max_length']
      return json message: 'error: This site is meant to store secrets not novels'
    end

    # goes in URL
    key = SecureRandom.hex
    # decryption_key goes in URL or via SMS if provider is configured
    decryption_key = SecureRandom.hex[0..8]
    # encrypt secret with generated decryption_key
    data = Encryptor.encrypt(secret, key: decryption_key)

    # store secret in memcached
    begin
      settings.mc.set key, data, lifetime_options[lifetime]
    rescue Memcached::ServerIsMarkedDead
      status 500
      return json message: 'Error: Unable to contact memcached'
    end
    mobile_number = r['mobile_number']
    if settings.config['send_sms'] && !mobile_number.nil?
      unless mobile_number.empty?
        # strip everything except digits
        mobile_number = mobile_number.gsub(/[^0-9]/, '')
        # load SMS provider
        sms = SmsProvider.create(settings.config['sms::provider'],
                                 settings.config['sms::settings'])
        sms.send(mobile_number, decryption_key)
      end
    end
    status 200
    json key: key,
      decryption_key: decryption_key,
      full_url: URI.join(settings.base_url,
        "/v1/secret/#{key}/#{decryption_key}"),
      short_url: URI.join(settings.base_url, "/v1/secret/#{key}"),
      message: 'secret stored'
  end

  get '/' do
    # This is not a way of serving a static file
    File.read(File.join(settings.public_folder, 'index.html'))
  end

  run! if app_file == $PROGRAM_NAME
end

def too_many_tries?(key)
  key += key + '_ratelimit'
  begin
    result = settings.mc.get key
  rescue Memcached::NotFound
    settings.mc.set key, 1, 3600 * 24
    return false
  end
  settings.mc.set key, result + 1

  # This dude has tried to many times...
  true if result >= 2
end
